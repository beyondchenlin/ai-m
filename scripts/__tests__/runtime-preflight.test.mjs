import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as runtimePreflight from '../runtime-preflight.mjs';

const { checkRuntime } = runtimePreflight;
const expectedNodeVersion = '22.16.0';
const expectedPnpmVersion = '10.12.1';
const scriptsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(scriptsDirectory, '..');
const preflightScript = path.join(scriptsDirectory, 'runtime-preflight.mjs');
const validUserAgent = `pnpm/${expectedPnpmVersion} npm/? node/v${expectedNodeVersion} ${process.platform} ${process.arch}`;

function check(overrides = {}) {
  return checkRuntime({
    projectRoot,
    activeNodeVersion: `v${expectedNodeVersion}`,
    activeExecutable: process.execPath,
    pnpmUserAgent: validUserAgent,
    launcherExecutable: process.execPath,
    readFile: () => `${expectedNodeVersion}\r\n`,
    runLauncher: () => `v${expectedNodeVersion}\r\n`,
    ...overrides,
  });
}

function cliEnvironment({ launcherExecutable = process.execPath, ...overrides } = {}) {
  const env = {
    ...process.env,
    npm_config_user_agent: validUserAgent,
    ...overrides,
  };
  delete env.npm_node_execpath;
  if (launcherExecutable !== null) {
    env.npm_node_execpath = launcherExecutable;
  }
  return env;
}

function runCli({ cwd, script = preflightScript, env = cliEnvironment() } = {}) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    env,
  });
}

test('accepts the exact Node and pnpm versions pinned by the project', () => {
  assert.deepEqual(check(), { ok: true, diagnostics: [] });
});

test('runs the launcher probe with bounded output and time', () => {
  let invocation;

  const result = check({
    runLauncher: (...args) => {
      invocation = args;
      return `v${expectedNodeVersion}`;
    },
  });

  assert.deepEqual(result, { ok: true, diagnostics: [] });
  assert.deepEqual(invocation, [
    process.execPath,
    ['-p', 'process.version'],
    {
      encoding: 'utf8',
      maxBuffer: 65_536,
      timeout: 3_000,
      windowsHide: true,
    },
  ]);
});

test('rejects the wrong active Node version', () => {
  const activeExecutable = path.join(path.parse(process.execPath).root, 'node24', 'node');
  const result = check({ activeNodeVersion: 'v24.1.0', activeExecutable });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes(`Active Node executable: ${activeExecutable}`));
  assert.ok(result.diagnostics.includes('Expected Node version: v22.16.0'));
});

test('rejects a pnpm version other than the packageManager pin', () => {
  const result = check({
    pnpmUserAgent: `pnpm/10.13.0 npm/? node/v${expectedNodeVersion}`,
  });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.includes('Detected package manager: pnpm 10.13.0'));
  assert.ok(result.diagnostics.includes('Expected pnpm version: 10.12.1'));
});

test('identifies npm and directs the user to pnpm through Corepack', () => {
  const result = check({ pnpmUserAgent: 'npm/10.9.0 node/v22.16.0' });
  const output = result.diagnostics.join('\n');

  assert.equal(result.ok, false);
  assert.match(output, /Detected package manager: npm 10\.9\.0/);
  assert.match(output, /This repository requires pnpm 10\.12\.1 through Corepack\./);
});

test('rejects a relative launcher path without executing it', () => {
  let called = false;
  const result = check({
    launcherExecutable: path.join('relative', 'node'),
    runLauncher: () => {
      called = true;
      return `v${expectedNodeVersion}`;
    },
  });

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join('\n'), /invalid \(expected an absolute executable path\)/);
});

test('rejects an absolute launcher whose basename is not node or node.exe', () => {
  let called = false;
  const launcherExecutable = path.join(path.parse(process.execPath).root, 'runtime', 'deno');
  const result = check({
    launcherExecutable,
    runLauncher: () => {
      called = true;
      return `v${expectedNodeVersion}`;
    },
  });

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.match(
    result.diagnostics.join('\n'),
    /invalid \(expected executable basename node or node\.exe\)/,
  );
});

test('accepts an uppercase node.exe launcher basename', () => {
  const launcherExecutable = path.join(path.parse(process.execPath).root, 'runtime', 'NODE.EXE');

  assert.deepEqual(
    check({ launcherExecutable }),
    { ok: true, diagnostics: [] },
  );
});

