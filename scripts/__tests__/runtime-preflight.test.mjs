import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkRuntime } from '../runtime-preflight.mjs';

const expectedNodeVersion = '22.16.0';
const expectedPnpmVersion = '10.12.1';

function check(overrides = {}) {
  return checkRuntime({
    projectRoot: 'C:\\repo',
    activeNodeVersion: `v${expectedNodeVersion}`,
    activeExecutable: 'C:\\node22\\node.exe',
    pnpmUserAgent: `pnpm/${expectedPnpmVersion} npm/? node/v${expectedNodeVersion} win32 x64`,
    launcherExecutable: 'C:\\node22\\node.exe',
    readFile: () => `${expectedNodeVersion}\r\n`,
    runLauncher: () => `v${expectedNodeVersion}\r\n`,
    ...overrides,
  });
}

test('accepts the exact Node and pnpm versions pinned by the project', () => {
  assert.deepEqual(check(), { ok: true, diagnostics: [] });
});

test('rejects the wrong active Node version', () => {
  const result = check({
    activeNodeVersion: 'v24.1.0',
    activeExecutable: 'C:\\node24\\node.exe',
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join('\n'), /Active Node executable: C:\\node24\\node\.exe/);
  assert.match(result.diagnostics.join('\n'), /Expected Node version: v22\.16\.0/);
});

test('rejects a pnpm version other than the packageManager pin', () => {
  const result = check({
    pnpmUserAgent: `pnpm/10.13.0 npm/? node/v${expectedNodeVersion} win32 x64`,
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join('\n'), /Detected pnpm version: 10\.13\.0/);
  assert.match(result.diagnostics.join('\n'), /Expected pnpm version: 10\.12\.1/);
});

test('rejects a pnpm launcher that reports Node 24', () => {
  const result = check({
    launcherExecutable: 'C:\\fnm\\node-versions\\v24.1.0\\installation\\node.exe',
    runLauncher: () => 'v24.1.0\n',
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join('\n'), /pnpm launcher Node version: v24\.1\.0/);
  assert.match(result.diagnostics.join('\n'), /pnpm launcher executable: C:\\fnm\\node-versions/);
});

test('rejects an unreadable pnpm launcher', () => {
  const result = check({
    launcherExecutable: 'C:\\stale\\node.exe',
    runLauncher: () => {
      throw new Error('access denied');
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join('\n'), /pnpm launcher Node version: unreadable \(access denied\)/);
  assert.match(result.diagnostics.join('\n'), /corepack pnpm/);
});

test('accepts a pnpm launcher that reports the pinned Node 22 version', () => {
  assert.deepEqual(
    check({
      launcherExecutable: 'C:\\fnm\\node-versions\\v22.16.0\\installation\\node.exe',
      runLauncher: (_executable, args) => {
        assert.deepEqual(args, ['-p', 'process.version']);
        return 'v22.16.0\n';
      },
    }),
    { ok: true, diagnostics: [] },
  );
});
