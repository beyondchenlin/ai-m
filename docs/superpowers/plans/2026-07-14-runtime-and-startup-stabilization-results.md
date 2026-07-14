# Runtime and startup stabilization results

Date: 2026-07-14 18:46-18:58 +08:00
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

`worker:build` evidence:

- Runtime preflight passed.
- esbuild produced `dist/worker/index.cjs` for Node 22 in CommonJS format.
- Reported bundle size was 1.4 MB and the build completed in 62 ms.

`build` evidence:

- Runtime preflight passed.
- Next.js production compilation completed successfully in 10.8 seconds.
- TypeScript and page-data collection completed.
- Static page generation completed 16/16 pages in 183.8 ms.
- The production route manifest included the localized application routes and API routes.

## Isolated production live check

Port 3100 was checked before startup and was not listening. Port 3000 was not used. All mutable state was isolated under `${TEMP}/ai-m-release-live-<unique>/`:

- SQLite database: `${TEMP}/ai-m-release-live-<unique>/release.db`
- uploads: `${TEMP}/ai-m-release-live-<unique>/uploads`
- shared inputs: `${TEMP}/ai-m-release-live-<unique>/shared-inputs`
- Web and Worker logs: files under the same temporary root

The database was migrated before startup. The production processes received only process-level test configuration. This included a single-user test identity, random strong admin/master values that were never printed or persisted, an HTTPS placeholder public origin, the localhost test origin, the durable-worker flag, and the explicit `${REPO}/drizzle` directory plus its computed manifest digest. The explicit migration directory contract is required because bundled Next.js code cannot derive the repository migration folder from its compiled `__dirname`.

Commands, with environment-specific values represented by placeholders:

```text
corepack pnpm tsx -e "import { runMigrations } from './src/lib/db/index.ts'; runMigrations();"
corepack pnpm start --hostname 127.0.0.1 --port 3100
corepack pnpm worker
```

Web and Worker were started concurrently. Evidence from the successful run:

- Web root PID: `42076`; observed process tree: `42076,43440,51164,30392,49484`
- Worker root PID: `21336`; observed process tree: `21336,49408,46136,49328,3188`
- Web readiness was observed from the Next.js production startup log.
- Worker readiness was observed as `Platform schema ready, polling for jobs`.
- `GET http://127.0.0.1:3100/zh` returned HTTP 200.
- Response length was 40,159 characters.
- The response contained `lang="zh"` and an application marker.

The bounded shutdown terminated both complete process trees. Post-shutdown checks reported:

- orphan processes: 0
- listeners remaining on port 3100: 0
- SQLite WAL and SHM files were still present after forced tree termination, then were removed with the complete temporary root
- temporary live root remaining: 0

Two harness configuration failures were diagnosed before the successful run and are not counted as successful evidence: an extra pnpm `--` made Next interpret `--hostname` as a project directory; then production bootstrap rejected missing identity/admin/HTTPS-origin configuration and the bundled server could not find migrations without the explicit migration directory and digest. These were test-command deployment-contract omissions, not product-code changes. Every failed attempt ran bounded cleanup; no listener or live process remained.

## Build and temporary cleanup

- `dist/` and `.next/` contained no tracked files.
- `dist/` was removed after the live check.
- `.next/standalone` exceeded legacy PowerShell path handling during the first removal attempt; after revalidating that the target was untracked and inside `${REPO}`, the .NET long-path API removed it.
- Final `.next/` count: 0.
- Final `dist/` count: 0.
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

Before adding this report, `dev...HEAD` contained 23 commits and 25 changed files, with 4,597 insertions and 265 deletions. The worktree was clean, and `git diff --check` passed.

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

No user main-worktree untracked file was read, modified, or removed by the cleanup; all cleanup targets were first resolved and constrained to this worktree or the unique temporary root.

## Deferred external acceptance

This phase did not start ComfyUI, contact an external model provider, run image/video inference, or synthesize TTS audio. The Web/Worker/database startup loop is accepted here; external ComfyUI, model execution, and real TTS remain explicitly deferred to a later environment-backed acceptance phase.
