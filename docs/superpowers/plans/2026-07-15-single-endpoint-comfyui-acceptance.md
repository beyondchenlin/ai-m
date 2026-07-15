# Single-Endpoint Managed ComfyUI Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run image, video, IndexTTS2, and OmniVoice workflows through one managed `http://127.0.0.1:8000` ComfyUI process, serially, and fully restart plus reconnect only after every job's outputs have been durably archived.

**Architecture:** The worker owns one optional managed-runtime controller configured only from startup environment, never from request or database content. Existing resource-pool capacity remains the cross-process serialization authority; the managed controller validates that the selected backend is the configured loopback endpoint, closes transport connections after job settlement, calls Pixelle's ownership-safe stop/start scripts, waits for a fresh health/identity probe, and only then allows the worker loop to claim another job. A retained/uncertain job may reset the process but must pause automatic claiming rather than treating restart as proof of external termination.

**Tech Stack:** Node.js 22, TypeScript, Vitest, PowerShell, SQLite/Drizzle, ComfyUI HTTP/WebSocket API, Pixelle managed backend scripts.

---

## Release invariants

- One configured backend URL: exactly `http://127.0.0.1:8000` (canonical loopback aliases normalize to this authority).
- One shared resource pool with capacity `1`; image, video, and speech profiles use the same backend and pool.
- A restart is never initiated while an output response is still streaming or an artifact is `STAGING`.
- Before stop: the per-job transport is closed and the connection registry has no lease for the completed job.
- After start: both `/system_stats` and `/object_info` must succeed using a newly created transport and connection lifetime before another claim.
- A failed restart stops job polling. It never falls through and submits the next job to an unknown backend generation.
- `submission-uncertain`, `NEEDS_ATTENTION`, or ownership loss never becomes terminal merely because a process restart was attempted.
- Commands, stdout, stderr, and logs are bounded; no database/request value can select an executable or script path.

### Task 1: Add a bounded managed-runtime controller

**Files:**
- Create: `src/lib/generation/runtime/managed-comfyui-runtime.ts`
- Create: `src/lib/generation/runtime/__tests__/managed-comfyui-runtime.test.ts`
- Modify: `src/lib/generation/index.ts`

- [x] Write failing tests for strict environment parsing: disabled by default; enabled mode requires the Pixelle repository root, canonical loopback `8000`, existing fixed `scripts/comfyui/start_backend.ps1` and `stop_backend.ps1`, positive bounded command/ready timeouts, and rejects request/database-selected command paths.
- [x] Run `corepack pnpm vitest run src/lib/generation/runtime/__tests__/managed-comfyui-runtime.test.ts` and confirm failures are caused by the missing controller.
- [x] Implement `parseManagedComfyUIRuntimeConfig(env)` returning the discriminated union below and export it through `src/lib/generation/index.ts`:

```ts
type ManagedRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      baseUrl: "http://127.0.0.1:8000";
      pixelleRoot: string;
      dataRoot: string;
      pythonExe: string;
      commandTimeoutMs: number;
      readyTimeoutMs: number;
    };
```

- [x] Write failing real-process tests using temporary PowerShell scripts and local HTTP servers for: stop→start order, non-zero exit, command timeout with child-tree termination, bounded output, readiness timeout, and abort during shutdown.
- [x] Implement `ManagedComfyUIRuntime.restartAfterJob()` with injected command runner/probe factory for tests. Use argument arrays, hidden windows, bounded capture, and exact fixed script filenames under `pixelleRoot`.
- [x] Require a fresh `/system_stats` and `/object_info` probe after start; close the probe transport in `finally`.
- [x] Run focused tests, `corepack pnpm typecheck`, and `git diff --check`; commit `feat(runtime): manage one local ComfyUI endpoint`.

### Task 2: Gate worker claims on post-job restart

**Files:**
- Modify: `src/worker/index.ts`
- Modify: `src/worker/__tests__/index.test.ts`
- Create: `src/worker/job-runtime-boundary.ts`
- Create: `src/worker/__tests__/job-runtime-boundary.test.ts`

- [x] Write failing tests proving the exact order `execute → artifact/job terminal persistence → close connections → stop → start → readiness → release resource slot → release terminal claim → next claim`.
- [x] Add tests proving restart is not entered while the execution promise or output callback is unresolved, and concurrent lifecycle requests are explicitly rejected rather than interleaved.
- [x] Add failure tests: restart failure pauses polling; shutdown aborts readiness; retained/uncertain results remain retained and fail-stop without erasing reconciliation evidence.
- [x] Run the new tests and confirm expected RED failures.
- [x] Implement a small `JobRuntimeBoundary` state machine with states `ready | running-job | restarting | blocked | stopped`. It receives `execute`, `closeConnections`, and `restart` dependencies and exposes `run(job)` plus `assertReadyToClaim()`.
- [x] Initialize the managed controller once after database migrations. When enabled, validate the configured execution backend uses the canonical endpoint and its resource pool capacity and physical slot cardinality are exactly one before polling and before each job.
- [x] Route `processJob` through the boundary. Only a terminally settled job may return the boundary to `ready`; retained/ownership-lost results fail-stop with their claim and resource evidence retained for recovery.
- [x] Run worker tests, generation worker tests, typecheck, worker build, lint, and diff check; commit `feat(worker): restart managed ComfyUI between jobs`.

