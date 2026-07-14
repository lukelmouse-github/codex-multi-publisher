import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createConfirmationToken,
  createIdempotencyKey,
  createPlanDigest,
  readReceipt,
  verifyConfirmationToken,
  writeReceiptAtomic,
} from "../src/receipts";
import type { PreparedPublication, PublishReceipt } from "../src/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function prepared(overrides: Partial<PreparedPublication> = {}): PreparedPublication {
  return {
    schemaVersion: 1,
    endpoint: "blog-git",
    articleId: "stable-article",
    packageRevision: "sha256:revision",
    optionsDigest: "sha256:options",
    planDigest: "sha256:plan",
    artifactRoot: "/machine-specific/work",
    previewPath: "/machine-specific/preview.html",
    baselineDigest: "sha256:baseline",
    renderDigest: "sha256:render",
    actions: [{ id: "push", description: "Push main", sideEffect: true }],
    ...overrides,
  };
}

describe("receipt helpers", () => {
  test("binds confirmation to the publication intent but not machine-specific paths", () => {
    const original = prepared();
    const token = createConfirmationToken(original, "secret");
    const relocated = prepared({ artifactRoot: "/another/work", previewPath: "/another/preview.html" });

    expect(verifyConfirmationToken(token, original, "secret")).toBe(true);
    expect(verifyConfirmationToken(token, relocated, "secret")).toBe(true);
    expect(() => verifyConfirmationToken(
      token,
      prepared({ packageRevision: "sha256:other" }),
      "secret",
    )).toThrow("Confirmation token");
    expect(() => verifyConfirmationToken(token, original, "wrong-secret")).toThrow("Confirmation token");
  });

  test("creates stable plan and idempotency digests", () => {
    expect(createPlanDigest({ b: 2, a: 1 })).toBe(createPlanDigest({ a: 1, b: 2 }));
    expect(createIdempotencyKey(prepared())).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(createIdempotencyKey(prepared())).toBe(createIdempotencyKey(prepared({ artifactRoot: "/elsewhere" })));
  });

  test("atomically writes and replaces receipts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "publish-receipt-test-"));
    roots.push(root);
    const receiptPath = path.join(root, "nested", "blog.json");
    const receipt: PublishReceipt = {
      schemaVersion: 1,
      receiptId: "receipt-1",
      endpoint: "blog-git",
      articleId: "stable-article",
      packageRevision: "sha256:revision",
      planDigest: "sha256:plan",
      idempotencyKey: "sha256:idempotency",
      state: "prepared",
      sideEffects: [],
    };

    await writeReceiptAtomic(receiptPath, receipt);
    expect(await readReceipt(receiptPath)).toEqual(receipt);

    const committed: PublishReceipt = { ...receipt, state: "committed", checkpoint: "abc123" };
    await writeReceiptAtomic(receiptPath, committed);
    expect(await readReceipt(receiptPath)).toEqual(committed);
    expect((await readdir(path.dirname(receiptPath))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
