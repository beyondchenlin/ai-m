# Operations Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the still-reproducible generation recovery races, transport/authentication boundary gaps, enqueue/input durability gaps, and canonicalization ambiguities without changing successful public workflows or duplicating external inference.

**Architecture:** Put every safety decision at the boundary that owns it: transactional state-transition helpers own job/attempt/slot fencing, leased claims own artifact recovery, one immutable endpoint policy owns HTTP and WebSocket dialing, authenticated request proofs own replay protection, and validated durable snapshots own queued inputs. Database changes are additive and forward-compatible; rollback means reverting callers while retaining additive tables/columns until a later cleanup migration.

**Tech Stack:** TypeScript, Next.js route handlers, Node.js 22, Vitest, Drizzle ORM, SQLite/WAL, Undici, WebSocket, filesystem streams, pnpm.

---

## Scope, evidence, and release invariants

Current focused baseline: 10 test files / 61 tests pass. Read-only reproductions on current HEAD confirm:

- A live artifact writer can be quarantined by startup recovery, after which the writer leaves an orphaned committed file.
- Two real Node processes accept the same trusted-proxy timestamp/nonce because replay state is process-local.
- The real orchestration WebSocket path uses a naked `new WebSocket(wsUrl)` in `comfyui-connection-manager.ts`, bypassing the policy-aware method on `ComfyUIHttpTransport`.
- HTTP socket pinning and redirect blocking work, but a server that returns headers and stalls the body has no operation deadline.
- `sha256("null") === sha256(null)`, proving that raw bytes and canonical JSON share an ambiguous API.

Already effective and not to be reimplemented:

- `pinned-json-request.ts` uses the Node 22 DNS callback shape, pins the actual socket, does not follow redirects, and enforces an absolute timeout.
- `ComfyUIHttpTransport` pins HTTP sockets and manually rejects redirects.
- Character image references are processed before enqueue and their hash/size/MIME contribute to the request digest.
- API cancellation checks its compare-and-swap result and returns `409` on a lost race.
- Production admin startup requires a strong bearer token and compares it in constant time.

The effective controls above need regression coverage where noted, but they are not open findings. In particular, the unused policy-aware WebSocket method does not close the real orchestration WebSocket finding.

Global invariants for all tasks:

1. A stale worker/scanner may never overwrite a newer owner, lease, fencing token, terminal state, or external-execution fact.
2. No retry or recovery path may create duplicate external inference merely to regain local liveness.
3. Invalid or unauthenticated input must fail before creating jobs, attempts, slots, artifacts, or backend traffic.
4. The bytes validated, hashed, persisted, and uploaded must be the same bytes.
5. Existing valid jobs, digests, API response shapes, single-user mode, and committed artifacts remain readable.

For every task, follow the same review loop after its task-specific checks:

- [ ] Run the focused RED test first and record the expected safety failure.
- [ ] Implement only the files named by that task; avoid opportunistic refactors.
- [ ] Run the focused tests until green, then `corepack pnpm typecheck` and `git diff --check`.
- [ ] Perform a specification review: compare the diff with the task invariant, race schedule, compatibility notes, and acceptance criteria.
- [ ] Perform a code-quality review: inspect transaction boundaries, error paths, cleanup, logs without secrets, and tests for false positives.
- [ ] Commit only that task with the specified commit message.

## P0 — State and transport safety

### Task 1: Make job/attempt recovery and worker cancellation one atomic state machine

**Invariant:** A scanner or cancelling worker changes a job and its current attempt together, only when the expected attempt id, attempt fencing token, job owner/lease, and source states still match. A cancellation event exists iff cancellation commits.

**Source architecture:** Add one transactional transition module and make both recovery scanning and worker cancellation call it. Do not use a prior read followed by independent job-only and attempt-only updates.

**Files:**

- Create: `src/lib/generation/jobs/state-transitions.ts`
- Modify: `src/lib/generation/resources/leases.ts`
- Modify: `src/lib/generation/worker-executor.ts`
- Create: `src/lib/generation/jobs/__tests__/recovery-concurrency.test.ts`
- Create: `src/lib/generation/jobs/__tests__/worker-cancellation.test.ts`