### Task 3: Build reviewed workflow packages from Pixelle API workflows

**Files:**
- Create: `scripts/prepare-pixelle-single-backend.ts`
- Create: `scripts/__tests__/prepare-pixelle-single-backend.test.ts`
- Create: `docs/comfyui-single-endpoint/README.md`
- Modify: `package.json`

- [ ] Write failing fixture tests that load Pixelle API workflows and require exact real selectors:
  - IndexTTS2: `$text.value!`, `$ref_audio.~audio!`, `IndexTTS2BaseNode`, `VHS_LoadAudioUpload`, `SaveAudio`.
  - OmniVoice: `$text.value!`, `$reference_audio_text.value`, `$ref_audio.~audio!`, `OmniVoiceLongformTTS` or `OmniVoiceVoiceCloneTTS`, `SaveAudio`.
  - Image: the prompt primitive, width/height primitives, and `SaveImage`.
  - Video: the prompt primitive, width/height inputs, and `VHS_VideoCombine` output.
- [ ] Reject missing/duplicate selectors, UI-format graphs, unknown node classes, absent save outputs, and model filenames not present in the probed backend inventory.
- [ ] Run the fixture tests and confirm RED failures.
- [ ] Implement the preparation command. It reads only from `PIXELLE_ROOT/workflows/selfhost`, writes generated packages to an explicit staging directory, invokes the existing workflow compiler/importer, and never edits Pixelle.
- [ ] Generate manifests only for workflows whose bindings are actually supported. Do not invent unsupported IndexTTS2 speed/pitch/emotion bindings; do not claim a video `SaveImage` output.
- [ ] Add package scripts `workflow:prepare:pixelle-single` and document the exact environment variables for `D:\demo1\Pixelle\Pixelle`, `E:\ComfyUIData`, and `http://127.0.0.1:8000`.
- [ ] Run fixture tests plus existing workflow compiler/import/promote tests, example validation, typecheck, and diff check; commit `feat(workflows): prepare Pixelle single-backend packages`.

### Task 4: Configure and verify the real single-machine backend

**Files:**
- Modify: `.env.example`
- Modify: `docs/comfyui-single-endpoint/README.md`
- Create: `scripts/verify-single-comfyui.ts`
- Create: `scripts/__tests__/verify-single-comfyui.test.ts`
- Modify: `package.json`

- [ ] Add parser tests for the verification command and a fake-server end-to-end test covering probe, submit, WebSocket/poll completion, output download, connection close, restart generation change, and reconnect.
- [ ] Add documented local configuration using Pixelle's default single backend: `E:\ComfyUIData\.venv\Scripts\python.exe`, `E:\comfyui\resources\ComfyUI`, `E:\ComfyUIData`, and port `8000`.
- [ ] Start the backend with Pixelle's `start_backend.ps1`; capture PID and readiness evidence. Do not start `8001` or `8002`.
- [ ] Probe `/system_stats`, `/object_info`, and required model/node inventory; import and promote only packages that match the live inventory.
- [ ] Run one real image job, one real video job, one IndexTTS2 job, and one OmniVoice job. For each, prove the artifact is committed before restart, the listener PID changes, readiness returns, and the next job uses a new connection/client id.
- [ ] Run cancellation, malformed workflow, missing model, ComfyUI crash, restart timeout, and worker restart tests. Record actual outcomes without converting uncertain submissions to success/failure guesses.
- [ ] Run `corepack pnpm quality`, migration checks, `git diff --check`, secret/path scan, and inspect status. Commit `test(runtime): verify single-endpoint ComfyUI acceptance`.

### Task 5: Two-stage final review and integration

**Files:**
- Modify: this plan (check completed steps)
- Modify: `docs/comfyui-single-endpoint/README.md` only for review findings or verified run evidence

- [ ] Specification review: verify every release invariant, exact `8000` topology, serial resource authority, archive-before-restart ordering, blocked restart behavior, and all four real workflows.
- [ ] Code-quality/adversarial review: inspect child-process ownership, Windows quoting, process-tree cleanup, timeout/listener leaks, stale connection identities, database claim/resource retention, log bounds, and test false positives.
- [ ] Fix every P0-P3 finding and repeat both reviews until READY.
- [ ] Re-run full quality, worker/app builds, migrations, and real acceptance after the final fix commit.
- [ ] Merge the reviewed branch into local `dev`, push `origin/dev`, restart the stable app/worker, and verify the browser plus worker health.
