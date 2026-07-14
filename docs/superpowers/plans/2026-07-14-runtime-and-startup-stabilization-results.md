# Runtime and startup stabilization results

Date: 2026-07-14 18:46-19:23 +08:00
Evidence commit before this report: `1eef98c`
Platform: Windows x64

## Runtime identity

- Node: `v22.16.0`
- Node executable: `${FNM_MULTISHELL}/node.exe` (the active executable used by all commands below)
- Node modules ABI: `127`
- pnpm: `10.12.1` through Corepack
- Next.js: `16.1.6`

No environment-file contents, credential values, migration digest, or machine-specific absolute path are recorded here.

## Release gates

The release gates were run fresh, in this order:

```text
corepack pnpm quality:static
corepack pnpm worker:build
corepack pnpm build
```

All three commands exited `0`.

`quality:static` evidence:

- Runtime preflight and TypeScript typecheck passed.
- Vitest passed 30 test files and 274 tests.
- Runtime preflight suite passed 21/21 tests.
- Documentation/example validation passed.
- Migration checks passed: empty database 60 migrations, legacy 0053 upgrade 6 platform migrations, and legacy 0058 upgrade 1 review2 migration.
- PR-12 static architecture checks passed, including 8 checker unit tests.
- PR-13 static architecture checks passed, including 3 checker unit tests.
- ESLint reported 0 errors and 105 existing warnings. This is a passing gate, but it is not described as lint-clean.

Known, repeatable passing-gate output was reviewed rather than silently omitted:

- Vitest prints: `The plugin "vite-tsconfig-paths" is detected. Vite now supports tsconfig paths resolution natively via the resolve.tsconfigPaths option. You can remove the plugin and set resolve.tsconfigPaths: true in your Vite config instead.` This is a stable dependency deprecation notice.
- The Windows ACL negative test intentionally prints `Backup file DACL is not current-SID-only FullControl with inheritance removed` and its PowerShell `OperationStopped`/`RuntimeException` context to stderr. The assertion expects that fail-closed rejection; the focused suite still exited `0` with 8/8 tests passing.
- ESLint's 105 warnings are pre-existing warnings; there were 0 errors and the aggregate static gate exited `0`.

`worker:build` evidence:

- Runtime preflight passed.
- esbuild produced `dist/worker/index.cjs` for Node 22 in CommonJS format.
- Reported bundle size was 1.4 MB. The initial gate completed in 62 ms; the fresh rebuild used for the port-3000 acceptance completed in 66 ms.

`build` evidence:

- Runtime preflight passed.
- Next.js production compilation completed successfully in 10.8 seconds. The fresh rebuild used for the port-3000 acceptance compiled in 7.4 seconds.
- TypeScript and page-data collection completed.
- Static page generation completed 16/16 pages in 183.8 ms; the acceptance rebuild completed 16/16 in 147.3 ms.
- The production route manifest included the localized application routes and API routes.

## Isolated production live check

The existing main-worktree Web listener was first identified as the seven-process tree rooted at PID `43492`; its only listener was PID `21100` on port 3000. A baseline `GET http://127.0.0.1:3000/zh` returned HTTP 200. The separate main-worktree Worker was identified before the stop and was not stopped. The Web tree alone was then boundedly stopped so the required production acceptance could use port 3000.

All acceptance mutable state was isolated under `${TEMP}/ai-m-release-live-<unique>/`:

- SQLite database: `${TEMP}/ai-m-release-live-<unique>/release.db`
- uploads: `${TEMP}/ai-m-release-live-<unique>/uploads`
- shared inputs: `${TEMP}/ai-m-release-live-<unique>/shared-inputs`
- Web stdout: `${TEMP}/ai-m-release-live-<unique>/web.out.log`
- Web stderr: `${TEMP}/ai-m-release-live-<unique>/web.err.log`
- Worker stdout: `${TEMP}/ai-m-release-live-<unique>/worker.out.log`
- Worker stderr: `${TEMP}/ai-m-release-live-<unique>/worker.err.log`

The database was migrated before startup. The production processes received only process-level test configuration. This included a single-user test identity, random strong admin/master values that were never printed or persisted, an HTTPS placeholder public origin, the localhost test origin, the durable-worker flag, and the explicit `${REPO}/drizzle` directory plus its computed manifest digest. The explicit migration directory contract is required because bundled Next.js code cannot derive the repository migration folder from its compiled `__dirname`.

Commands, with environment-specific values represented by placeholders:

```text
corepack pnpm tsx -e "import { runMigrations } from './src/lib/db/index.ts'; runMigrations();"
corepack pnpm start --hostname 127.0.0.1 --port 3000
corepack pnpm worker
```

Web and Worker were started concurrently. Evidence from the successful run:

- Web root PID: `46316`; observed process tree: `46316,18204,812,29332,32048`
- Worker root PID: `46576`; observed process tree: `46576,25740,41308,9036,51756`
- Web readiness was observed from the Next.js production startup log.
- Worker readiness was observed as `Platform schema ready, polling for jobs`.
- `GET http://127.0.0.1:3000/zh` returned HTTP 200.
- Response length was 40,159 characters.
- The response contained `lang="zh"` and an application marker.

