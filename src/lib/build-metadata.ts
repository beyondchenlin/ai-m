export type PublicBuildMetadata = Readonly<{
  version: string;
  commit: string | null;
  buildTime: string | null;
}>;

export type BuildMetadataInput = Readonly<{
  packageVersion: string;
  commit?: string;
  buildTime?: string;
}>;

export type EmbeddedBuildEnvironment = Readonly<{
  AI_M_INTERNAL_EMBEDDED_VERSION?: string;
  AI_M_INTERNAL_EMBEDDED_COMMIT?: string;
  AI_M_INTERNAL_EMBEDDED_BUILD_TIME?: string;
}>;

export type VersionSummaryLabels = Readonly<{
  appName: string;
  version: string;
  commit: string;
  buildTime: string;
  development: string;
  notProvided: string;
}>;

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;
const CANONICAL_UTC_MILLISECONDS_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function validateVersion(version: string): string {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error("package.json version must be strict SemVer 2.0.0");
  }
  return version;
}

function validateCommit(commit: string | undefined): string | null {
  if (commit === undefined || commit === "") return null;
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error("AI_M_BUILD_COMMIT must contain 7 to 64 hexadecimal characters");
  }
  return commit.toLowerCase();
}

function validateBuildTime(buildTime: string | undefined): string | null {
  if (buildTime === undefined || buildTime === "") return null;
  if (!CANONICAL_UTC_MILLISECONDS_PATTERN.test(buildTime)) {
    throw new Error("Build time (AI_M_BUILD_TIME) must be canonical UTC ISO 8601 with millisecond precision");
  }
  const parsed = new Date(buildTime);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== buildTime) {
    throw new Error("AI_M_BUILD_TIME must be a valid canonical build time");
  }
  return buildTime;
}

export function resolveBuildMetadata(input: BuildMetadataInput): PublicBuildMetadata {
  return Object.freeze({
    version: validateVersion(input.packageVersion),
    commit: validateCommit(input.commit),
    buildTime: validateBuildTime(input.buildTime),
  });
}

export function readEmbeddedBuildMetadata(
  environment: EmbeddedBuildEnvironment = {
    AI_M_INTERNAL_EMBEDDED_VERSION: process.env.AI_M_INTERNAL_EMBEDDED_VERSION,
    AI_M_INTERNAL_EMBEDDED_COMMIT: process.env.AI_M_INTERNAL_EMBEDDED_COMMIT,
    AI_M_INTERNAL_EMBEDDED_BUILD_TIME: process.env.AI_M_INTERNAL_EMBEDDED_BUILD_TIME,
  },
): PublicBuildMetadata {
  return resolveBuildMetadata({
    packageVersion: environment.AI_M_INTERNAL_EMBEDDED_VERSION ?? "",
    commit: environment.AI_M_INTERNAL_EMBEDDED_COMMIT,
    buildTime: environment.AI_M_INTERNAL_EMBEDDED_BUILD_TIME,
  });
}

export function shortCommit(commit: string | null): string | null {
  return commit === null ? null : commit.slice(0, 12);
}

export function formatVersionSummary(
  metadata: PublicBuildMetadata,
  labels: VersionSummaryLabels,
): string {
  return `${labels.appName} — ${labels.version} ${metadata.version}; ${labels.commit} ${metadata.commit ?? labels.development}; ${labels.buildTime} ${metadata.buildTime ?? labels.notProvided}`;
}