- [ ] Write a two-connection SQLite/WAL barrier test: scanner reads `PREPARING`; worker atomically advances job/attempt to `SUBMITTING` and records the external id; scanner resumes. Assert scanner reports a lost race and cannot set `QUEUED`, `CANCELLED`, or `ORPHANED`.
- [ ] Write a cancellation race where the attempt fencing token changes between read and finalize. Assert no terminal event and no `CANCELLED` return on the losing path.
- [ ] Run RED: `corepack pnpm vitest run src/lib/generation/jobs/__tests__/recovery-concurrency.test.ts src/lib/generation/jobs/__tests__/worker-cancellation.test.ts`.
- [ ] Implement explicit transition inputs (expected job state, current attempt id/state/token, owner/lease) and update job, attempt, and event in one transaction; return a typed `applied | lost-race | invalid-transition` result.
- [ ] Replace the scanner's read-then-job-CAS path and the ignored booleans in `cancelJob` with that helper.
- [ ] Run focused regression: `corepack pnpm vitest run src/lib/generation/jobs/__tests__/recovery-concurrency.test.ts src/lib/generation/jobs/__tests__/worker-cancellation.test.ts src/lib/generation/resources/__tests__/leases.test.ts src/worker/__tests__/index.test.ts`.

**Compatibility/rollback:** No migration. Preserve existing enum values and API `409` behavior. Reverting the callers restores old behavior; the helper is removable with the same revert.

**Acceptance:** The exact stale-scanner schedule cannot erase external execution, and a losing cancellation writes neither state nor event.

**Commit:** `fix(generation): atomically fence recovery transitions`

### Task 2: Fence slot lease release, retention, and reconciliation

**Invariant:** A scanner releases a slot only when the same owner attempt, lease token, fencing token, and observed expiry are still current at commit time. An uncertain external execution retains capacity until durable reconciliation proves termination.

**Source architecture:** Make slot disposition an explicit reconciliation state machine. Bind release CAS to the slot lease identity and `expiresAt < scanNow`; distinguish local terminal state from durable external termination proof. Do not describe this as blind “reacquisition.”

**Files:**

- Create: `drizzle/0060_resource_reconciliation_proof.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/db/schema.ts`
- Modify: `src/lib/generation/resources/leases.ts`
- Modify: `src/lib/generation/worker-executor.ts`
- Modify: `src/lib/generation/resources/__tests__/leases.test.ts`
- Create: `src/lib/generation/resources/__tests__/slot-reconciliation-concurrency.test.ts`
- Modify: `src/lib/db/__tests__/migration-journal.test.ts`

- [ ] Add a two-connection barrier test where recovery reads an expired slot, the worker renews it, then recovery tries to release. Assert renewal wins and capacity remains held.
- [ ] Add tests showing `ORPHANED`/`NEEDS_ATTENTION` without termination proof retains the slot, while a matching durable termination proof permits exactly one release.
- [ ] Add a concurrent two-scanner test proving one release and no negative/overcommitted capacity.
- [ ] Run RED: `corepack pnpm vitest run src/lib/generation/resources/__tests__/slot-reconciliation-concurrency.test.ts src/lib/generation/resources/__tests__/leases.test.ts`.
- [ ] Add the minimal additive reconciliation proof fields/table, including attempt id, backend/external id, proof kind/time, and fencing identity; update schema and journal.
- [ ] Implement renewal/release predicates that recheck lease identity and expiry in the write statement, plus an explicit retained/reconciled disposition.
- [ ] Run migration and focused gates: `python tools/test_migrations.py` and `corepack pnpm vitest run src/lib/generation/resources/__tests__/slot-reconciliation-concurrency.test.ts src/lib/generation/resources/__tests__/leases.test.ts src/lib/db/__tests__/migration-journal.test.ts`.

**Compatibility/rollback:** Migration is additive and nullable for legacy rows. Legacy uncertain attempts default to retained, never released. Roll back code first; keep the additive proof data until a later cleanup migration.

**Acceptance:** A post-read renewal cannot be released; uncertain external work cannot free capacity; a matching termination proof releases once.

**Commit:** `fix(generation): fence slot reconciliation and release`

### Task 3: Lease live artifact writers and recovery claims

> Migration numbering note: `0061_resource_slot_owner_unique.sql` is reserved for the Task 2
> follow-up that enforces one physical slot per attempt. Task 3 therefore starts at `0062`, and
> later planned migrations are shifted forward; do not modify the published `0060` migration.

**Invariant:** Recovery never quarantines a live writer, and at most one recovery owner may commit or quarantine a stale artifact. Losing writers/recoverers leave neither an untracked committed file nor conflicting database state.

