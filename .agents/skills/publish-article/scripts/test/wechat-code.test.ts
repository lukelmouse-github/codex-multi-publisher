import { describe, expect, test } from "bun:test";
import {
  assertWechatCodeFidelity,
  expandCodeTabs,
  extractMarkdownCodeBlocks,
  renderWechatCode,
  validateWechatCodeFidelity,
  WECHAT_CODE_SLOT_PREFIX,
} from "../src/wechat-code";
import { inspectWechatHtml } from "../src/wechat-html";

const markdown = [
  "# Code fidelity",
  "",
  "```json",
  "{",
  "\t\"nested\": {",
  "\t\t\"html\": \"<tag>&value\"",
  "",
  "\t}",
  "}",
  "```",
  "",
  "```bash",
  "printf '%s\\n' \"$HOME\"",
  "```",
  "",
  "```ts",
  "const value: string = '<safe>';",
  "```",
  "",
  "```made-up-language",
  "<unknown>&format",
  "```",
  "",
].join("\n");

function candidateWithSlots(count: number): string {
  return `<section><p><span leaf="">代码保真测试。</span></p>${Array.from(
    { length: count },
    (_, index) => `<!--${WECHAT_CODE_SLOT_PREFIX}${index}-->`,
  ).join("")}</section>`;
}

