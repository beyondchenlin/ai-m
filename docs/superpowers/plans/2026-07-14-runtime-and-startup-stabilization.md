# Runtime and Startup Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Node/pnpm selection deterministic, preserve the safe Worker startup behavior, and make legacy migration-journal recovery testable before merging the startup fixes into `dev`.

**Architecture:** Keep environment validation dependency-free and executable before native modules load. Move migration-journal decisions into pure functions, leaving SQLite I/O in `src/lib/db/index.ts`, so recovery rules can be exhaustively tested without mutating a real database. Use Node 22.16.0 and Corepack-managed pnpm 10.12.1 for every verification command.

**Tech Stack:** Node.js 22.16.0, pnpm 10.12.1 via Corepack, TypeScript, Vitest, Next.js 16, Drizzle ORM, better-sqlite3.

---

### Task 1: Detect split Node/pnpm runtimes before native modules load

**Files:**
- Create: `scripts/runtime-preflight.mjs`
- Create: `scripts/__tests__/runtime-preflight.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing dependency-free tests**

Test pure validation with Node's built-in test runner. Cover the pinned version, a wrong active Node version, a pnpm launcher whose `npm_node_execpath` reports Node 24, an unreadable launcher, and a matching Node 22 launcher. The public result must contain a stable `ok` boolean and actionable diagnostics.

```js
import test from "node:test";
import assert from "node:assert/strict";
import { validateRuntime } from "../runtime-preflight.mjs";

