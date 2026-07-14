import { describe, expect, test } from "bun:test";
import { PublisherRegistry } from "../src/registry";
import type { PublisherEndpoint } from "../src/types";

function endpoint(id: string): PublisherEndpoint {
  return {
    id,
    capabilities: { draft: false, publish: true, update: false, imageUpload: false, status: true },
    async preflight() { return { ok: true }; },
    async prepare() { throw new Error("not used"); },
    async publish() { throw new Error("not used"); },
    async status() { return { state: "unknown" }; },
  };
}

describe("PublisherRegistry", () => {
  test("registers, lists and resolves explicit endpoint factories", () => {
    const registry = new PublisherRegistry()
      .register("wechat", () => endpoint("wechat"))
      .register("blog", () => endpoint("blog"));
    expect(registry.list()).toEqual(["blog", "wechat"]);
    expect(registry.resolve("blog").id).toBe("blog");
  });

  test("rejects duplicate and unknown endpoints", () => {
    const registry = new PublisherRegistry().register("blog", () => endpoint("blog"));
    expect(() => registry.register("blog", () => endpoint("blog"))).toThrow();
    expect(() => registry.resolve("missing")).toThrow("Unknown endpoint");
  });
});