describe("WeChat deterministic code rendering", () => {
  test("extracts fenced JSON, Bash, TypeScript, tabs, and blank lines from the Markdown AST", () => {
    const blocks = extractMarkdownCodeBlocks(markdown);
    expect(blocks.map((block) => block.language)).toEqual(["json", "bash", "ts", "made-up-language"]);
    expect(blocks[0]?.raw).toContain("\t\"nested\"");
    expect(blocks[0]?.lines[1]).toBe('    "nested": {');
    expect(blocks[0]?.lines[2]).toBe('        "html": "<tag>&value"');
    expect(blocks[0]?.lines[3]).toBe("");
    expect(expandCodeTabs("  \tx", 4)).toBe("    x");
  });

  test("replaces explicit slots with Shiki token colors and byte-faithful visible lines", async () => {
    const rendered = await renderWechatCode({
      markdown,
      candidateHtml: candidateWithSlots(4),
    });
    expect(rendered.mode).toBe("slots");
    expect(rendered.report.ok).toBe(true);
    expect(rendered.report.sourceBlockCount).toBe(4);
    expect(rendered.report.sourceProjectionSha256).toBe(rendered.report.renderedProjectionSha256);
    expect(rendered.html).toContain('data-publish-code-index="0"');
    expect(rendered.html).toContain('data-publish-code-language="made-up-language"');
    expect(rendered.html).toMatch(/style="color:#[0-9A-F]{6}(?:;[^"]*)?;"/u);
    expect(rendered.html).toContain("&nbsp;&nbsp;&nbsp;&nbsp;");
    expect(rendered.html).toContain("&lt;tag&gt;&amp;value");
    expect(rendered.html).not.toContain("<tag>&value");
    expect(rendered.html).not.toContain(WECHAT_CODE_SLOT_PREFIX);
    expect(inspectWechatHtml(rendered.html, "candidate").leafSpanCount).toBeGreaterThan(0);
    expect(assertWechatCodeFidelity(markdown, rendered.html).ok).toBe(true);
  });

  test("is idempotent when rewriting its own deterministic components", async () => {
    const first = await renderWechatCode({ markdown, candidateHtml: candidateWithSlots(4) });
    const second = await renderWechatCode({ markdown, candidateHtml: first.html });
    expect(second.mode).toBe("rendered");
    expect(second.html).toBe(first.html);
  });

  test("rejects missing, duplicate, and out-of-order explicit slots", async () => {
    await expect(renderWechatCode({ markdown, candidateHtml: candidateWithSlots(3) })).rejects.toMatchObject({
      data: { code: "E_WECHAT_CODE_FIDELITY" },
    });
    await expect(renderWechatCode({
      markdown,
      candidateHtml: `<section><!--${WECHAT_CODE_SLOT_PREFIX}0--><!--${WECHAT_CODE_SLOT_PREFIX}0--><!--${WECHAT_CODE_SLOT_PREFIX}2--><!--${WECHAT_CODE_SLOT_PREFIX}3--></section>`,
    })).rejects.toMatchObject({ data: { code: "E_WECHAT_CODE_FIDELITY" } });
    await expect(renderWechatCode({
      markdown,
      candidateHtml: `<section><!--${WECHAT_CODE_SLOT_PREFIX}1--><!--${WECHAT_CODE_SLOT_PREFIX}0--><!--${WECHAT_CODE_SLOT_PREFIX}2--><!--${WECHAT_CODE_SLOT_PREFIX}3--></section>`,
    })).rejects.toMatchObject({ data: { code: "E_WECHAT_CODE_FIDELITY" } });
  });

  test("requires an explicit slot contract unless strict legacy migration is requested", async () => {
    const legacy = `<section>${["json", "bash", "ts", "text"].map((language) => [
      '<section style="margin:0;background:#1E293B;">',
      `<section style="display:flex;"><span style="font-family:Consolas,monospace;"><span leaf="">${language}</span></span></section>`,
      '<section style="padding:1px;"><p style="font-family:Consolas,monospace;"><span leaf="">corrupted</span></p></section>',
      "</section>",
    ].join("")).join("")}</section>`;
    await expect(renderWechatCode({ markdown, candidateHtml: legacy })).rejects.toMatchObject({
      data: { code: "E_WECHAT_CODE_FIDELITY" },
    });
    const migrated = await renderWechatCode({
      markdown,
      candidateHtml: legacy,
      allowLegacyDetection: true,
    });
    expect(migrated.mode).toBe("legacy");
    expect(migrated.report.ok).toBe(true);
    expect(migrated.html).not.toContain("corrupted");
  });

  test("fidelity gate detects language, blank-line, indentation, and content loss", async () => {
    const rendered = await renderWechatCode({ markdown, candidateHtml: candidateWithSlots(4) });
    const wrongLanguage = rendered.html.replace(
      'data-publish-code-language="json"',
      'data-publish-code-language="bash"',
    );
    expect(validateWechatCodeFidelity(markdown, wrongLanguage).mismatches).toContainEqual(
      expect.objectContaining({ kind: "language", block: 0 }),
    );

    const missingIndentation = rendered.html.replace("&nbsp;&nbsp;&nbsp;&nbsp;", "");
    expect(validateWechatCodeFidelity(markdown, missingIndentation).mismatches).toContainEqual(
      expect.objectContaining({ kind: "indentation", block: 0, line: 1 }),
    );

    const filledBlank = rendered.html.replace('<span leaf=""><br></span>', '<span leaf="">x</span>');
    expect(validateWechatCodeFidelity(markdown, filledBlank).mismatches).toContainEqual(
      expect.objectContaining({ kind: "empty_line", block: 0, line: 3 }),
    );

    const changedContent = rendered.html.replace("&lt;unknown&gt;&amp;format", "changed");
    const contentReport = validateWechatCodeFidelity(markdown, changedContent);
    expect(contentReport.ok).toBe(false);
    expect(contentReport.mismatches).toContainEqual(expect.objectContaining({ kind: "line_content", block: 3 }));
    expect(() => assertWechatCodeFidelity(markdown, changedContent)).toThrow("differs from the ArticlePackage Markdown");
  });

  test("rejects extra pre, code, and monospace paragraph blocks outside deterministic markers", async () => {
    const rendered = await renderWechatCode({ markdown, candidateHtml: candidateWithSlots(4) });
    for (const extra of [
      '<pre><span leaf="">extra</span></pre>',
      '<code><span leaf="">extra</span></code>',
      '<p style="font-family:Consolas,monospace;"><span leaf="">extra</span></p>',
    ]) {
      const withExtra = rendered.html.replace("</section>\n", `${extra}</section>\n`);
      const report = validateWechatCodeFidelity(markdown, withExtra);
      expect(report.ok).toBe(false);
      expect(report.mismatches).toContainEqual(expect.objectContaining({ kind: "unmarked_code" }));
      expect(() => assertWechatCodeFidelity(markdown, withExtra)).toThrow("differs from the ArticlePackage Markdown");
    }
  });
});
