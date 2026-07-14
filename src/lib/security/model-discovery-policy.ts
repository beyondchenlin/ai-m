import dns from "node:dns/promises";
import net from "node:net";

export class ModelDiscoveryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelDiscoveryPolicyError";
  }
}

const OFFICIAL_HOSTS: Record<string, readonly string[]> = {
  openai: ["api.openai.com"],
  gemini: ["generativelanguage.googleapis.com"],
  seedance: ["ark.cn-beijing.volces.com"],
};

function configuredHostRules(): string[] {
  return (process.env.AI_M_MODEL_DISCOVERY_HOST_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function configuredPorts(): Set<string> {
  return new Set(
    (process.env.AI_M_MODEL_DISCOVERY_PORT_ALLOWLIST ?? "443")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function matchesHostRule(hostname: string, rule: string): boolean {
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === rule;
}

function isExplicitlyAllowedHost(hostname: string): boolean {
  return configuredHostRules().some((rule) => matchesHostRule(hostname, rule));
}

function isOfficialHost(protocol: string, hostname: string): boolean {
  return (OFFICIAL_HOSTS[protocol] ?? []).includes(hostname);
}

function parseIpv4(address: string): number[] | null {
  if (net.isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isHardBlockedIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) return false;
  const [a, b, c] = parts;
  return (
    a === 0
    || (a === 169 && b === 254)
    || (a === 192 && b === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0)
    || a >= 224
  );
}

function isPrivateIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) return false;
  const [a, b] = parts;
  return (
    a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
  );
}

function parseIpv6Groups(address: string): number[] | null {
  let normalized = address.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
  normalized = normalized.split("%")[0];
  if (net.isIP(normalized) !== 6) return null;

  const dottedMatch = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMatch) {
    const ipv4 = parseIpv4(dottedMatch[2]);
    if (!ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    normalized = `${dottedMatch[1]}${high}:${low}`;
  }

  const doubleColon = normalized.indexOf("::");
  if (doubleColon !== normalized.lastIndexOf("::")) return null;
  const left = doubleColon >= 0 ? normalized.slice(0, doubleColon) : normalized;
  const right = doubleColon >= 0 ? normalized.slice(doubleColon + 2) : "";
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const missing = 8 - leftGroups.length - rightGroups.length;
  if ((doubleColon < 0 && missing !== 0) || (doubleColon >= 0 && missing < 1)) return null;
  const raw = doubleColon >= 0
    ? [...leftGroups, ...Array.from({ length: missing }, () => "0"), ...rightGroups]
    : leftGroups;
  if (raw.length !== 8) return null;
  const groups = raw.map((group) => Number.parseInt(group || "0", 16));
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

function classifyIpv6(address: string): "public" | "private" | "blocked" | null {
  const groups = parseIpv6Groups(address);
  if (!groups) return null;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (groups.every((group) => group === 0)) return "blocked";
  if ((g0 & 0xffc0) === 0xfe80) return "blocked"; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return "blocked"; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return "blocked"; // documentation

  const ipv4Mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff);
  if (ipv4Mapped) {
    const ipv4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    if (isHardBlockedIpv4(ipv4)) return "blocked";
    return isPrivateIpv4(ipv4) ? "private" : "public";
  }

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return "private";
  if ((g0 & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique-local
  return "public";
}

function classifyAddress(address: string): "public" | "private" | "blocked" | null {
  if (net.isIP(address) === 4) {
    if (isHardBlockedIpv4(address)) return "blocked";
    return isPrivateIpv4(address) ? "private" : "public";
  }
  return classifyIpv6(address);
}

function exactHostExplicitlyAllowed(hostname: string): boolean {
  return configuredHostRules().some((rule) => !rule.startsWith("*.") && rule === hostname);
}

function privateTargetsAllowed(hostname: string): boolean {
  return process.env.AI_M_MODEL_DISCOVERY_ALLOW_PRIVATE_HOSTS === "true"
    && exactHostExplicitlyAllowed(hostname);
}

export interface ApprovedAddress {
  address: string;
  family: 4 | 6;
}

async function resolveApprovedAddresses(hostname: string): Promise<ApprovedAddress[]> {
  const allowPrivate = privateTargetsAllowed(hostname);
  if (net.isIP(hostname)) {
    const family = net.isIP(hostname) as 4 | 6;
    const classification = classifyAddress(hostname);
    if (classification === "blocked" || (classification === "private" && !allowPrivate)) {
      throw new ModelDiscoveryPolicyError("Model discovery host resolves to a blocked network address");
    }
    return [{ address: hostname, family }];
  }
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ModelDiscoveryPolicyError("Model discovery host could not be resolved");
  }
  if (!answers.length) throw new ModelDiscoveryPolicyError("Model discovery host could not be resolved");
  const approved: ApprovedAddress[] = [];
  for (const answer of answers) {
    const classification = classifyAddress(answer.address);
    if ((answer.family !== 4 && answer.family !== 6)
      || classification === null
      || classification === "blocked"
      || (classification === "private" && !allowPrivate)) {
      throw new ModelDiscoveryPolicyError("Model discovery host resolves to a blocked network address");
    }
    approved.push({ address: answer.address, family: answer.family as 4 | 6 });
  }
  return [...new Map(approved.map((answer) => [`${answer.family}:${answer.address}`, answer])).values()];
}

export interface ModelDiscoveryTarget {
  url: URL;
  hostname: string;
  addresses: ApprovedAddress[];
}

export async function resolveModelDiscoveryTarget(input: {
  protocol: string;
  baseUrl: string;
}): Promise<ModelDiscoveryTarget> {
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new ModelDiscoveryPolicyError("Base URL is invalid");
  }

  if (url.username || url.password) throw new ModelDiscoveryPolicyError("Base URL must not contain credentials");
  if (url.hash) throw new ModelDiscoveryPolicyError("Base URL must not contain a fragment");
  if (url.search) throw new ModelDiscoveryPolicyError("Base URL must not contain query parameters");

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const official = isOfficialHost(input.protocol, hostname);
  const explicitlyAllowed = isExplicitlyAllowedHost(hostname);
  if (!official && !explicitlyAllowed) {
    throw new ModelDiscoveryPolicyError(
      "Custom model discovery hosts must be explicitly allowed by AI_M_MODEL_DISCOVERY_HOST_ALLOWLIST",
    );
  }

  const allowHttp = process.env.AI_M_MODEL_DISCOVERY_ALLOW_HTTP === "true";
  if (url.protocol !== "https:" && !(allowHttp && explicitlyAllowed && url.protocol === "http:")) {
    throw new ModelDiscoveryPolicyError("Model discovery requires HTTPS unless an explicitly allowed HTTP host is configured");
  }

  const effectivePort = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!configuredPorts().has(effectivePort)) {
    throw new ModelDiscoveryPolicyError("Model discovery port is not allowed");
  }

  const addresses = await resolveApprovedAddresses(hostname);
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return { url, hostname, addresses };
}

export async function assertModelDiscoveryUrl(input: {
  protocol: string;
  baseUrl: string;
}): Promise<URL> {
  return (await resolveModelDiscoveryTarget(input)).url;
}