**Source architecture:** Give STAGING writers a renewable lease and make recovery claim stale rows by CAS into `RECOVERING` with a token. Finalization must present the writer or recovery token. Startup scanners can run concurrently.

**Files:**

- Create: `drizzle/0062_artifact_recovery_leases.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/db/schema.ts`
- Modify: `src/lib/generation/archiving/commit.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/lib/generation/archiving/__tests__/commit.test.ts`
- Create: `src/lib/generation/archiving/__tests__/recovery-concurrency.test.ts`
- Modify: `src/lib/db/__tests__/migration-journal.test.ts`

- [ ] Encode the confirmed delayed-stream race: pause after STAGING insert, run recovery, release the stream, and assert the live writer commits without quarantine or orphaned file.
- [ ] Add two independent recovery scanners racing on one stale artifact; assert exactly one claim and one terminal action.
- [ ] Add lease-expiry and lost-renewal cleanup tests using real temp files and separate DB connections.
- [ ] Run RED: `corepack pnpm vitest run src/lib/generation/archiving/__tests__/recovery-concurrency.test.ts src/lib/generation/archiving/__tests__/commit.test.ts`.
- [ ] Add nullable writer/recovery lease owner, token, and expiry fields; implement claim, renewal, token-bound finalization, and safe loser cleanup.
- [ ] Start recovery only after worker identity exists; make repeated startup recovery idempotent.
- [ ] Run migration and focused gates: `python tools/test_migrations.py` and `corepack pnpm vitest run src/lib/generation/archiving/__tests__/recovery-concurrency.test.ts src/lib/generation/archiving/__tests__/commit.test.ts src/worker/__tests__/index.test.ts src/lib/db/__tests__/migration-journal.test.ts`.

**Compatibility/rollback:** Existing STAGING rows have no live lease and are recoverable after the configured grace period. COMMITTED/QUARANTINED rows are unchanged. Roll back code before considering any later column cleanup.

**Acceptance:** The reproduced orphan-file race is green, two scanners cannot double-finalize, and stale artifacts remain recoverable.

**Commit:** `fix(artifacts): lease writers and recovery claims`

### Task 4: Route the real ComfyUI WebSocket through one pinned endpoint policy

**Invariant:** Every orchestration WebSocket connection uses the same immutable endpoint policy as HTTP: approved scheme/host/port, actual-socket DNS pinning, redirect/origin rules, auth headers, policy revision, and bounded reconnect. Registry reuse cannot cross credential or policy identities.

**Source architecture:** Make the transport own the sole WebSocket factory. Remove naked dialing from the connection manager, and key the manager registry by endpoint plus a non-secret credential identity and policy digest/revision.

**Files:**

- Modify: `src/lib/generation/transports/comfyui.ts`
- Modify: `src/lib/generation/transports/comfyui-connection-manager.ts`
- Modify: `src/lib/generation/transports/comfyui-execution-orchestrator.ts`
- Create: `src/lib/generation/transports/__tests__/comfyui-websocket-policy.test.ts`
- Create: `src/lib/generation/transports/__tests__/comfyui-connection-manager.test.ts`

- [ ] Start a real local HTTP upgrade server behind a fake hostname and custom lookup. Assert the actual socket is the approved address and auth/origin headers arrive.
- [ ] Test a disallowed address, redirect/alternate authority, credential rotation, policy revision, and reconnect exhaustion. Assert no fallback naked dial and no registry reuse across identities.
- [ ] Run RED: `corepack pnpm vitest run src/lib/generation/transports/__tests__/comfyui-websocket-policy.test.ts src/lib/generation/transports/__tests__/comfyui-connection-manager.test.ts`.
- [ ] Introduce one immutable endpoint-policy object and transport-owned WebSocket factory; inject that factory into the connection manager.
- [ ] Expand the registry key with endpoint, credential identity, and policy digest/revision; never log or store the credential itself in the key.
- [ ] Run focused gates: `corepack pnpm vitest run src/lib/generation/transports/__tests__/comfyui-websocket-policy.test.ts src/lib/generation/transports/__tests__/comfyui-connection-manager.test.ts src/lib/security/__tests__/network-policy.test.ts` and `corepack pnpm worker:build`.

**Compatibility/rollback:** Preserve URL construction and supported auth headers. Existing managers drain naturally on policy revision; rollback restores the old factory but must not silently enable insecure fallback. No migration.

**Acceptance:** A test spy proves the orchestrator's actual connection path reaches the pinned factory; all alternate paths fail closed.

