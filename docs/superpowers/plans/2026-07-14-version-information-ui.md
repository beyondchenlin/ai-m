# Version Information UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accessible, localized About/version section to Settings, backed by reproducible and strictly validated build metadata.

**Architecture:** `package.json` is the only version source. `next.config.ts` validates the version and the optional `AI_M_BUILD_COMMIT` / `AI_M_BUILD_TIME` deployment inputs, then embeds only three internal public fields. A server Settings page converts those embedded fields into an immutable typed object and passes it to a focused client component; no API, Git process, `.git` read, hostname, path, arbitrary environment value, or nondeterministic build timestamp is exposed.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, next-intl, Tailwind CSS, Vitest, Testing Library, jsdom.

---

## Design contract

- Version must be strict SemVer 2.0.0 and comes only from `package.json`; no environment override exists.
- Commit is optional. When supplied, it must be 7–64 hexadecimal characters and is canonicalized to lowercase. The UI shows at most 12 characters; copied text retains the full value.
- Build time is optional. When supplied, it must already equal canonical UTC ISO 8601 with exactly millisecond precision: `YYYY-MM-DDTHH:mm:ss.sssZ`. Offsets, missing/extra fractional digits, invalid dates, and normalized alternatives fail fast.
- Missing commit renders the localized equivalent of “Development”; missing time renders “Not provided”. No fallback calls `Date.now()`.
- `next.config.ts` embeds only `AI_M_INTERNAL_EMBEDDED_VERSION`, `AI_M_INTERNAL_EMBEDDED_COMMIT`, and `AI_M_INTERNAL_EMBEDDED_BUILD_TIME`. Deployment inputs and similarly named runtime variables cannot become client props.
- The existing Settings navigation remains unchanged. A restrained final card reuses existing border, surface, typography, focus, and spacing tokens. It uses `dl` semantics, stacks on narrow screens, and exposes copy success/failure through an `aria-live` region.

## File map

- Create `src/lib/build-metadata.ts`: validation, canonicalization, immutable public type, embedded-field reader, copy-summary helper.
- Create `src/lib/__tests__/build-metadata.test.ts`: pure metadata contract and fallback tests.
- Create `src/lib/__tests__/build-metadata-config.test.ts`: child-process `next.config.ts` fail-fast and internal-field isolation tests.
- Create `src/components/settings/version-information.tsx`: localized display and clipboard interaction.
- Create `src/components/settings/__tests__/version-information.test.tsx`: rendering, copy, failure, semantics, and accessibility tests.
- Create `src/app/[locale]/settings/settings-page-client.tsx`: existing interactive Settings body plus the new card.
- Modify `src/app/[locale]/settings/page.tsx`: server boundary that reads only embedded metadata.
- Modify `next.config.ts`, four `messages/*.json`, `package.json`, `pnpm-lock.yaml`, and `README.md`.

## Task 1: Metadata contract and build boundary

- [ ] Add failing tests covering strict SemVer, package-version-only behavior, absent optionals, 7/64-character commits, lowercase canonicalization, invalid commit lengths/characters, exact millisecond UTC time, rejected offsets/normalization, object freezing, full-copy versus 12-character display, and absence of host/path/secret fields.
- [ ] Run `corepack pnpm exec vitest run src/lib/__tests__/build-metadata.test.ts` and confirm failure because the module does not exist.
- [ ] Implement `src/lib/build-metadata.ts` with `resolveBuildMetadata`, `readEmbeddedBuildMetadata`, `shortCommit`, and `formatVersionSummary`; rerun until green.
- [ ] Add failing child-process tests that import `next.config.ts` with invalid commit/time and assert nonzero exit, then assert package version and all three embedded fields for valid input. Also supply hostile `AI_M_INTERNAL_EMBEDDED_*` runtime values and prove config output replaces them with validated build values.
- [ ] Run `corepack pnpm exec vitest run src/lib/__tests__/build-metadata-config.test.ts` and confirm the current config fails those assertions.
- [ ] Update `next.config.ts` to resolve metadata at config load and set exactly the three internal embedded keys; rerun both metadata suites until green.
- [ ] Commit metadata/config changes.

## Task 2: Localized accessible Settings UI

- [ ] Add Testing Library/jsdom development dependencies with pnpm.
- [ ] Add failing component tests that render inside `NextIntlClientProvider`, assert `dl/dt/dd` content and localized fallbacks, assert the full commit is available without visual overflow, click copy and verify the complete localized summary, cover clipboard rejection, and verify button name plus polite status announcement.
- [ ] Add a failing dictionary consistency test for every `settings.versionInfo` key in `zh`, `en`, `ja`, and `ko`.
- [ ] Run the focused UI/i18n suites and confirm expected missing-component/key failures.
- [ ] Implement `VersionInformation` using existing tokens and `Button`, with a compact responsive grid, visible keyboard focus, minimum 44px copy target, full-value `title`, and no new navigation.
- [ ] Split the existing client page into `settings-page-client.tsx`; make `page.tsx` a server component that passes `readEmbeddedBuildMetadata()` output. Add all four translations and rerun focused suites until green.
- [ ] Commit UI/i18n changes.

## Task 3: Deployment documentation and validation

- [ ] Add failing documentation assertions for the two public deployment input names, package-version single-source statement, commit/time formats, missing-value behavior, and a placeholder-only build example.
- [ ] Update `README.md` without real hashes, secrets, hostnames, or machine paths; rerun documentation assertions.
- [ ] Run focused tests, `corepack pnpm test`, `corepack pnpm quality:static`, `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm worker:build`, and `corepack pnpm build`.
- [ ] Build once with placeholder valid metadata, start the isolated artifact with hostile runtime overrides, and verify the Settings HTML still contains only embedded build values. Start isolated development on a non-main loopback port, GET all four localized Settings routes, and inspect the live browser DOM/copy interaction at desktop and mobile widths.
- [ ] Remove generated outputs, scan committed scope for environment files, logs, databases, archives, secrets, machine paths, and unapproved public fields; run `git diff --check` and confirm a clean status.
- [ ] Commit documentation/final adjustments and report exact evidence.
