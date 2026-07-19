import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize, sha256Bytes, sha256Canonical } from "../canonical";

describe("RFC 8785-style canonical JSON", () => {
  it("uses deterministic property ordering, escaping and ECMAScript numbers", () => {
    expect(canonicalize({
      numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27, -0],
      string: "€$\u000f\nA'B\"\\\\\"/",
      literals: [null, true, false],
    })).toBe(
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],"
      + "\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}",
    );
  });

  it("sorts object keys by UTF-16 code units", () => {
    expect(canonicalize({ "€": 1, "\r": 2, "דּ": 3, "1": 4, "😀": 5, "\u0080": 6, "ö": 7 }))
      .toBe("{\"\\r\":2,\"1\":4,\"\u0080\":6,\"ö\":7,\"€\":1,\"😀\":5,\"דּ\":3}");
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["undefined", undefined],
    ["function", () => undefined],
    ["symbol", Symbol("invalid")],
    ["lone high surrogate", "\ud800"],
    ["lone low surrogate", "\udc00"],
    ["lone surrogate key", { "\ud800": true }],
  ])("rejects %s", (_name, value) => {
    expect(() => canonicalize(value)).toThrow(TypeError);
  });

  it("rejects sparse arrays and cycles but permits a repeated acyclic value", () => {
    const sparse = Array(2);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const shared = { value: 1 };
    expect(() => canonicalize(sparse)).toThrow(/sparse/i);
    expect(() => canonicalize(cyclic)).toThrow(/cycles/i);
    expect(canonicalize([shared, shared])).toBe('[{"value":1},{"value":1}]');
  });

  it("separates canonical-data and raw-byte APIs while preserving digest bytes", () => {
    const expected = `sha256:${createHash("sha256").update("null").digest("hex")}`;
    expect(sha256Canonical(null)).toBe(expected);
    expect(sha256Bytes(Buffer.from("null"))).toBe(expected);
    expect(sha256Canonical("null")).not.toBe(sha256Bytes(Buffer.from("null")));
  });
});
