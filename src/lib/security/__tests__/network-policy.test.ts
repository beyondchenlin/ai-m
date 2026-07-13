/**
 * PR-11: SSRF 防护与网络策略测试
 */

import { describe, it, expect } from "vitest";
import {
  validateUrl,
  validateBackendUrl,
  noRedirectFetchOptions,
  isRedirectResponse,
} from "../network-policy";

describe("PR-11: SSRF URL 校验", () => {
  it("应拒绝空 URL", () => {
    const result = validateUrl("   ", { allowRedirect: false, allowedHosts: [], allowedCidrs: [] });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("URL is empty");
  });

  it("应拒绝非法 URL", () => {
    const result = validateUrl("not a url", { allowRedirect: false, allowedHosts: [], allowedCidrs: [] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid URL/);
  });

  it("应拒绝非 http/https 协议", () => {
    const result = validateUrl("ftp://example.com", { allowRedirect: false, allowedHosts: [], allowedCidrs: [] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Protocol not allowed/);
  });

  it("应拒绝云元数据地址", () => {
    for (const host of ["169.254.169.254", "metadata.google.internal", "metadata.tencentyun.com", "100.100.100.200"]) {
      const result = validateUrl(`http://${host}/latest/meta-data/`, {
        allowRedirect: false,
        allowedHosts: [],
        allowedCidrs: [],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/Blocked metadata/);
    }
  });

  it("应拒绝私有与环回 IP 网段", () => {
    const blocked = [
      "http://127.0.0.1:8188",
      "http://10.0.0.1:8188",
      "http://172.16.0.1:8188",
      "http://192.168.1.1:8188",
      "http://0.0.0.0:8188",
    ];
    for (const url of blocked) {
      const result = validateUrl(url, { allowRedirect: false, allowedHosts: [], allowedCidrs: [] });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/Blocked IP range/);
    }
  });

  it("localhost 在通用 URL 校验中不被默认阻止（由后端拓扑规则控制）", () => {
    const result = validateUrl("http://localhost:8188", { allowRedirect: false, allowedHosts: [], allowedCidrs: [] });
    expect(result.valid).toBe(true);
  });

  it("白名单为空时不限制主机名", () => {
    const result = validateUrl("http://example.com", { allowRedirect: false, allowedHosts: [], allowedCidrs: [] });
    expect(result.valid).toBe(true);
  });

  it("应遵守主机名白名单", () => {
    const policy = { allowRedirect: false, allowedHosts: ["example.com"], allowedCidrs: [] };
    expect(validateUrl("http://example.com", policy).valid).toBe(true);
    expect(validateUrl("http://sub.example.com", policy).valid).toBe(false);
  });

  it("应支持后缀匹配白名单", () => {
    const policy = { allowRedirect: false, allowedHosts: [".example.com"], allowedCidrs: [] };
    expect(validateUrl("http://api.example.com", policy).valid).toBe(true);
    expect(validateUrl("http://example.com", policy).valid).toBe(false);
    expect(validateUrl("http://evil-example.com", policy).valid).toBe(false);
  });
});

describe("PR-11: 后端 baseUrl 校验", () => {
  it("same-host 拓扑只允许 localhost / 127.0.0.1", () => {
    expect(validateBackendUrl("http://localhost:8188", "same-host").valid).toBe(true);
    expect(validateBackendUrl("http://127.0.0.1:8188", "same-host").valid).toBe(true);
    expect(validateBackendUrl("http://192.168.1.1:8188", "same-host").valid).toBe(false);
  });

  it("lan-remote 拓扑应拒绝私有地址", () => {
    expect(validateBackendUrl("http://10.0.0.1:8188", "lan-remote").valid).toBe(false);
    expect(validateBackendUrl("http://172.16.0.1:8188", "lan-remote").valid).toBe(false);
    expect(validateBackendUrl("http://192.168.1.1:8188", "lan-remote").valid).toBe(false);
  });

  it("lan-remote 拓扑应允许公网地址", () => {
    expect(validateBackendUrl("http://8.8.8.8:8188", "lan-remote").valid).toBe(true);
  });

  it("应拒绝空 baseUrl", () => {
    expect(validateBackendUrl("  ", "same-host").valid).toBe(false);
  });

  it("应拒绝非法协议", () => {
    expect(validateBackendUrl("ftp://localhost:8188", "same-host").valid).toBe(false);
  });

  it("应拒绝云元数据地址", () => {
    expect(validateBackendUrl("http://169.254.169.254", "lan-remote").valid).toBe(false);
  });
});

describe("PR-11: 请求级策略", () => {
  it("应返回 manual 重定向", () => {
    const options = noRedirectFetchOptions();
    expect(options.redirect).toBe("manual");
  });

  it("应正确识别重定向状态码", () => {
    expect(isRedirectResponse(300)).toBe(true);
    expect(isRedirectResponse(301)).toBe(true);
    expect(isRedirectResponse(399)).toBe(true);
    expect(isRedirectResponse(200)).toBe(false);
    expect(isRedirectResponse(400)).toBe(false);
    expect(isRedirectResponse(500)).toBe(false);
  });
});
