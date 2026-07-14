import path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson, digestCanonical } from "./canonical-json";
import { PublishError } from "./errors";
import { atomicWriteFile } from "./run-store";
import type { PreparedPublication, PublishReceipt, ReceiptState } from "./types";

type ConfirmationSecret = string | Uint8Array;

const RECEIPT_STATES = new Set<ReceiptState>([
  "prepared",
  "committed",
  "pushed",
  "draft_created",
  "partial",
  "failed",
  "outcome_unknown",
]);

function confirmationIntent(prepared: PreparedPublication): Record<string, unknown> {
  return {
    schemaVersion: prepared.schemaVersion,
    endpoint: prepared.endpoint,
    articleId: prepared.articleId,
    packageRevision: prepared.packageRevision,
    optionsDigest: prepared.optionsDigest,
    planDigest: prepared.planDigest,
    baselineDigest: prepared.baselineDigest,
    renderDigest: prepared.renderDigest,
    actions: prepared.actions,
  };
}

function confirmationDigest(prepared: PreparedPublication, secret?: ConfirmationSecret): string {
  const payload = canonicalJson(confirmationIntent(prepared));
  return secret === undefined
    ? createHash("sha256").update("publish-confirmation:v1\0").update(payload).digest("hex")
    : createHmac("sha256", secret).update("publish-confirmation:v1\0").update(payload).digest("hex");
}

export function createPlanDigest(plan: unknown): string {
  return digestCanonical(plan);
}

export function createIdempotencyKey(prepared: PreparedPublication): string {
  return digestCanonical({
    schemaVersion: 1,
    endpoint: prepared.endpoint,
    articleId: prepared.articleId,
    packageRevision: prepared.packageRevision,
    optionsDigest: prepared.optionsDigest,
    planDigest: prepared.planDigest,
    baselineDigest: prepared.baselineDigest,
    renderDigest: prepared.renderDigest,
  });
}

export function createConfirmationToken(
  prepared: PreparedPublication,
  secret?: ConfirmationSecret,
): string {
  return `confirm:v1:${confirmationDigest(prepared, secret)}`;
}

export function verifyConfirmationToken(
  token: string,
  prepared: PreparedPublication,
  secret?: ConfirmationSecret,
): true {
  const expected = createConfirmationToken(prepared, secret);
  const actualBytes = Buffer.from(token, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  const valid = /^confirm:v1:[a-f0-9]{64}$/.test(token)
    && actualBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(actualBytes, expectedBytes);
  if (!valid) {
    throw new PublishError("E_CONFIRMATION", "Confirmation token does not match the prepared publication", {
      kind: "precondition",
    });
  }
  return true;
}

function assertReceipt(value: unknown): PublishReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublishError("E_RECEIPT", "Receipt must be a JSON object");
  }
  const receipt = value as Partial<PublishReceipt>;
  const requiredStrings: Array<keyof PublishReceipt> = [
    "receiptId",
    "endpoint",
    "articleId",
    "packageRevision",
    "planDigest",
    "idempotencyKey",
    "state",
  ];
  for (const key of requiredStrings) {
    if (typeof receipt[key] !== "string" || !(receipt[key] as string).length) {
      throw new PublishError("E_RECEIPT", `Receipt field ${key} must be a non-empty string`);
    }
  }
  if (receipt.schemaVersion !== 1) {
    throw new PublishError("E_RECEIPT", "Unsupported receipt schemaVersion");
  }
  if (!RECEIPT_STATES.has(receipt.state as ReceiptState)) {
    throw new PublishError("E_RECEIPT", `Unknown receipt state: ${String(receipt.state)}`);
  }
  if (!Array.isArray(receipt.sideEffects)) {
    throw new PublishError("E_RECEIPT", "Receipt sideEffects must be an array");
  }
  return receipt as PublishReceipt;
}

export async function writeReceiptAtomic(receiptPath: string, receipt: PublishReceipt): Promise<void> {
  if (!path.isAbsolute(receiptPath)) {
    throw new PublishError("E_RECEIPT_PATH", "Receipt path must be absolute");
  }
  await atomicWriteFile(receiptPath, canonicalJson(assertReceipt(receipt)));
}

export async function readReceipt(receiptPath: string): Promise<PublishReceipt> {
  if (!path.isAbsolute(receiptPath)) {
    throw new PublishError("E_RECEIPT_PATH", "Receipt path must be absolute");
  }
  try {
    return assertReceipt(JSON.parse(await readFile(receiptPath, "utf8")));
  } catch (error) {
    if (error instanceof PublishError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PublishError("E_RECEIPT_READ", `Unable to read receipt: ${message}`, {
      kind: "precondition",
      details: { receiptPath },
    });
  }
}
