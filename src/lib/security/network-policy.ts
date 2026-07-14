/**
 * Backend network policy and SSRF protection.
 *
 * Registration performs both syntactic validation and DNS resolution. Runtime
 * transports must revalidate immediately before connecting because DNS answers
 * can change after registration.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type BackendTopology = "same-host" | "container-to-host" | "same-host-container" | "lan-remote";

export interface NetworkPolicy {
  allowRedirect: boolean;
  allowedHosts: string[];
  allowedCidrs: string[];
  allowedPorts?: number[];
}

export interface AddressValidationResult {
  valid: boolean;
  resolvedAddresses: string[];
  errors: string[];
}

export type BackendAddressResolver = (
  hostname: string,
) => Promise<readonly { address: string; family: 4 | 6 }[]>;

const METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.azure.internal",
  "metadata.tencentyun.com",
  "instance-data.ec2.internal",
]);

const METADATA_IPS = new Set(["169.254.169.254", "100.100.100.200"]);

export function canonicalizeUrlHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

export function canonicalizeSocketAddress(address: string): string {
  const value = canonicalizeUrlHostname(address);
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6) throw new Error(`Invalid network address: ${address}`);
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function envList(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function allowedPorts(): number[] {
  return envList("AI_M_BACKEND_PORT_ALLOWLIST", "8188,8190")
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);
}

function parseIPv4(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((acc, item) => (acc << 8) + Number(item), 0) >>> 0;
}

function ipv4InCidr(address: string, cidr: string): boolean {
  const [networkText, prefixText] = cidr.split("/");
  const addressNumber = parseIPv4(address);
  const networkNumber = parseIPv4(networkText ?? "");
  const prefix = Number(prefixText);
  if (addressNumber === null || networkNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressNumber & mask) === (networkNumber & mask);
}

function isLoopback(address: string): boolean {
  return address === "::1" || ipv4InCidr(address, "127.0.0.0/8");
}

function isLinkLocal(address: string): boolean {
  if (isIP(address) === 4) return ipv4InCidr(address, "169.254.0.0/16");
  return address.toLowerCase().startsWith("fe8")
    || address.toLowerCase().startsWith("fe9")
    || address.toLowerCase().startsWith("fea")
    || address.toLowerCase().startsWith("feb");
}

function isPrivate(address: string): boolean {
  if (isIP(address) === 4) {
    return ipv4InCidr(address, "10.0.0.0/8")
      || ipv4InCidr(address, "172.16.0.0/12")
      || ipv4InCidr(address, "192.168.0.0/16");
  }
  return address.toLowerCase().startsWith("fc") || address.toLowerCase().startsWith("fd");
}

function isUnspecified(address: string): boolean {
  return address === "0.0.0.0" || address === "::";
}

function isMetadataAddress(address: string): boolean {
  return METADATA_IPS.has(address) || address === "fd00:ec2::254";
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const normalized = canonicalizeUrlHostname(hostname);
  return allowedHosts.some((allowed) => {
    const value = allowed.toLowerCase();
    return normalized === value || (value.startsWith(".") && normalized.endsWith(value));
  });
}

function addressAllowedForTopology(address: string, topology: BackendTopology): boolean {
  if (isUnspecified(address) || isLinkLocal(address) || isMetadataAddress(address)) return false;
  switch (topology) {
    case "same-host":
      return isLoopback(address);
    case "container-to-host":
    case "same-host-container":
      return isPrivate(address) || isLoopback(address);
    case "lan-remote": {
      const cidrs = envList("AI_M_LAN_CIDR_ALLOWLIST", "192.168.0.0/16,10.0.0.0/8,172.16.0.0/12");
      if (isIP(address) === 4) return cidrs.some((cidr) => ipv4InCidr(address, cidr));
      return isPrivate(address);
    }
  }
}

function parseAndValidateUrl(baseUrl: string): { url?: URL; errors: string[] } {
  const errors: string[] = [];
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return { errors: ["Invalid backend URL"] };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") errors.push("Only HTTP and HTTPS are allowed");
  if (url.username || url.password) errors.push("Credentials must not be embedded in the URL");
  if (url.hash) errors.push("URL fragments are not allowed");
  if (url.search) errors.push("URL query parameters are not allowed");
  const hostname = canonicalizeUrlHostname(url.hostname);
  if (METADATA_HOSTNAMES.has(hostname) || METADATA_IPS.has(hostname)) {
    errors.push("Cloud metadata endpoints are forbidden");
  }
  const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
  if (!allowedPorts().includes(port)) errors.push(`Port ${port} is not in AI_M_BACKEND_PORT_ALLOWLIST`);
  return { url, errors };
}

export function validateBackendUrl(
  baseUrl: string,
  topology: string,
): { valid: boolean; error?: string } {
  if (!["same-host", "container-to-host", "same-host-container", "lan-remote"].includes(topology)) {
    return { valid: false, error: "Unsupported backend topology" };
  }
  const parsed = parseAndValidateUrl(baseUrl);
  if (!parsed.url || parsed.errors.length > 0) return { valid: false, error: parsed.errors.join("; ") };
  const rawHostname = canonicalizeUrlHostname(parsed.url.hostname);
  const hostname = isIP(rawHostname) ? canonicalizeSocketAddress(rawHostname) : rawHostname;
  const topologyValue = topology as BackendTopology;

  if (topologyValue === "same-host" && !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    return { valid: false, error: "same-host backends must use a loopback hostname" };
  }
  if (topologyValue === "container-to-host"
      && !hostAllowed(hostname, envList("AI_M_CONTAINER_HOST_ALLOWLIST", "host.docker.internal"))) {
    return { valid: false, error: "container-to-host hostname is not allowlisted" };
  }
  if (topologyValue === "same-host-container"
      && !hostAllowed(hostname, envList("AI_M_CONTAINER_SERVICE_ALLOWLIST", "comfyui,comfyui-image,comfyui-speech"))) {
    return { valid: false, error: "container service hostname is not allowlisted" };
  }
  if (topologyValue === "lan-remote" && !isIP(hostname)
      && !hostAllowed(hostname, envList("AI_M_LAN_HOST_ALLOWLIST", ""))) {
    return { valid: false, error: "lan-remote hostnames require an explicit AI_M_LAN_HOST_ALLOWLIST entry" };
  }
  if (isIP(hostname) && !addressAllowedForTopology(hostname, topologyValue)) {
    return { valid: false, error: `Address ${hostname} is not allowed for topology ${topology}` };
  }
  return { valid: true };
}

export async function validateBackendUrlResolved(
  baseUrl: string,
  topology: BackendTopology,
  resolver: BackendAddressResolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true }))
    .filter((entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6),
): Promise<AddressValidationResult> {
  const initial = validateBackendUrl(baseUrl, topology);
  if (!initial.valid) return { valid: false, resolvedAddresses: [], errors: [initial.error ?? "Invalid URL"] };
  const url = new URL(baseUrl.trim());
  const rawHostname = canonicalizeUrlHostname(url.hostname);
  const hostname = isIP(rawHostname) ? canonicalizeSocketAddress(rawHostname) : rawHostname;
  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = (await resolver(hostname)).map((entry) => entry.address);
    } catch {
      return { valid: false, resolvedAddresses: [], errors: ["Backend hostname cannot be resolved"] };
    }
  }
  let unique: string[];
  try {
    unique = [...new Set(addresses.map(canonicalizeSocketAddress))];
  } catch {
    return { valid: false, resolvedAddresses: [], errors: ["Backend hostname resolved to an invalid address"] };
  }
  const errors = unique
    .filter((address) => !addressAllowedForTopology(address, topology))
    .map((address) => `Resolved address ${address} is not allowed for topology ${topology}`);
  if (unique.length === 0) errors.push("Backend hostname resolved to no addresses");
  return { valid: errors.length === 0, resolvedAddresses: unique, errors };
}

export function validateUrl(urlString: string, policy: NetworkPolicy): AddressValidationResult {
  const parsed = parseAndValidateUrl(urlString);
  if (!parsed.url) return { valid: false, resolvedAddresses: [], errors: parsed.errors };
  const errors = [...parsed.errors];
  const hostname = canonicalizeUrlHostname(parsed.url.hostname);
  if (policy.allowedHosts.length > 0 && !hostAllowed(hostname, policy.allowedHosts)) {
    errors.push("Hostname is not allowlisted");
  }
  const port = parsed.url.port ? Number(parsed.url.port) : (parsed.url.protocol === "https:" ? 443 : 80);
  if (policy.allowedPorts?.length && !policy.allowedPorts.includes(port)) errors.push("Port is not allowlisted");
  return { valid: errors.length === 0, resolvedAddresses: [hostname], errors };
}

export function noRedirectFetchOptions(): RequestInit {
  return { redirect: "manual" };
}

export function isRedirectResponse(status: number): boolean {
  return status >= 300 && status < 400;
}

export function getRequestNetworkPolicy(policy: NetworkPolicy): RequestInit {
  return policy.allowRedirect ? {} : { redirect: "manual" };
}
