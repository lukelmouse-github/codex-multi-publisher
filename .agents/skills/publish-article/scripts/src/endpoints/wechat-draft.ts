import path from "node:path";
import { lstat } from "node:fs/promises";
import { digestCanonical } from "../canonical-json";
import { asPublishError, PublishError } from "../errors";
import { createIdempotencyKey, readReceipt, verifyConfirmationToken, writeReceiptAtomic } from "../receipts";
import { runBaoyuDraft, type BaoyuDraftDependencies, type BaoyuDraftRequest } from "../baoyu-draft";
import { verifyFrozenWechatCandidate } from "../wechat-freeze";
import type {
  ArticlePackage,
  EndpointContext,
  PreparedPublication,
  PublisherEndpoint,
  PublishReceipt,
} from "../types";

const ENDPOINT_ID = "wechat-draft-baoyu";

export interface PreparedWechatPublication extends PreparedPublication {
  providerFingerprint: string;
  providerConfirmationToken: string;
  providerVersion: string;
  account: string;
}

interface WechatOptions {
  frozenRoot: string;
  account: string;
  title: string;
  author?: string;
  summary?: string;
  theme: string;
  color?: string;
  cite: boolean;
  confirmationSecret?: string;
  skillDir?: string;
  lockPath?: string;
  timeoutMs?: number;
  allowNpxBootstrap?: boolean;
  allowUnprefixedCredentials?: boolean;
  env?: Record<string, string | undefined>;
  baoyuDependencies?: BaoyuDraftDependencies;
}

function readOptions(context: EndpointContext, article: ArticlePackage): WechatOptions {
  const raw = context.options;
  const frozenRoot = typeof raw.frozenRoot === "string" ? path.resolve(raw.frozenRoot) : "";
  const account = typeof raw.account === "string" ? raw.account.trim() : "";
  if (!frozenRoot) throw new PublishError("E_WECHAT_FROZEN", "frozenRoot is required for the WeChat endpoint");
  if (!account) throw new PublishError("E_ACCOUNT_REQUIRED", "An explicit WeChat account alias is required");
  return {
    frozenRoot,
    account,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : article.metadata.title,
    author: typeof raw.author === "string" ? raw.author : article.metadata.author,
    summary: typeof raw.summary === "string" ? raw.summary : article.metadata.summary,
    theme: typeof raw.theme === "string" && raw.theme.trim() ? raw.theme.trim() : "default",
    color: typeof raw.color === "string" ? raw.color : undefined,
    cite: typeof raw.cite === "boolean" ? raw.cite : true,
    confirmationSecret: typeof raw.confirmationSecret === "string" ? raw.confirmationSecret : undefined,
    skillDir: typeof raw.skillDir === "string" ? raw.skillDir : undefined,
    lockPath: typeof raw.lockPath === "string" ? raw.lockPath : undefined,
    timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : undefined,
    allowNpxBootstrap: raw.allowNpxBootstrap === true,
    allowUnprefixedCredentials: raw.allowUnprefixedCredentials === true,
    env: raw.env && typeof raw.env === "object" ? raw.env as Record<string, string | undefined> : undefined,
    baoyuDependencies: raw.baoyuDependencies && typeof raw.baoyuDependencies === "object"
      ? raw.baoyuDependencies as BaoyuDraftDependencies
      : undefined,
  };
}

function wechatOptionsDigest(
  options: WechatOptions,
  providerFingerprint: string,
  providerVersion: string,
): string {
  return digestCanonical({
    account: options.account,
    title: options.title,
    author: options.author,
    summary: options.summary,
    theme: options.theme,
    color: options.color,
    cite: options.cite,
    providerFingerprint,
    providerVersion,
  });
}

async function requestFor(
  operation: BaoyuDraftRequest["operation"],
  article: ArticlePackage,
  context: EndpointContext,
  providerConfirmationToken?: string,
): Promise<{ request: BaoyuDraftRequest; options: WechatOptions; renderDigest: string; previewPath: string }> {
  const options = readOptions(context, article);
  const frozen = await verifyFrozenWechatCandidate(options.frozenRoot);
  if (frozen.manifest.articleId !== article.articleId || frozen.manifest.articleRevision !== article.revision) {
    throw new PublishError("E_WECHAT_ARTICLE", "Frozen WeChat candidate belongs to a different ArticlePackage", {
      kind: "conflict",
    });
  }
  if (!frozen.coverPath) throw new PublishError("E_COVER_REQUIRED", "The frozen WeChat candidate has no cover");
  return {
    options,
    renderDigest: frozen.renderDigest,
    previewPath: frozen.previewPath,
    request: {
      operation,
      repoRoot: context.repoRoot,
      artifactRoot: frozen.root,
      inputPath: frozen.htmlPath,
      coverPath: frozen.coverPath,
      title: options.title,
      author: options.author,
      summary: options.summary,
      account: options.account,
      theme: options.theme,
      color: options.color,
      cite: options.cite,
      confirmationToken: providerConfirmationToken,
      journalDir: path.join(context.runRoot, "receipts", "baoyu-drafts"),
      timeoutMs: options.timeoutMs,
      skillDir: options.skillDir,
      lockPath: options.lockPath,
      allowNpxBootstrap: options.allowNpxBootstrap,
      allowUnprefixedCredentials: options.allowUnprefixedCredentials,
      env: options.env,
    },
  };
}

