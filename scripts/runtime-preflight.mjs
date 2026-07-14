import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EXPECTED_PNPM_VERSION = '10.12.1';

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_MAX_BUFFER = 65_536;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const HAS_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const NODE_VERSION_OUTPUT = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function sanitize(value, fallback = 'unknown') {
  const sanitized = String(value ?? '').replace(CONTROL_CHARACTERS, '?');
  return sanitized || fallback;
}

function cleanVersion(version) {
  return sanitize(String(version ?? '').trim(), '').replace(/^v/, '');
}

function parsePackageManager(userAgent) {
  const sanitizedUserAgent = sanitize(userAgent, '').trim();
  const match = /^([A-Za-z0-9._-]+)\/([^\s]+)/.exec(sanitizedUserAgent);
  return match ? { name: match[1], version: match[2] } : undefined;
}

function classifyProbeError(error) {
  if (error?.code === 'ETIMEDOUT' || (error?.killed && error?.signal)) {
    return { kind: 'timeout' };
  }
  if (error?.code === 'ENOBUFS') {
    return { kind: 'overflow' };
  }
  return { kind: 'unreadable', code: sanitize(error?.code, 'UNKNOWN') };
}

function formatProbeResult(probe) {
  switch (probe.kind) {
    case 'version':
      return `v${probe.version}`;
    case 'missing':
      return 'not provided';
    case 'invalid-path':
      return 'invalid (expected an absolute executable path)';
    case 'invalid-basename':
      return 'invalid (expected executable basename node or node.exe)';
    case 'malformed':
      return 'malformed (expected a Node semantic version)';
    case 'timeout':
      return `timed out after ${PROBE_TIMEOUT_MS}ms`;
    case 'overflow':
      return `unreadable (output exceeded ${PROBE_MAX_BUFFER} bytes)`;
    default:
      return `unreadable (could not execute launcher; code ${probe.code})`;
  }
}

export function checkRuntime({
  projectRoot = DEFAULT_PROJECT_ROOT,
  activeNodeVersion = process.version,
  activeExecutable = process.execPath,
  pnpmUserAgent = process.env.npm_config_user_agent,
  launcherExecutable = process.env.npm_node_execpath,
  readFile = readFileSync,
  runLauncher = execFileSync,
} = {}) {
  let expectedNodeVersion;
  let expectedNodeReadable = true;

  try {
    expectedNodeVersion = cleanVersion(
      readFile(path.join(projectRoot, '.node-version'), 'utf8'),
    );
  } catch {
    expectedNodeReadable = false;
  }

  const activeVersion = cleanVersion(activeNodeVersion);
  const packageManager = parsePackageManager(pnpmUserAgent);
  let launcherProbe;

  if (!launcherExecutable) {
    launcherProbe = { kind: 'missing' };
  } else if (
    typeof launcherExecutable !== 'string'
    || !path.isAbsolute(launcherExecutable)
    || HAS_CONTROL_CHARACTERS.test(launcherExecutable)
  ) {
    launcherProbe = { kind: 'invalid-path' };
  } else if (!['node', 'node.exe'].includes(path.basename(launcherExecutable).toLowerCase())) {
    launcherProbe = { kind: 'invalid-basename' };
  } else {
    try {
      const output = String(
        runLauncher(
          launcherExecutable,
          ['-p', 'process.version'],
          {
            encoding: 'utf8',
            maxBuffer: PROBE_MAX_BUFFER,
            timeout: PROBE_TIMEOUT_MS,
            windowsHide: true,
          },
        ),
      ).trim();
      launcherProbe = NODE_VERSION_OUTPUT.test(output)
        ? { kind: 'version', version: output.slice(1) }
        : { kind: 'malformed' };
    } catch (error) {
      launcherProbe = classifyProbeError(error);
    }
  }

  const failures = [];
  if (!expectedNodeReadable || !expectedNodeVersion) {
    failures.push('Could not read .node-version.');
  } else if (activeVersion !== expectedNodeVersion) {
    failures.push('The active Node version does not match .node-version.');
  }

  if (packageManager?.name === 'npm') {
    failures.push(
      `This repository requires pnpm ${EXPECTED_PNPM_VERSION} through Corepack. npm is not supported.`,
    );
  } else if (packageManager?.name !== 'pnpm') {
    failures.push(
      `This repository requires pnpm ${EXPECTED_PNPM_VERSION} through Corepack; the package manager could not be identified.`,
    );
  } else if (packageManager.version !== EXPECTED_PNPM_VERSION) {
    failures.push('pnpm does not match the packageManager pin.');
  }

  if (launcherProbe.kind === 'missing') {
    failures.push('The pnpm launcher executable was not provided.');
  } else if (
    launcherProbe.kind === 'invalid-path'
    || launcherProbe.kind === 'invalid-basename'
  ) {
    failures.push('The pnpm launcher executable path is invalid.');
  } else if (launcherProbe.kind !== 'version') {
    failures.push('The pnpm launcher Node executable could not be inspected.');
  } else if (
    expectedNodeVersion
    && launcherProbe.version !== expectedNodeVersion
  ) {
    failures.push('pnpm was launched by a different Node runtime.');
  }

  if (failures.length === 0) {
    return { ok: true, diagnostics: [] };
  }

  const detectedPackageManager = packageManager
    ? `${sanitize(packageManager.name)} ${sanitize(packageManager.version)}`
    : 'unidentified';
  const diagnostics = [
    'Runtime preflight failed:',
    ...failures.map((failure) => `- ${failure}`),
    `Active Node executable: ${sanitize(activeExecutable)}`,
    `Active Node version: v${activeVersion || 'unknown'}`,
    `pnpm launcher executable: ${sanitize(launcherExecutable, 'not provided')}`,
    `pnpm launcher Node version: ${formatProbeResult(launcherProbe)}`,
    `Expected Node version: ${expectedNodeVersion ? `v${expectedNodeVersion}` : 'unavailable'}`,
    `Detected package manager: ${detectedPackageManager}`,
    `Expected pnpm version: ${EXPECTED_PNPM_VERSION}`,
    `Recovery: from a Node ${expectedNodeVersion || '22'} shell, run "corepack enable", "corepack prepare pnpm@${EXPECTED_PNPM_VERSION} --activate", and "corepack pnpm install --frozen-lockfile"; then use "corepack pnpm <command>".`,
  ].map((line) => sanitize(line));

  return { ok: false, diagnostics };
}

function main() {
  const result = checkRuntime();
  if (!result.ok) {
    console.error(result.diagnostics.join('\n'));
    process.exitCode = 1;
    return;
  }

  const packageManager = parsePackageManager(process.env.npm_config_user_agent);
  console.log(
    `Runtime preflight passed: Node v${cleanVersion(process.version)}; pnpm ${packageManager.version}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
