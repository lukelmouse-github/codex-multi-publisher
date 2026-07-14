import { digestCanonical } from "./canonical-json";
import { PublishError } from "./errors";
import { createConfirmationToken } from "./receipts";
import type { ArticlePackage, PreparedPublication } from "./types";

export interface PublicationEndpointPlan {
  id: string;
  prepared: PreparedPublication;
  details?: Record<string, unknown>;
}

export interface PublicationPlanDocument {
  schemaVersion: 1;
  articleId: string;
  packageRevision: string;
  targets: string[];
  aggregate: PreparedPublication;
  endpointPlans: PublicationEndpointPlan[];
  confirmationToken: string;
}

export interface PrepareReportDetails {
  blog?: {
    diff: string;
    hugo: Record<string, unknown>;
    target: string;
  };
  wechat?: {
    previewPath: string;
    account: string;
    assets: Array<Record<string, unknown>>;
    toolchain?: Record<string, unknown>;
  };
}

function combineOptionalDigests(
  endpointPlans: PublicationEndpointPlan[],
  key: "baselineDigest" | "renderDigest",
): string | undefined {
  const values = endpointPlans
    .map(({ id, prepared }) => ({ id, digest: prepared[key] }))
    .filter((item): item is { id: string; digest: string } => typeof item.digest === "string");
  return values.length > 0 ? digestCanonical(values) : undefined;
}

export function createPublicationPlan(
  article: ArticlePackage,
  inputPlans: PublicationEndpointPlan[],
  confirmationSecret?: string,
): PublicationPlanDocument {
  const endpointPlans = [...inputPlans].sort((left, right) => left.id.localeCompare(right.id));
  const targets = endpointPlans.map((item) => item.id);
  const actions = endpointPlans.flatMap(({ id, prepared }) => prepared.actions.map((action) => ({
    ...action,
    id: `${id}:${action.id}`,
    description: `[${id}] ${action.description}`,
  })));
  const optionsDigest = digestCanonical(endpointPlans.map(({ id, prepared }) => ({
    id,
    endpoint: prepared.endpoint,
    planDigest: prepared.planDigest,
    optionsDigest: prepared.optionsDigest,
  })));
  const planCore = {
    schemaVersion: 1 as const,
    endpoint: "publication-batch",
    articleId: article.articleId,
    packageRevision: article.revision,
    optionsDigest,
    baselineDigest: combineOptionalDigests(endpointPlans, "baselineDigest"),
    renderDigest: combineOptionalDigests(endpointPlans, "renderDigest"),
    actions,
  };
  const aggregate: PreparedPublication = {
    ...planCore,
    planDigest: digestCanonical(planCore),
    artifactRoot: "batch",
  };
  return {
    schemaVersion: 1,
    articleId: article.articleId,
    packageRevision: article.revision,
    targets,
    aggregate,
    endpointPlans,
    confirmationToken: createConfirmationToken(aggregate, confirmationSecret),
  };
}

export function assertPublicationPlanIntegrity(
  article: ArticlePackage,
  document: PublicationPlanDocument,
): true {
  if (
    document.schemaVersion !== 1
    || document.articleId !== article.articleId
    || document.packageRevision !== article.revision
    || !Array.isArray(document.endpointPlans)
  ) {
    throw new PublishError("E_PLAN_STALE", "Publication plan does not match the current ArticlePackage", {
      kind: "conflict",
    });
  }
  const ids = document.endpointPlans.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new PublishError("E_PLAN_INTEGRITY", "Publication plan contains duplicate endpoint ids", {
      kind: "conflict",
    });
  }
  const rebuilt = createPublicationPlan(article, document.endpointPlans);
  if (
    digestCanonical(rebuilt.aggregate) !== digestCanonical(document.aggregate)
    || digestCanonical(rebuilt.targets) !== digestCanonical(document.targets)
    || rebuilt.confirmationToken !== document.confirmationToken
  ) {
    throw new PublishError("E_PLAN_INTEGRITY", "Publication plan was modified after preparation", {
      kind: "conflict",
    });
  }
  return true;
}

function markdownEscape(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function jsonBlock(value: unknown): string {
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

export function renderPrepareReport(
  article: ArticlePackage,
  plan: PublicationPlanDocument,
  details: PrepareReportDetails = {},
): string {
  const lines: string[] = [
    "# 文章发布准备报告",
    "",
    `- 文章：${article.metadata.title}`,
    `- Article ID：\`${article.articleId}\``,
    `- Revision：\`${article.revision}\``,
    `- Slug：\`${article.metadata.slug}\``,
    `- 发布端点：${plan.targets.map((target) => `\`${target}\``).join("、")}`,
    "",
    "## 素材",
    "",
    "| ID | 角色 | 文件 | 大小 |",
    "| --- | --- | --- | ---: |",
    ...article.assets.map((asset) => `| ${markdownEscape(asset.id)} | ${asset.role} | ${markdownEscape(asset.path)} | ${asset.bytes} B |`),
  ];

  if (article.assets.length === 0) lines.push("| - | - | 无本地素材 | 0 B |");

  if (details.blog) {
    lines.push(
      "",
      "## Blog 候选",
      "",
      `- 目标目录：\`${details.blog.target}\``,
      `- Hugo 校验：${details.blog.hugo.ok === true ? "通过" : "未通过"}`,
      ...((details.blog.hugo.warnings as string[] | undefined) ?? []).map((warning) => `- 警告：${warning}`),
      "",
      "```diff",
      details.blog.diff.trimEnd() || "（无差异）",
      "```",
    );
  }

  if (details.wechat) {
    lines.push(
      "",
      "## 微信公众号候选",
      "",
      `- 账号别名：\`${details.wechat.account}\``,
      `- 本地预览：\`${details.wechat.previewPath}\``,
      `- 待上传素材：${details.wechat.assets.length} 个`,
      "- 最终动作：仅保存到草稿箱；正式发布必须人工完成。",
    );
    if (details.wechat.toolchain) {
      lines.push("- Baoyu 工具链：" + JSON.stringify(details.wechat.toolchain));
    }
  }

  lines.push("", "## 确认后产生的副作用", "");
  for (const action of plan.aggregate.actions) {
    lines.push(`- ${action.sideEffect ? "[会修改]" : "[只读]"} ${action.description}`);
  }
  lines.push(
    "",
    "## 确认令牌",
    "",
    `\`${plan.confirmationToken}\``,
    "",
    "该令牌只对上面列出的 revision、候选字节、Git 基线、账号和动作有效；任何变化都会使其失效。",
    "",
    "### 机器可读计划摘要",
    jsonBlock({
      targets: plan.targets,
      planDigest: plan.aggregate.planDigest,
      endpointPlans: plan.endpointPlans.map(({ id, prepared }) => ({ id, planDigest: prepared.planDigest })),
    }).trimEnd(),
    "",
  );
  return `${lines.join("\n")}\n`;
}