**Commit:** `fix(comfyui): enforce endpoint policy on websocket`

## P1 — Bounded operations and durable request/input boundaries

### Task 5: Enforce absolute ComfyUI operation deadlines, including response bodies

**Invariant:** Probe, submit, upload, and download each have an absolute wall-clock deadline covering DNS, connect, headers, and body consumption. Timeout classification drives the correct slot retention/release rule and never causes an unsafe retry after uncertain submission.

**Source architecture:** Use operation-scoped abort/deadline objects layered under lifecycle cancellation. Carry a typed outcome (`definitely-not-submitted`, `submission-uncertain`, `definitely-complete`) to the slot reconciliation boundary.

**Files:**

- Modify: `src/lib/generation/transports/comfyui.ts`
- Modify: `src/lib/generation/transports/comfyui-execution-orchestrator.ts`
- Modify: `src/lib/generation/worker-executor.ts`
- Create: `src/lib/generation/transports/__tests__/comfyui-deadlines.test.ts`
- Modify: `src/lib/generation/resources/__tests__/leases.test.ts`

- [ ] Use real local servers that stall before headers and slowloris after headers for probe, submit, upload, and download. Assert elapsed time is bounded with margin.
- [ ] Assert pre-submit timeout releases safely, post-write/unknown submit timeout retains for reconciliation, and download timeout cleans partial files without losing external identity.
- [ ] Run RED: `corepack pnpm vitest run src/lib/generation/transports/__tests__/comfyui-deadlines.test.ts src/lib/generation/resources/__tests__/leases.test.ts`.
- [ ] Implement per-operation absolute timers that remain active through body streaming and always clear listeners/timers.
- [ ] Map timeout phase to typed reconciliation disposition; do not infer “not submitted” from a generic abort.
- [ ] Run focused gates: `corepack pnpm vitest run src/lib/generation/transports/__tests__/comfyui-deadlines.test.ts src/lib/generation/resources/__tests__/leases.test.ts` and `corepack pnpm worker:build`.

**Compatibility/rollback:** Default deadlines should match or exceed current practical limits and be configurable within bounded ranges. Rollback removes deadline enforcement but leaves typed evidence harmless. No migration.

**Acceptance:** Every slowloris case terminates within its deadline and the slot disposition matches whether external execution is impossible, uncertain, or complete.

**Commit:** `fix(comfyui): bound transport operations by deadline`

### Task 6: Complete trusted-proxy request proofs and durable replay prevention

**Invariant:** A trusted-proxy assertion proves one exact request—scheme, authority, method, normalized path/query, body digest, user, timestamp, and nonce—and that nonce can be accepted only once across processes during its TTL. Signing keys have at least 32 bytes of decoded entropy.

**Source architecture:** Move proxy verification into a dedicated request-proof module. Reserve the nonce with a unique database insert in the same acceptance flow; treat unique conflict as replay. Canonicalization is versioned so rollout is explicit.

**Files:**

- Create: `drizzle/0063_trusted_proxy_nonces.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/db/schema.ts`
- Create: `src/lib/security/trusted-proxy-auth.ts`
- Modify: `src/lib/get-user-id.ts`
- Modify: `src/lib/config/bootstrap.ts`
- Create: `src/lib/security/__tests__/trusted-proxy-auth.test.ts`
- Create: `src/lib/security/__tests__/trusted-proxy-replay-process.test.ts`
- Modify: `src/lib/security/__tests__/user-identity.test.ts`
- Modify: `src/lib/db/__tests__/migration-journal.test.ts`

- [ ] Spawn two real Node processes against one temp DB with the same signed request; assert exactly one acceptance.
- [ ] Add mutation tests for scheme, authority, query ordering/encoding, and body; assert an unchanged signature fails.
- [ ] Add decoded-secret tests: long low-entropy text and short decoded base64 fail; 32 random decoded bytes pass.
- [ ] Run RED: `corepack pnpm vitest run src/lib/security/__tests__/trusted-proxy-auth.test.ts src/lib/security/__tests__/trusted-proxy-replay-process.test.ts src/lib/security/__tests__/user-identity.test.ts`.
- [ ] Add nonce table with unique `(issuer/key-id, nonce)` and expiry index; implement atomic reserve and bounded cleanup.
- [ ] Implement versioned canonical proof bytes and constant-time signature verification after strict header parsing.
- [ ] Run migration and focused gates: `python tools/test_migrations.py` and `corepack pnpm vitest run src/lib/security/__tests__/trusted-proxy-auth.test.ts src/lib/security/__tests__/trusted-proxy-replay-process.test.ts src/lib/security/__tests__/user-identity.test.ts src/lib/db/__tests__/migration-journal.test.ts`.