test("rejects a pnpm launcher from a different Node major", () => {
  const result = validateRuntime({
    pinnedVersion: "22.16.0",
    activeVersion: "22.16.0",
    packageManagerVersion: "10.12.1",
    launcherVersion: "24.12.0",
  });
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join("\n"), /pnpm.*Node 24/i);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test scripts/__tests__/runtime-preflight.test.mjs`

Expected: FAIL because `runtime-preflight.mjs` does not exist.

- [ ] **Step 3: Implement the runtime preflight**

Read `.node-version`, compare the exact active version, verify pnpm 10.12.1 from `npm_config_user_agent`, and when `npm_node_execpath` is present execute it with `-p process.version` to detect stale fnm shims. Do not import project dependencies. On failure, print the active executable, launcher executable, expected versions, and the recovery command `corepack pnpm install --frozen-lockfile`, then exit non-zero.

```js
export function validateRuntime({ pinnedVersion, activeVersion, packageManagerVersion, launcherVersion }) {
  const diagnostics = [];
  if (activeVersion !== pinnedVersion) diagnostics.push(`Active Node ${activeVersion} does not match ${pinnedVersion}`);
  if (launcherVersion && launcherVersion.split(".")[0] !== pinnedVersion.split(".")[0]) {
    diagnostics.push(`pnpm is running under Node ${launcherVersion}, expected Node ${pinnedVersion}`);
  }
  if (packageManagerVersion !== "10.12.1") diagnostics.push(`pnpm ${packageManagerVersion || "unknown"} does not match 10.12.1`);
  return { ok: diagnostics.length === 0, diagnostics };
}
```

- [ ] **Step 4: Wire the guard into developer and quality entry points**

Add `preflight:runtime` plus lifecycle guards for `dev`, `worker:dev`, `test`, `build`, `typecheck`, `quality:static`, and `quality`. Narrow `engines.node` to `>=22.16.0 <23`. Preserve `packageManager: pnpm@10.12.1` and the direct `tsx` dependency.

- [ ] **Step 5: Verify both failure and success paths**

Run under the stale shim: `pnpm preflight:runtime`

Expected: FAIL with a split-runtime diagnostic, before loading `better-sqlite3`.

Run under the pinned launcher: `corepack pnpm preflight:runtime`

Expected: PASS and report Node 22.16.0 / pnpm 10.12.1.

- [ ] **Step 6: Commit**

```powershell
git add package.json pnpm-lock.yaml scripts/runtime-preflight.mjs scripts/__tests__/runtime-preflight.test.mjs
git commit -m "build: enforce a single Node runtime"
```

### Task 1.5: Align the static architecture gate with the runtime source of truth

**Files:**
- Modify: `tools/pr12_static_checks.py`

- [ ] **Step 1: Reproduce the stale assertion**

Run: `corepack pnpm test:pr12-static`

Expected before the fix: FAIL because the checker requires `>=22.12.0 <25` while the reviewed runtime contract requires `>=22.16.0 <23`.

- [ ] **Step 2: Derive the expected engine range from `.node-version`**

Read the exact pinned version, parse and validate its numeric major, and require `package.json.engines.node` to equal `>=<pinned-version> <<next-major>`. Keep the exact pnpm package-manager assertion. Reject malformed or missing version files with a clear static-check failure instead of embedding a second Node version constant.

- [ ] **Step 3: Verify the aligned gate**

Run:

```powershell
corepack pnpm test:pr12-static
corepack pnpm test:runtime
```

Expected: both commands pass; changing a temporary in-memory/package fixture is unnecessary because the runtime consistency suite already covers drift among `.node-version`, `packageManager`, `engines`, and the preflight pin.

- [ ] **Step 4: Commit**

```powershell
git add tools/pr12_static_checks.py
git commit -m "test: align runtime architecture gate"
```

### Task 2: Make migration-journal validation explicit and testable

**Files:**
- Create: `src/lib/db/migration-journal.ts`
- Create: `src/lib/db/__tests__/migration-journal.test.ts`
- Modify: `src/lib/db/index.ts`

- [ ] **Step 1: Write failing unit tests for journal invariants**

Cover valid out-of-order rows, unknown timestamps, mismatched hashes, duplicate recorded timestamps, duplicate available migration timestamps, and a journal ahead of the application build.

```ts
expect(() => validateMigrationJournal(
  [{ hash: "b", createdAt: 200 }, { hash: "a", createdAt: 100 }],
  [{ hash: "a", folderMillis: 100 }, { hash: "b", folderMillis: 200 }],
)).not.toThrow();
```

- [ ] **Step 2: Write failing tests for the legacy 0056 repair decision**

The repair may be selected only when all of these are true: no 0056 journal row, exactly 56 recorded rows, latest timestamp equals 0055, both visual-subject tables exist, all three required columns exist, and the exact 0056 migration metadata is available. Test every condition independently plus the success case.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `corepack pnpm vitest run src/lib/db/__tests__/migration-journal.test.ts`

Expected: FAIL because the pure journal module does not exist.

- [ ] **Step 4: Implement pure journal policy functions**

Create `validateMigrationJournal(rows, migrations)` and `selectLegacyVisualSubjectJournalRepair(snapshot, migrations)`. Reject duplicates and unknown entries. Match recorded rows by immutable migration timestamp rather than database insertion order. Keep the legacy timestamp constants named and documented in this module.

- [ ] **Step 5: Refactor SQLite I/O to call the policy module**

`src/lib/db/index.ts` must query rows/schema facts, call the pure policy, and perform at most one exact journal insert. Keep the insert atomic. Rename the misleading prefix validator to journal validation. Do not generalize schema guessing or repair arbitrary hash drift.

- [ ] **Step 6: Verify focused and migration suites**

Run:

```powershell
corepack pnpm vitest run src/lib/db/__tests__/migration-journal.test.ts
corepack pnpm test:migrations
```

Expected: all focused tests pass; empty DB applies 60 migrations; legacy 0053 and 0058 upgrades pass.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/db/index.ts src/lib/db/migration-journal.ts src/lib/db/__tests__/migration-journal.test.ts
git commit -m "fix(db): verify legacy migration journal recovery"
```

### Task 3: Verify Worker environment loading and startup contract

**Files:**
- Modify: `src/worker/__tests__/index.test.ts`
- Modify: `package.json` only if the test exposes a contract gap

- [ ] **Step 1: Add a failing contract test**

Assert that the repository's `worker:dev` command uses the declared direct `tsx` binary and loads `.env` before `src/worker/index.ts`. Assert that `tsx` remains a direct development dependency, not a transitive executable.

- [ ] **Step 2: Run the focused test and verify the failure reason**

Run: `corepack pnpm vitest run src/worker/__tests__/index.test.ts`

Expected before preserving the transferred startup fix: the command lacks `.env` loading or `tsx` is undeclared. With the transferred fix present, temporarily validate the test against `HEAD` or show that it prevents regression.

- [ ] **Step 3: Preserve the source-level startup contract**

Keep `worker:dev` as `tsx --env-file=.env src/worker/index.ts`; do not add application-side dotenv loading. This keeps configuration ownership at the process boundary and leaves production `worker` unchanged.

- [ ] **Step 4: Verify Worker build and live boot**

Run:

```powershell
corepack pnpm worker:build
corepack pnpm worker:dev
```

Expected: build succeeds; with durable flags in `.env`, Worker reaches `Platform schema ready, polling for jobs` without claiming that model inference succeeded.

- [ ] **Step 5: Commit**

```powershell
git add package.json pnpm-lock.yaml src/worker/__tests__/index.test.ts
git commit -m "fix(worker): load development environment explicitly"
```

### Task 4: Run the full release gate and record evidence

**Files:**
- Create: `docs/superpowers/plans/2026-07-14-runtime-and-startup-stabilization-results.md`

- [ ] **Step 1: Run the complete deterministic gate**

```powershell
corepack pnpm quality:static
corepack pnpm worker:build
corepack pnpm build
```

Expected: every command exits 0. Record ESLint warnings separately; warnings are not silently called clean and become an explicit later maintenance task.

- [ ] **Step 2: Verify the application and Worker together**

Start Web and Worker with the pinned runtime. Verify `GET http://127.0.0.1:3000/zh` returns 200 and Worker reaches its polling state. Capture log paths, process IDs, Node versions, and ABI values.

- [ ] **Step 3: Verify Git scope**

Run `git diff dev...HEAD --stat`, `git status --short`, and a secret/path scan. Confirm ZIP files, `.env`, runtime logs, database files, backups, and absolute machine paths are absent from the commit set.

- [ ] **Step 4: Write the results report and commit**

The report must list exact commands, pass/fail counts, known warnings, live startup result, and any external model checks not yet performed.

```powershell
git add docs/superpowers/plans/2026-07-14-runtime-and-startup-stabilization-results.md
git commit -m "docs: record startup stabilization evidence"
```

### Task 5: Two-stage review and safe integration

**Files:**
- Review all files in `git diff dev...HEAD`

- [ ] **Step 1: Run specification compliance review**

Confirm every requirement in Tasks 1–4 is implemented, no requirement is inferred from file presence alone, and no unrelated product behavior changed.

- [ ] **Step 2: Run adversarial code-quality review**

Challenge unsafe migration repair, hidden lifecycle side effects, platform-specific runtime assumptions, compatibility with direct `node`/Corepack invocation, test gaps, secret leakage, and future maintenance cost. Fix every confirmed issue and rerun both reviews.

- [ ] **Step 3: Rebase or merge the latest remote `dev` and rerun the gate**

Fetch `origin/dev`, reconcile without destructive reset, then rerun the commands from Task 4.

- [ ] **Step 4: Merge into local `dev` and push remote `dev`**

Only after the final gate is green, merge the reviewed branch into local `dev`, verify local and remote commit pointers, push `dev`, and keep a rollback reference.
