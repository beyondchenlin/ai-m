import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_PNPM_VERSION = '10.12.1';

function cleanVersion(version) {
  return String(version ?? '').trim().replace(/^v/, '');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function checkRuntime({
  projectRoot = process.cwd(),
  activeNodeVersion = process.version,
  activeExecutable = process.execPath,
  pnpmUserAgent = process.env.npm_config_user_agent,
  launcherExecutable = process.env.npm_node_execpath,
  readFile = readFileSync,
  runLauncher = execFileSync,
} = {}) {
  let expectedNodeVersion;
  let expectedNodeError;

  try {
    expectedNodeVersion = cleanVersion(
      readFile(path.join(projectRoot, '.node-version'), 'utf8'),
    );
  } catch (error) {
    expectedNodeError = errorMessage(error);
  }

  const activeVersion = cleanVersion(activeNodeVersion);
  const detectedPnpmVersion = /(?:^|\s)pnpm\/([^\s]+)/.exec(pnpmUserAgent ?? '')?.[1];
  let launcherNodeVersion;
  let launcherError;

  if (launcherExecutable) {
    try {
      launcherNodeVersion = cleanVersion(
        runLauncher(
          launcherExecutable,
          ['-p', 'process.version'],
          { encoding: 'utf8', windowsHide: true },
        ),
      );
    } catch (error) {
      launcherError = errorMessage(error);
    }
  }

  const failures = [];
  if (expectedNodeError) {
    failures.push(`Could not read .node-version: ${expectedNodeError}`);
  } else if (activeVersion !== expectedNodeVersion) {
    failures.push('The active Node version does not match .node-version.');
  }
  if (detectedPnpmVersion !== EXPECTED_PNPM_VERSION) {
    failures.push('pnpm does not match the packageManager pin.');
  }
  if (launcherError) {
    failures.push('The pnpm launcher Node executable could not be inspected.');
  } else if (launcherNodeVersion && launcherNodeVersion !== expectedNodeVersion) {
    failures.push('pnpm was launched by a different Node runtime.');
  }

  if (failures.length === 0) {
    return { ok: true, diagnostics: [] };
  }

  return {
    ok: false,
    diagnostics: [
      'Runtime preflight failed:',
      ...failures.map((failure) => `- ${failure}`),
      `Active Node executable: ${activeExecutable}`,
      `Active Node version: v${activeVersion || 'unknown'}`,
      `pnpm launcher executable: ${launcherExecutable || 'not provided'}`,
      `pnpm launcher Node version: ${
        launcherError
          ? `unreadable (${launcherError})`
          : launcherNodeVersion
            ? `v${launcherNodeVersion}`
            : 'not provided'
      }`,
      `Expected Node version: ${expectedNodeVersion ? `v${expectedNodeVersion}` : 'unavailable'}`,
      `Detected pnpm version: ${detectedPnpmVersion || 'unknown'}`,
      `Expected pnpm version: ${EXPECTED_PNPM_VERSION}`,
      `Recovery: from a Node ${expectedNodeVersion || '22'} shell, run "corepack enable", "corepack prepare pnpm@${EXPECTED_PNPM_VERSION} --activate", and "corepack pnpm install --frozen-lockfile"; then use "corepack pnpm <command>".`,
    ],
  };
}

function main() {
  const result = checkRuntime();
  if (!result.ok) {
    console.error(result.diagnostics.join('\n'));
    process.exitCode = 1;
    return;
  }

  const pnpmVersion = /(?:^|\s)pnpm\/([^\s]+)/.exec(
    process.env.npm_config_user_agent ?? '',
  )?.[1];
  console.log(
    `Runtime preflight passed: Node v${cleanVersion(process.version)}; pnpm ${pnpmVersion}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