**Compatibility/rollback:** Support old proof version only behind an explicit, time-bounded non-production flag; production defaults fail closed. Existing single-user mode is unchanged. Keep nonce rows/table if code rolls back.

**Acceptance:** The same proof cannot be accepted by two processes, and modifying any request component invalidates the signature.

**Commit:** `fix(security): bind proxy proofs and persist nonces`

### Task 7: Validate and normalize compiled workflow inputs before enqueue

**Invariant:** Only inputs allowed by `CompiledBindings` reach persistence. Required fields, types, min/max, finite numbers, size, and depth are enforced before any job/attempt/backend/slot side effect; validation failures are stable `400` or `413` responses.

**Source architecture:** Derive a validator from compiled workflow binding definitions (`key`, `valueType`, `source`, `required`, `userOverride`, defaults, min/max), normalize once, then hash and persist that typed snapshot. The service—not only the route—enforces the boundary.

**Files:**

- Create: `src/lib/generation/jobs/request-validation.ts`
- Modify: `src/lib/generation/workflows/compiled.ts`
- Modify: `src/lib/generation/workflows/types.ts`
- Modify: `src/lib/generation/jobs/service.ts`
- Modify: `src/app/api/generation/jobs/route.ts`
- Create: `src/lib/generation/jobs/__tests__/request-validation.test.ts`
- Create: `src/app/api/generation/jobs/__tests__/route.test.ts`

- [ ] Add table-driven tests for unknown keys, forbidden overrides, missing required values, wrong types, NaN/infinity, numeric bounds, depth, and payload size.
- [ ] Instrument repositories/backend/slot acquisition; assert every invalid request produces zero job, attempt, backend, and slot calls.
- [ ] Assert semantic client failures map to `400`, while byte/depth/collection limits map to `413` with stable non-secret codes.
- [ ] Run RED: `corepack pnpm vitest run src/lib/generation/jobs/__tests__/request-validation.test.ts src/app/api/generation/jobs/__tests__/route.test.ts`.
- [ ] Implement compiled-binding validation/normalization in the service before idempotency hashing or inserts; keep the route as a thin error mapper.
- [ ] Run focused gates: `corepack pnpm vitest run src/lib/generation/jobs/__tests__/request-validation.test.ts src/lib/generation/jobs/__tests__/idempotency.test.ts src/app/api/generation/jobs/__tests__/route.test.ts src/lib/security/__tests__/request-validation.test.ts` and `corepack pnpm build`.

**Compatibility/rollback:** Preserve valid request/response shapes and digest behavior for already-canonical valid inputs. Existing queued jobs bypass revalidation and remain executable. No migration.

**Acceptance:** Invalid payloads have no durable or external side effects, and valid normalization is deterministic before hashing.

**Commit:** `fix(generation): validate compiled inputs before enqueue`

### Task 8: Persist job input artifact snapshots and materialize one verified file handle

**Invariant:** A queued job durably references the exact artifact descriptor it validated, and materialization hashes and uploads bytes read through one opened handle whose identity is stable from initial to final `fstat`.

**Source architecture:** Add `job_input_artifacts` links transactionally with job creation, containing artifact id plus captured hash/size/MIME. Prevent deletion while linked. Materialization opens once, checks initial metadata, streams hash/copy/upload from that handle, and checks final identity.

**Files:**

- Create: `drizzle/0063_job_input_artifacts.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/db/schema.ts`
- Modify: `src/lib/generation/jobs/service.ts`
- Modify: `src/lib/generation/business-adapter.ts`
- Modify: `src/lib/generation/reference-image-processor.ts`
- Modify: `src/lib/generation/input-materializer.ts`
- Modify: `src/lib/generation/source-assets.ts`
- Create: `src/lib/generation/__tests__/input-artifact-snapshot.test.ts`
- Create: `src/lib/generation/__tests__/input-materializer-concurrency.test.ts`
- Modify: `src/lib/db/__tests__/migration-journal.test.ts`