test('classifies a launcher timeout without exposing the raw error', () => {
  const timeoutError = new Error('secret\u001b[31m timeout detail');
  timeoutError.code = 'ETIMEDOUT';
  const result = check({
    runLauncher: () => {
      throw timeoutError;
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join('\n'), /timed out after 3000ms/);
  assert.doesNotMatch(result.diagnostics.join('\n'), /secret|\u001b/);
});

test('classifies launcher output overflow', () => {
  const overflowError = new Error('spawnSync node ENOBUFS');
  overflowError.code = 'ENOBUFS';
  const result = check({
    runLauncher: () => {
      throw overflowError;
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join('\n'), /output exceeded 65536 bytes/);
});

test('classifies empty launcher output as malformed without printing a bare v', () => {
  const result = check({ runLauncher: () => '' });
  const output = result.diagnostics.join('\n');

  assert.equal(result.ok, false);
  assert.match(output, /malformed \(expected a Node semantic version\)/);
  assert.doesNotMatch(output, /pnpm launcher Node version: v(?:\r?$)/m);
});

test('classifies malformed launcher output without echoing it', () => {
  const result = check({ runLauncher: () => 'not-node\n' });
  const output = result.diagnostics.join('\n');

  assert.equal(result.ok, false);
  assert.match(output, /malformed \(expected a Node semantic version\)/);
  assert.doesNotMatch(output, /not-node|vnot-node/);
});

test('classifies an unreadable launcher without exposing the raw error', () => {
  const unreadableError = new Error('access denied at a secret path');
  unreadableError.code = 'EACCES';
  const result = check({
    runLauncher: () => {
      throw unreadableError;
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join('\n'), /unreadable \(could not execute launcher; code EACCES\)/);
  assert.doesNotMatch(result.diagnostics.join('\n'), /secret path/);
  assert.match(result.diagnostics.join('\n'), /corepack pnpm install --frozen-lockfile/);
});

test('rejects a pnpm launcher that reports Node 24', () => {
  const result = check({ runLauncher: () => 'v24.1.0\n' });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join('\n'), /pnpm launcher Node version: v24\.1\.0/);
});

test('rejects an absent pnpm launcher', () => {
  const result = check({ launcherExecutable: null });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join('\n'), /pnpm launcher executable was not provided/);
});

test('reports a stable missing .node-version diagnostic', () => {
  const result = check({
    readFile: () => {
      throw new Error('secret filesystem path');
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.diagnostics.join('\n'), /Could not read \.node-version\./);
  assert.doesNotMatch(result.diagnostics.join('\n'), /secret filesystem path/);
});

test('sanitizes control characters from environment-derived diagnostics', () => {
  const result = check({
    activeNodeVersion: 'v24.1.0\u001b[31m',
    activeExecutable: `${process.execPath}\u001b[31m`,
    pnpmUserAgent: 'pnpm/10.13.0\u007f npm/?',
  });

  assert.equal(result.ok, false);
  for (const line of result.diagnostics) {
    assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/);
  }
});

test('successful CLI execution resolves the project pin independently of cwd', (t) => {
  const otherDirectory = mkdtempSync(path.join(os.tmpdir(), 'runtime-preflight-cwd-'));
  t.after(() => rmSync(otherDirectory, { force: true, recursive: true }));

  const result = runCli({ cwd: otherDirectory });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    `Runtime preflight passed: Node v${expectedNodeVersion}; pnpm ${expectedPnpmVersion}.`,
  );
  assert.equal(result.stderr, '');
});

test('CLI exits nonzero on a missing .node-version and writes diagnostics to stderr', (t) => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'runtime-preflight-missing-pin-'));
  const fixtureScripts = path.join(fixtureRoot, 'scripts');
  mkdirSync(fixtureScripts);
  const fixtureScript = path.join(fixtureScripts, 'runtime-preflight.mjs');
  copyFileSync(preflightScript, fixtureScript);
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));

  const result = runCli({ cwd: os.tmpdir(), script: fixtureScript });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Could not read \.node-version\./);
});

test('CLI exits nonzero when npm_node_execpath is absent', () => {
  const result = runCli({
    cwd: projectRoot,
    env: cliEnvironment({ launcherExecutable: null }),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /pnpm launcher executable was not provided/);
});

test('runtime pins and release-gate scripts stay consistent', () => {
  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const nodeVersion = readFileSync(path.join(projectRoot, '.node-version'), 'utf8').trim();
  const nextNodeMajor = Number(nodeVersion.split('.')[0]) + 1;

  assert.equal(runtimePreflight.EXPECTED_PNPM_VERSION, expectedPnpmVersion);
  assert.equal(packageJson.packageManager, `pnpm@${runtimePreflight.EXPECTED_PNPM_VERSION}`);
  assert.equal(packageJson.engines.node, `>=${nodeVersion} <${nextNodeMajor}`);
  assert.equal(
    packageJson.scripts['test:runtime'],
    'node --test scripts/__tests__/runtime-preflight.test.mjs',
  );
  assert.match(packageJson.scripts['quality:static'], /corepack pnpm test:runtime/);
  assert.match(packageJson.scripts.test, /--exclude scripts\/__tests__\/runtime-preflight\.test\.mjs/);
});
