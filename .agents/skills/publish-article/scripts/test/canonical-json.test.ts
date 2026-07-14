import { describe, expect, test } from "bun:test";
import { canonicalJson, digestCanonical } from "../src/canonical-json";

describe("canonicalJson", () => {
  test("sorts object keys recursively while preserving array order", () => {
    const value = { z: 1, a: { d: 4, b: 2 }, list: [{ y: 2, x: 1 }, 3] };
    expect(canonicalJson(value)).toBe('{"a":{"b":2,"d":4},"list":[{"x":1,"y":2},3],"z":1}\n');
  });

  test("produces a stable prefixed digest", () => {
    expect(digestCanonical({ b: 2, a: 1 })).toBe(digestCanonical({ a: 1, b: 2 }));
    expect(digestCanonical({ a: 2 })).not.toBe(digestCanonical({ a: 1 }));
    expect(digestCanonical({ a: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