- [ ] Add an enqueue/delete race using two DB connections; assert either enqueue links the artifact and deletion loses, or deletion wins and enqueue fails before job creation.
- [ ] Add a real filesystem barrier that replaces a source path with same-length bytes between hash and upload. Assert replacement is rejected and unchecked bytes never upload.
- [ ] Test descriptor mismatch, final `fstat` mismatch, partial reads, and legacy jobs with no link.
- [ ] Run RED: `corepack pnpm vitest run src/lib/generation/__tests__/input-artifact-snapshot.test.ts src/lib/generation/__tests__/input-materializer-concurrency.test.ts`.
- [ ] Add link table/foreign keys/indexes and create links in the job transaction from already-processed reference descriptors.
- [ ] Refactor bounded read/copy to one `FileHandle`, hash the exact streamed bytes, verify initial/final device/inode/size/mtime identity where supported, and close in `finally`.
- [ ] Run migration and focused gates: `python tools/test_migrations.py` and `corepack pnpm vitest run src/lib/generation/__tests__/input-artifact-snapshot.test.ts src/lib/generation/__tests__/input-materializer-concurrency.test.ts src/lib/generation/jobs/__tests__/idempotency.test.ts src/lib/db/__tests__/migration-journal.test.ts`.

**Compatibility/rollback:** Existing jobs without links use a documented legacy read path that still verifies the current descriptor; new jobs require links. Deletion becomes more restrictive, not destructive. Keep links if callers roll back.

**Acceptance:** Same-length path replacement cannot change uploaded bytes, and linked inputs cannot disappear or silently change after enqueue.

**Commit:** `fix(generation): snapshot and verify job input artifacts`

### Task 9: Reserve source-asset quota before writing bytes

**Invariant:** Concurrent uploads cannot make reserved plus committed project storage exceed quota, even temporarily. Every reservation is committed, explicitly released, or safely recovered after TTL.

**Source architecture:** Reserve declared/maximum bounded bytes atomically before disk write, associate the reservation with upload identity, adjust to actual size at commit, and let recovery reclaim only expired unowned reservations.

**Files:**

- Create: `drizzle/0064_source_asset_quota_reservations.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/db/schema.ts`
- Modify: `src/lib/generation/source-assets.ts`
- Modify: `src/app/api/projects/[id]/source-assets/audio/route.ts`
- Create: `src/lib/generation/__tests__/source-asset-quota-concurrency.test.ts`
- Modify: `src/lib/db/__tests__/migration-journal.test.ts`

- [ ] Start concurrent uploads through separate DB connections/processes with barriered streams. Sample disk usage and assert committed plus in-flight reserved bytes never exceeds quota.
- [ ] Test client disconnect, ffprobe failure, process death/TTL recovery, reservation renewal, and exact-boundary success.
- [ ] Run RED: `corepack pnpm vitest run src/lib/generation/__tests__/source-asset-quota-concurrency.test.ts`.
- [ ] Add reservation table with project, upload owner/token, reserved bytes, expiry, and status; reserve under an immediate transaction before opening the destination.
- [ ] Renew during long writes, finalize reservation and asset atomically, and remove partial files on all loser paths.
- [ ] Run migration and focused gates: `python tools/test_migrations.py` and `corepack pnpm vitest run src/lib/generation/__tests__/source-asset-quota-concurrency.test.ts src/lib/db/__tests__/migration-journal.test.ts`.

**Compatibility/rollback:** Preserve the current per-file 50 MB limit and API response. Existing assets count as committed usage. Roll back route/service first; keep reservation records until expired and reconciled.

**Acceptance:** Concurrent peak usage stays within quota and crashes cannot leak permanent reservations or partial files.

**Commit:** `fix(uploads): reserve project quota atomically`

### Task 10: Make voice-profile processing idempotent under concurrency

**Invariant:** Within project and user scope, one idempotency key plus one semantic digest creates at most one voice profile; replay returns the winner, while reuse with a different digest returns `409`.

**Source architecture:** Accept an operation/idempotency key at the route, compute the full normalized semantic digest before processing, and enforce a database unique constraint. Concurrent callers resolve the unique winner instead of duplicating processing.

**Files:**

- Create: `drizzle/0065_voice_profile_idempotency.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/db/schema.ts`
- Modify: `src/lib/generation/voice-profiles.ts`
- Modify: `src/app/api/projects/[id]/voice-profiles/route.ts`
- Create: `src/lib/generation/__tests__/voice-profile-idempotency.test.ts`
- Create: `src/app/api/projects/[id]/voice-profiles/__tests__/route.test.ts`
- Modify: `src/lib/db/__tests__/migration-journal.test.ts`

