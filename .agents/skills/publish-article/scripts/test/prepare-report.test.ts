import { describe, expect, test } from "bun:test";
import { assertPublicationPlanIntegrity, createPublicationPlan, renderPrepareReport } from "../src/prepare-report";
import { verifyConfirmationToken } from "../src/receipts";
import type { ArticlePackage, PreparedPublication } from "../src/types";

function article(): ArticlePackage {
  return {
    schemaVersion: 1,
    articleId: "article",
    revision: `sha256:${"a".repeat(64)}`,
    metadata: {
      title: "发布测试",
      slug: "publish-test",
      summary: "摘要",
      author: "Example Author",
      language: "zh-CN",
      tags: [],
      categories: [],
      publishedAt: "2026-07-01T00:00:00+08:00",
    },
    body: { path: "body.md", sha256: `sha256:${"b".repeat(64)}` },
    assets: [],
    provenance: { sourceId: "source", sourceDigest: `sha256:${"c".repeat(64)}`, packagerVersion: 1 },
  };
}

function prepared(endpoint: string, marker: string): PreparedPublication {
  return {
    schemaVersion: 1,
    endpoint,
    articleId: "article",
    packageRevision: `sha256:${"a".repeat(64)}`,
    optionsDigest: `sha256:${marker.repeat(64).slice(0, 64)}`,
    planDigest: `sha256:${marker.repeat(64).slice(0, 64)}`,
    artifactRoot: `/ignored/${marker}`,
    renderDigest: `sha256:${marker.repeat(64).slice(0, 64)}`,
    actions: [{ id: "publish", description: `publish ${endpoint}`, sideEffect: true }],
  };
}

describe("prepare report", () => {
  test("binds one confirmation token to all endpoint plans", () => {
    const plan = createPublicationPlan(article(), [
      { id: "wechat", prepared: prepared("wechat-draft-baoyu", "b") },
      { id: "blog", prepared: prepared("blog-git", "a") },
    ]);
    expect(plan.targets).toEqual(["blog", "wechat"]);
    expect(verifyConfirmationToken(plan.confirmationToken, plan.aggregate)).toBe(true);

    const changed = createPublicationPlan(article(), [
      { id: "blog", prepared: prepared("blog-git", "a") },
      { id: "wechat", prepared: prepared("wechat-draft-baoyu", "d") },
    ]);
    expect(changed.confirmationToken).not.toBe(plan.confirmationToken);
  });

  test("makes the manual WeChat publication boundary explicit", () => {
    const plan = createPublicationPlan(article(), [{ id: "wechat", prepared: prepared("wechat-draft-baoyu", "b") }]);
    const report = renderPrepareReport(article(), plan, {
      wechat: { previewPath: "/tmp/preview.html", account: "example-account", assets: [] },
    });
    expect(report).toContain("仅保存到草稿箱");
    expect(report).toContain("正式发布必须人工完成");
    expect(report).toContain(plan.confirmationToken);
  });

  test("detects endpoint-plan tampering even when the stored aggregate token is unchanged", () => {
    const plan = createPublicationPlan(article(), [{ id: "blog", prepared: prepared("blog-git", "a") }]);
    plan.endpointPlans[0]!.prepared.renderDigest = `sha256:${"f".repeat(64)}`;
    expect(() => assertPublicationPlanIntegrity(article(), plan)).toThrow("modified after preparation");
  });
});