The bounded shutdown terminated both complete process trees. Post-shutdown checks reported:

- orphan processes: 0
- listeners remaining on port 3000: 0
- SQLite WAL and SHM files were still present after forced tree termination, then were removed with the complete temporary root
- temporary live root remaining: 0

Two harness configuration failures were diagnosed before the successful run and are not counted as successful evidence: an extra pnpm `--` made Next interpret `--hostname` as a project directory; then production bootstrap rejected missing identity/admin/HTTPS-origin configuration and the bundled server could not find migrations without the explicit migration directory and digest. These were test-command deployment-contract omissions, not product-code changes. Every failed attempt ran bounded cleanup; no listener or live process remained.

## Main UI restoration after acceptance

The old main-worktree Web process could not be recreated from its current checkout after the production process released port 3000. Its startup reached migrations and then failed with `Migration journal drift at index 0; refusing to guess schema state`. Read-only diagnosis established that the live database was not drifted: all 60 journal rows matched all 60 current migration `(hash, created_at)` pairs exactly when read in insertion (`rowid`) order. Sorting by `created_at, rowid` instead produced the permutation `52,53,1,0,2...51,54...59`, because migrations 0052 and 0053 have earlier timestamps; the old validator therefore rejected a valid journal. No journal row was inserted, updated, deleted, or reordered.

To restore the user interface without changing the real database or the main worktree, the main `.env` was copied temporarily to this reviewed worktree. The copy is ignored, untracked, absent from `git status`, content-identical, and protected with the same effective ACL rules; its contents and digest were never printed. Relative database configuration was resolved back to the main repository only in the child process environment. The reviewed worktree migration directory and its freshly computed manifest digest were also supplied only in that process environment.

The reviewed HEAD now provides the temporary port-3000 UI:

- Listener PID: `51988`; its command line resolves to this reviewed worktree.
- The startup log contains `[Bootstrap] Ready.`.
- `GET http://127.0.0.1:3000/zh` returned HTTP 200, contained `lang="zh"`, and had response length 92,920 characters.
- The original main Worker PIDs `51216` and `46564` remained alive throughout.
- A post-start read-only check again found 60 journal rows matching 60 migrations exactly in `rowid` order.
- Exact retained logs: `${TEMP}/ai-m-task4-reviewed-ui-53c4439cb39e4ce88d612e37a3f54164/web.stdout.log` and `${TEMP}/ai-m-task4-reviewed-ui-53c4439cb39e4ce88d612e37a3f54164/web.stderr.log`.

This temporary Web process and ignored `.env` must remain until Task 5 merges the reviewed code into the main checkout and switches port 3000 back to the main worktree. The ignored `.env` must then be removed immediately.

## Build and temporary cleanup

- `dist/` and `.next/` contained no tracked files.
- The first successful isolated-live-check `dist/` and `.next/` outputs were removed after that run.
- `.next/standalone` exceeded legacy PowerShell path handling during the first removal attempt; after revalidating that the target was untracked and inside `${REPO}`, the .NET long-path API removed it.
- Fresh `dist/` and `.next/` outputs were then built for the required port-3000 production acceptance. The production process, isolated data root, and `dist/` were removed; `.next/` remains in use by the temporary reviewed-worktree development UI.
- Final `${TEMP}/ai-m-release-live-*` directory count: 0.

## Git scope and sensitive-artifact scan

Commands:

```text
git diff dev...HEAD --stat
git diff dev...HEAD --name-status
git status --short
git diff --check
git rev-list --count dev..HEAD
```

Before this correction, `dev...HEAD` contained 24 commits and 26 changed files, with 4,734 insertions and 265 deletions. The tracked worktree was clean, and `git diff --check` passed.

Only committed paths in `dev...HEAD` were scanned. Counts were reported by category without printing candidate secret values:

| Category | Count |
| --- | ---: |
| Archives (`zip`, `7z`, `rar`, `tar`, `tgz`, `gz`) | 0 |
| Environment files | 0 |
| Log files | 0 |
| Database, SQLite, WAL, or SHM files | 0 |
| Backup artifacts | 0 |
| `node_modules` paths | 0 |
| `.next` paths | 0 |
| `dist` paths | 0 |
| Private-key files | 0 |
| Binary files | 0 |
| Machine-specific absolute paths in added content | 0 |
| Private-key content markers | 0 |
| Common credential-value patterns | 0 |

The three pre-existing main-worktree untracked paths remained present and `git status --short` stayed byte-for-byte identical across the port-3000 stop/acceptance attempt. The authorized restoration diagnosis read only the main `.env` and `.codex-runtime` startup logs; it did not print their contents except for sanitized startup-state lines, and did not read the unrelated untracked archives. Cleanup targets were first resolved and constrained to this worktree or the unique temporary root.

## Deferred external acceptance

This phase did not start ComfyUI, contact an external model provider, run image/video inference, or synthesize TTS audio. The Web/Worker/database startup loop is accepted here; external ComfyUI, model execution, and real TTS remain explicitly deferred to a later environment-backed acceptance phase.