- [ ] Race two real service instances/DB connections with the same key and digest; assert one profile and identical response identity.
- [ ] Reuse the key with one semantic field changed; assert `409` and no processing side effect. Test different users/projects remain isolated.
- [ ] Run RED: `corepack pnpm vitest run src/lib/generation/__tests__/voice-profile-idempotency.test.ts src/app/api/projects/[id]/voice-profiles/__tests__/route.test.ts`.
- [ ] Add scoped key/digest fields and unique index; implement winner readback and mismatch conflict.
- [ ] Require a bounded idempotency key for new writes, with an explicit compatibility window only if current clients cannot deploy atomically.
- [ ] Run migration and focused gates: `python tools/test_migrations.py` and `corepack pnpm vitest run src/lib/generation/__tests__/voice-profile-idempotency.test.ts src/app/api/projects/[id]/voice-profiles/__tests__/route.test.ts src/lib/db/__tests__/migration-journal.test.ts`.

**Compatibility/rollback:** Existing profiles have null keys and remain readable. If a compatibility window is required, server-generated keys are non-retryable and clearly signaled; remove that mode after clients send keys. Keep unique data on rollback.

**Acceptance:** Same-key concurrency performs processing once; a semantic mismatch is a deterministic `409`.

**Commit:** `fix(voice): enforce profile idempotency`

## P2 — Browser request and canonical digest hardening

### Task 11: Centralize browser mutation origin/CSRF policy without weakening service auth

**Invariant:** Browser/cookie-authenticated mutations require a present, canonical HTTPS same-origin proof (and CSRF token where applicable). Missing Origin/Referer/Fetch Metadata is not accepted as browser traffic. Non-browser mutation is allowed only through explicit bearer/service authentication.

**Source architecture:** Extend the central request-origin guard into a mutation-auth boundary that classifies browser-cookie versus bearer/service requests. Apply it through shared route wrappers, including admin mutators, instead of ad hoc checks.

**Files:**

- Modify: `src/lib/security/request-origin.ts`
- Create: `src/lib/security/mutation-request.ts`
- Modify: `src/lib/security/__tests__/request-origin.test.ts`
- Create: `src/lib/security/__tests__/mutation-request.test.ts`
- Modify: mutating `src/app/api/**/route.ts` handlers through the narrowest existing shared route/auth wrappers
- Create: `src/lib/security/__tests__/mutation-route-coverage.test.ts`

- [ ] Add sub-boundary tests for browser cookie requests: missing headers, cross-origin, HTTP configured origin in production, malformed Referer, `Sec-Fetch-Site: cross-site`, and valid same-origin.
- [ ] Separately test bearer/admin/service requests: valid strong bearer works without browser headers; cookie presence cannot downgrade into service classification; invalid bearer fails.
- [ ] Add a static route-coverage test that enumerates mutating handlers and requires the central guard or an approved bearer-only wrapper.
- [ ] Run RED: `corepack pnpm vitest run src/lib/security/__tests__/request-origin.test.ts src/lib/security/__tests__/mutation-request.test.ts src/lib/security/__tests__/mutation-route-coverage.test.ts`.
- [ ] Implement canonical origin parsing, production HTTPS enforcement, browser/service classification, and shared wrapper integration; never infer trust from header absence.
- [ ] Run focused gates: `corepack pnpm vitest run src/lib/security/__tests__/request-origin.test.ts src/lib/security/__tests__/mutation-request.test.ts src/lib/security/__tests__/mutation-route-coverage.test.ts src/lib/security/__tests__/request-validation.test.ts` and `corepack pnpm build`.

**Compatibility/rollback:** The strong admin bearer gate remains unchanged. Document service clients that must send bearer auth. A temporary report-only mode may inventory browser callers, but production enforcement must have a dated cutoff and cannot accept missing origin indefinitely. No migration.

**Acceptance:** Every mutating route is classified by the central policy; browser requests cannot succeed with absent/cross-site origin evidence, and valid bearer-only automation still works.

**Commit:** `fix(security): centralize mutation origin policy`

### Task 12: Separate canonical JSON digests from raw-byte hashing

**Invariant:** Canonical JSON has one strict, versioned representation with deterministic Unicode/number/object ordering semantics, while raw bytes are hashed only through a distinct API. Unsupported values, non-finite numbers, and lone surrogates fail explicitly.