async function persistReceipt(context: EndpointContext, receipt: PublishReceipt): Promise<void> {
  await writeReceiptAtomic(path.join(context.runRoot, "receipts", `${ENDPOINT_ID}.json`), receipt);
}

function receiptFor(
  prepared: PreparedPublication,
  state: PublishReceipt["state"],
  sideEffects: Array<Record<string, unknown>>,
  values: Pick<Partial<PublishReceipt>, "checkpoint" | "statusLocator" | "error"> = {},
): PublishReceipt {
  const idempotencyKey = createIdempotencyKey(prepared);
  return {
    schemaVersion: 1,
    receiptId: digestCanonical({ idempotencyKey, state, checkpoint: values.checkpoint ?? null }),
    endpoint: ENDPOINT_ID,
    articleId: prepared.articleId,
    packageRevision: prepared.packageRevision,
    planDigest: prepared.planDigest,
    idempotencyKey,
    state,
    checkpoint: values.checkpoint,
    sideEffects,
    statusLocator: values.statusLocator,
    error: values.error,
  };
}

function assertPrepared(value: PreparedPublication): PreparedWechatPublication {
  const prepared = value as PreparedWechatPublication;
  if (
    prepared.endpoint !== ENDPOINT_ID
    || typeof prepared.providerFingerprint !== "string"
    || typeof prepared.providerConfirmationToken !== "string"
    || typeof prepared.providerVersion !== "string"
    || typeof prepared.account !== "string"
  ) {
    throw new PublishError("E_WECHAT_PLAN", "Prepared WeChat plan is incomplete or belongs to another endpoint");
  }
  return prepared;
}

export class WechatDraftEndpoint implements PublisherEndpoint {
  readonly id = ENDPOINT_ID;
  readonly capabilities = {
    draft: true,
    publish: false,
    update: false,
    imageUpload: true,
    status: false,
  } as const;

  async preflight(article: ArticlePackage, context: EndpointContext): Promise<Record<string, unknown>> {
    const resolved = await requestFor("preflight", article, context);
    const result = await runBaoyuDraft(resolved.request, resolved.options.baoyuDependencies);
    return {
      ok: result.ok,
      state: result.state,
      account: result.account,
      fingerprint: result.fingerprint,
      confirmationToken: result.confirmationToken,
      renderDigest: resolved.renderDigest,
      previewPath: resolved.previewPath,
      toolchain: result.toolchain,
      credentials: result.credentials,
      dryRun: result.dryRun,
      diagnostics: result.diagnostics,
    };
  }

  async prepare(article: ArticlePackage, context: EndpointContext): Promise<PreparedWechatPublication> {
    const resolved = await requestFor("preflight", article, context);
    const result = await runBaoyuDraft(resolved.request, resolved.options.baoyuDependencies);
    if (!result.ok || result.state !== "preflighted") {
      throw new PublishError("E_WECHAT_PREFLIGHT", "Baoyu WeChat preflight did not complete");
    }
    const actions = [
      { id: "baoyu-dry-run", description: "Re-run Baoyu validation with the exact frozen arguments", sideEffect: false },
      { id: "upload-images", description: "Upload the frozen cover and body images to WeChat", sideEffect: true },
      { id: "create-draft", description: `Create one private draft for account ${result.account}`, sideEffect: true },
    ];
    const optionsDigest = wechatOptionsDigest(resolved.options, result.fingerprint, result.toolchain.version);
    const planCore = {
      schemaVersion: 1 as const,
      endpoint: ENDPOINT_ID,
      articleId: article.articleId,
      packageRevision: article.revision,
      optionsDigest,
      renderDigest: resolved.renderDigest,
      actions,
    };
    return {
      ...planCore,
      planDigest: digestCanonical(planCore),
      artifactRoot: resolved.request.artifactRoot,
      previewPath: resolved.previewPath,
      providerFingerprint: result.fingerprint,
      providerConfirmationToken: result.confirmationToken,
      providerVersion: result.toolchain.version,
      account: result.account,
    };
  }

