import { afterEach, describe, expect, it } from "vitest";
import {
  validateUrl,
  validateBackendUrl,
  validateBackendUrlResolved,
  noRedirectFetchOptions,
  isRedirectResponse,
} from "../network-policy";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("PR-12: SSRF URL 校验", () => {
  it("拒绝空 URL、非法 URL 与非 HTTP 协议", () => {
    expect(validateUrl("   ", { allowRedirect: false, allowedHosts: [], allowedCidrs: [] }).valid).toBe(false);
    expect(validateUrl("not a url", { allowRedirect: false, allowedHosts: [], allowedCidrs: [] }).valid).toBe(false);
    expect(validateUrl("ftp://example.com:8188", { allowRedirect: false, allowedHosts: [], allowedCidrs: [] }).valid).toBe(false);
  });

  it("拒绝云元数据地址", () => {
    for (const host of ["169.254.169.254", "metadata.google.internal", "metadata.tencentyun.com", "100.100.100.200"]) {
      const result = validateUrl(`http://${host}:8188/latest/meta-data/`, {
        allowRedirect: false,
        allowedHosts: [],
        allowedCidrs: [],
      });
      expect(result.valid).toBe(false);
    }
  });

  it("通用校验遵守主机和端口白名单", () => {
    const policy = {
      allowRedirect: false,
      allowedHosts: ["example.com"],
      allowedCidrs: [],
      allowedPorts: [8188],
    };
    expect(validateUrl("http://example.com:8188", policy).valid).toBe(true);
    expect(validateUrl("http://sub.example.com:8188", policy).valid).toBe(false);
    expect(validateUrl("http://example.com:9000", policy).valid).toBe(false);
  });

  it("后缀白名单只匹配真实子域名", () => {
    const policy = { allowRedirect: false, allowedHosts: [".example.com"], allowedCidrs: [], allowedPorts: [8188] };
    expect(validateUrl("http://api.example.com:8188", policy).valid).toBe(true);
    expect(validateUrl("http://example.com:8188", policy).valid).toBe(false);
    expect(validateUrl("http://evil-example.com:8188", policy).valid).toBe(false);
  });
});

describe("PR-12: 后端拓扑校验", () => {
  it("validates every address returned by the dial-time resolver", async () => {
    process.env.AI_M_CONTAINER_SERVICE_ALLOWLIST = "comfy.policy.test";
    const resolver = async () => [{ address: "169.254.169.254", family: 4 as const }];
    const result = await validateBackendUrlResolved(
      "http://comfy.policy.test:8188",
      "same-host-container",
      resolver,
    );

    expect(result.valid).toBe(false);
    expect(result.resolvedAddresses).toEqual(["169.254.169.254"]);
    expect(result.errors).toEqual([
      "Resolved address 169.254.169.254 is not allowed for topology same-host-container",
    ]);
  });

  it("treats a resolver's mapped IPv4 loopback as the canonical loopback address", async () => {
    const result = await validateBackendUrlResolved(
      "http://localhost:8188",
      "same-host",
      async () => [{ address: "::ffff:127.0.0.1", family: 6 }],
    );

    expect(result).toEqual({ valid: true, resolvedAddresses: ["127.0.0.1"], errors: [] });
  });

  it("same-host 只允许回环主机", () => {
    expect(validateBackendUrl("http://localhost:8188", "same-host").valid).toBe(true);
    expect(validateBackendUrl("http://127.0.0.1:8188", "same-host").valid).toBe(true);
    expect(validateBackendUrl("http://192.168.1.1:8188", "same-host").valid).toBe(false);
    expect(validateBackendUrl("http://[::1]:8188", "same-host").valid).toBe(true);
  });

  it("container-to-host 与同容器网络必须使用显式主机白名单", () => {
    process.env.AI_M_CONTAINER_HOST_ALLOWLIST = "host.docker.internal";
    process.env.AI_M_CONTAINER_SERVICE_ALLOWLIST = "comfyui-image,comfyui-speech";
    expect(validateBackendUrl("http://host.docker.internal:8188", "container-to-host").valid).toBe(true);
    expect(validateBackendUrl("http://evil.internal:8188", "container-to-host").valid).toBe(false);
    expect(validateBackendUrl("http://comfyui-image:8188", "same-host-container").valid).toBe(true);
    expect(validateBackendUrl("http://database:8188", "same-host-container").valid).toBe(false);
  });

  it("lan-remote 只允许配置网段中的私有地址", () => {
    process.env.AI_M_LAN_CIDR_ALLOWLIST = "192.168.20.0/24";
    expect(validateBackendUrl("http://192.168.20.8:8188", "lan-remote").valid).toBe(true);
    expect(validateBackendUrl("http://192.168.1.8:8188", "lan-remote").valid).toBe(false);
    expect(validateBackendUrl("http://8.8.8.8:8188", "lan-remote").valid).toBe(false);
  });

  it("lan-remote 域名需要显式白名单", () => {
    delete process.env.AI_M_LAN_HOST_ALLOWLIST;
    expect(validateBackendUrl("http://gpu.home.arpa:8188", "lan-remote").valid).toBe(false);
    process.env.AI_M_LAN_HOST_ALLOWLIST = "gpu.home.arpa";
    expect(validateBackendUrl("http://gpu.home.arpa:8188", "lan-remote").valid).toBe(true);
  });

  it("拒绝凭据内嵌、元数据地址和非批准端口", () => {
    expect(validateBackendUrl("http://user:pass@localhost:8188", "same-host").valid).toBe(false);
    expect(validateBackendUrl("http://169.254.169.254:8188", "lan-remote").valid).toBe(false);
    expect(validateBackendUrl("http://localhost:9000", "same-host").valid).toBe(false);
  });

  it("allows a base path but rejects backend URL query semantics", () => {
    expect(validateBackendUrl("http://localhost:8188/comfy", "same-host").valid).toBe(true);
    expect(validateBackendUrl("http://localhost:8188/comfy?alternate=authority", "same-host").valid).toBe(false);
  });
});

describe("PR-12: 请求级策略", () => {
  it("固定为手动处理重定向", () => {
    expect(noRedirectFetchOptions().redirect).toBe("manual");
  });

  it("正确识别重定向状态码", () => {
    expect(isRedirectResponse(300)).toBe(true);
    expect(isRedirectResponse(301)).toBe(true);
    expect(isRedirectResponse(399)).toBe(true);
    expect(isRedirectResponse(200)).toBe(false);
    expect(isRedirectResponse(400)).toBe(false);
  });
});
