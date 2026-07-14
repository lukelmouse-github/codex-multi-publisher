import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildWechatPreview,
  extractWechatPreviewPayload,
  inspectWechatHtml,
  normalizeWechatHtml,
  rewriteWechatImageSources,
} from "../src/wechat-html";

const fixturePath = fileURLToPath(new URL("./fixtures/wechat/original-green.html", import.meta.url));

describe("wechat HTML", () => {
  test("accepts the project-original candidate and rewrites every image to frozen JPG/PNG paths", async () => {
    const candidate = normalizeWechatHtml(await readFile(fixturePath, "utf8"));
    const inspection = inspectWechatHtml(candidate, "candidate");
    expect(inspection.images.map((image) => image.src)).toEqual([
      "asset://inline-opaque",
      "asset://inline-transparent",
      "asset://screenshot",
    ]);
    expect(inspection.leafSpanCount).toBeGreaterThan(0);

    const frozen = rewriteWechatImageSources(
      candidate,
      new Map([
        ["asset://inline-opaque", "assets/opaque-1234567890abcdef.jpg"],
        ["asset://inline-transparent", "assets/transparent-1234567890abcdef.png"],
        ["asset://screenshot", "assets/screenshot-1234567890abcdef.png"],
      ]),
    );
    const frozenInspection = inspectWechatHtml(frozen, "frozen");
    expect(frozenInspection.images.every((image) => /^assets\/.+\.(?:jpg|png)$/u.test(image.src))).toBe(true);
    expect(frozen).not.toContain("asset://");
    expect(frozen).not.toContain(".webp");
  });

  test("embeds the exact payload bytes in an escaped preview", async () => {
    const payload = normalizeWechatHtml(await readFile(fixturePath, "utf8"));
    const preview = buildWechatPreview(payload, '</title><script>alert("x")</script>');
    expect(extractWechatPreviewPayload(preview)).toBe(payload);
    expect(preview).not.toContain('<title></title><script>alert("x")</script></title>');
    expect(preview).toContain("&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  test("rejects unsafe or non-compliant candidate HTML", () => {
    const wrap = (body: string) => `<section><p><span leaf="">安全正文。</span></p>${body}</section>`;

    expect(() => inspectWechatHtml(wrap('<img src="https://example.com/a.png">'), "candidate")).toThrow();
    expect(() => inspectWechatHtml(wrap('<img src="../outside.png">'), "candidate")).toThrow();
    expect(() => inspectWechatHtml(wrap('<img src="asset://missing id">'), "candidate")).toThrow();
    expect(() => inspectWechatHtml("<div><span leaf=\"\">正文。</span></div>", "candidate")).toThrow();
    expect(() => inspectWechatHtml("<section><p>没有叶子包裹。</p></section>", "candidate")).toThrow();
    expect(() => inspectWechatHtml('<section><p><span leaf="">中文,半角。</span></p></section>', "candidate")).toThrow();
    expect(() => inspectWechatHtml(wrap('<img src="assets/a.webp">'), "frozen")).toThrow();
    expect(() => inspectWechatHtml(wrap('<img src="assets/a.jpg" srcset="assets/b.jpg 2x">'), "frozen")).toThrow();
  });

  test("refuses unresolved or unused rewrite mappings", async () => {
    const candidate = normalizeWechatHtml(await readFile(fixturePath, "utf8"));
    expect(() => rewriteWechatImageSources(candidate, new Map())).toThrow();
    const replacements = new Map([
      ["asset://inline-opaque", "assets/a.jpg"],
      ["asset://inline-transparent", "assets/b.png"],
      ["asset://screenshot", "assets/c.png"],
      ["asset://unused", "assets/d.png"],
    ]);
    expect(() => rewriteWechatImageSources(candidate, replacements)).toThrow();
  });
});