  async publish(
    input: PreparedPublication,
    confirmation: string,
    context: EndpointContext,
  ): Promise<PublishReceipt> {
    const prepared = assertPrepared(input);
    const article = context.options.article as ArticlePackage | undefined;
    if (!article || article.articleId !== prepared.articleId || article.revision !== prepared.packageRevision) {
      throw new PublishError("E_ARTICLE_CONTEXT", "The confirmed ArticlePackage is missing or no longer matches");
    }
    const options = readOptions(context, article);
    if (!verifyConfirmationToken(confirmation, prepared, options.confirmationSecret)) {
      throw new PublishError("E_CONFIRMATION", "The WeChat confirmation token is stale or invalid", {
        kind: "precondition",
      });
    }
    if (
      options.account !== prepared.account
      || wechatOptionsDigest(options, prepared.providerFingerprint, prepared.providerVersion) !== prepared.optionsDigest
    ) {
      throw new PublishError("E_WECHAT_OPTIONS_STALE", "WeChat account or draft options changed after confirmation", {
        kind: "conflict",
      });
    }
    const receiptPath = path.join(context.runRoot, "receipts", `${ENDPOINT_ID}.json`);
    if (await lstat(receiptPath).catch(() => undefined)) {
      const existing = await readReceipt(receiptPath);
      if (
        existing.planDigest === prepared.planDigest
        && ["draft_created", "partial", "outcome_unknown"].includes(existing.state)
      ) {
        return existing;
      }
    }
    const resolved = await requestFor("create-draft", article, context, prepared.providerConfirmationToken);
    if (resolved.renderDigest !== prepared.renderDigest) {
      throw new PublishError("E_WECHAT_RENDER_STALE", "Frozen WeChat bytes changed after confirmation", {
        kind: "conflict",
      });
    }

    try {
      const result = await runBaoyuDraft(resolved.request, resolved.options.baoyuDependencies);
      const sideEffects: Array<Record<string, unknown>> = [];
      if (result.sideEffect === "draft_created") {
        sideEffects.push({ type: "wechat_draft", account: result.account, mediaId: result.mediaId });
      } else if (result.sideEffect === "unknown") {
        sideEffects.push({ type: "wechat_remote_outcome", account: result.account, outcome: "unknown" });
      }
      const locator = { account: result.account, mediaId: result.mediaId, fingerprint: result.fingerprint };
      const state = result.state === "draft_created"
        ? "draft_created"
        : result.state === "partial"
          ? "partial"
          : "outcome_unknown";
      const receipt = receiptFor(prepared, state, sideEffects, {
        checkpoint: result.state,
        statusLocator: locator,
        error: result.error,
      });
      await persistReceipt(context, receipt);
      return receipt;
    } catch (error) {
      const failure = asPublishError(error);
      if (failure.data.code === "E_DUPLICATE_DRAFT") {
        const journalState = typeof failure.data.details?.state === "string"
          ? failure.data.details.state
          : undefined;
        const mediaId = typeof failure.data.details?.mediaId === "string"
          ? failure.data.details.mediaId
          : undefined;
        const recoveredState: PublishReceipt["state"] = failure.data.outcome === "unknown"
          ? "outcome_unknown"
          : journalState === "partial"
            ? "partial"
            : "draft_created";
        const sideEffects = mediaId
          ? [{ type: "wechat_draft", account: prepared.account, mediaId, recovered: true }]
          : [];
        const recovered = receiptFor(prepared, recoveredState, sideEffects, {
          checkpoint: `journal_recovered:${journalState ?? "unknown"}`,
          statusLocator: { account: prepared.account, mediaId, fingerprint: prepared.providerFingerprint },
          error: recoveredState === "draft_created" ? undefined : failure.data,
        });
        await persistReceipt(context, recovered);
        return recovered;
      }
      const state = failure.data.outcome === "unknown" ? "outcome_unknown" : "failed";
      const receipt = receiptFor(prepared, state, [], {
        checkpoint: state === "outcome_unknown" ? "remote_inspection_required" : "not_applied",
        statusLocator: { account: prepared.account, fingerprint: prepared.providerFingerprint },
        error: failure.data,
      });
      await persistReceipt(context, receipt);
      return receipt;
    }
  }

  async status(receipt: PublishReceipt): Promise<Record<string, unknown>> {
    return {
      state: receipt.state,
      supported: false,
      reason: "Baoyu does not expose a safe draft-status lookup contract",
      account: receipt.statusLocator?.account,
      mediaId: receipt.statusLocator?.mediaId,
    };
  }
}

export function createWechatDraftEndpoint(): PublisherEndpoint {
  return new WechatDraftEndpoint();
}