**Source architecture:** Replace overloaded `sha256(value)` with `sha256Canonical(value)` and `sha256Bytes(bytes)`. Define the canonical format against RFC 8785/JCS golden vectors and version any persisted digest boundary whose representation must evolve.

**Files:**

- Modify: `src/lib/generation/workflows/canonical.ts`
- Create: `src/lib/generation/workflows/__tests__/canonical.test.ts`
- Modify: call sites returned by `rg "sha256\(" src/lib src/app`
- Modify: persisted-digest compatibility tests in `src/lib/generation/jobs/__tests__/idempotency.test.ts`

- [ ] Add golden vectors for object ordering, escapes/Unicode, RFC numeric examples, negative zero, and nested structures; add rejection tests for NaN/infinity, undefined, functions, cycles, and lone surrogates.
- [ ] Add the ambiguity regression: canonical JSON `null` and raw UTF-8 bytes `"null"` must require different APIs even if their digest bytes happen to match.
- [ ] Inventory every call site and label it canonical-data or raw-bytes before changing code.
- [ ] Run RED: `corepack pnpm vitest run src/lib/generation/workflows/__tests__/canonical.test.ts src/lib/generation/jobs/__tests__/idempotency.test.ts`.
- [ ] Implement strict canonical serialization and split hash APIs; migrate call sites mechanically according to the reviewed inventory.
- [ ] Preserve persisted digests for existing valid JSON. If any golden representation differs, add an explicit digest version and dual-read compatibility rather than silently rewriting identities.
- [ ] Run focused gates: `corepack pnpm vitest run src/lib/generation/workflows/__tests__/canonical.test.ts src/lib/generation/jobs/__tests__/idempotency.test.ts` and `rg "sha256\(" src/lib src/app` to confirm no ambiguous API remains.

**Compatibility/rollback:** No migration unless the call-site inventory proves a persisted representation change; in that case stop and amend this plan with a versioned migration before implementation. Existing valid persisted digests must continue to resolve. Rollback restores old function names only after callers are reverted.

**Acceptance:** JCS golden vectors pass, invalid values fail before hashing, no ambiguous hash API remains, and existing persisted digest fixtures are unchanged.

**Commit:** `refactor(digests): separate canonical and byte hashing`

## Final integration and release gate

- [ ] Run all migration checks: `python tools/test_migrations.py` and `corepack pnpm test:migrations`.
- [ ] Run worker and application builds: `corepack pnpm worker:build` and `corepack pnpm build`.
- [ ] Run the complete static gate: `corepack pnpm quality:static`.
- [ ] Repeat the real concurrency/process/network suites together:

  ```powershell
  corepack pnpm vitest run `
    src/lib/generation/jobs/__tests__/recovery-concurrency.test.ts `
    src/lib/generation/resources/__tests__/slot-reconciliation-concurrency.test.ts `
    src/lib/generation/archiving/__tests__/recovery-concurrency.test.ts `
    src/lib/generation/transports/__tests__/comfyui-websocket-policy.test.ts `
    src/lib/generation/transports/__tests__/comfyui-deadlines.test.ts `
    src/lib/security/__tests__/trusted-proxy-replay-process.test.ts `
    src/lib/generation/__tests__/input-materializer-concurrency.test.ts `
    src/lib/generation/__tests__/source-asset-quota-concurrency.test.ts `
    src/lib/generation/__tests__/voice-profile-idempotency.test.ts
  ```

- [ ] Run `git diff --check`, inspect `git status --short`, and verify generated build output, temp DBs, uploads, and secrets are not tracked.
- [ ] Perform final specification review against all global invariants and the fixed/open finding list at the top of this plan.
- [ ] Perform final code-quality review for transaction duration, WAL busy handling, lease-clock consistency, cleanup/idempotency, secret-safe logging, bounded timers, and deterministic tests.
- [ ] Document rollout order: apply additive migrations first, deploy code with fail-closed configuration validated at startup, observe reconciliation/auth metrics, then remove only explicitly temporary compatibility flags.
- [ ] Document rollback order: stop new workers/uploads, roll back application code, retain additive schema/data, and resume only after mixed-version behavior is verified. Never down-migrate live proof, link, nonce, reservation, or idempotency data during emergency rollback.

Final acceptance is not “tests pass” alone: all confirmed reproductions must be green, already-effective controls must remain green, no open P0/P1 task may be deferred, and no compatibility path may silently weaken production authentication, fencing, or duplicate-inference protection.
