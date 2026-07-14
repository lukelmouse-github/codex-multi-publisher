import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Code, Root } from "mdast";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { codeToTokens, type BundledLanguage } from "shiki";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { digestCanonical, sha256Bytes } from "./canonical-json";
import { PublishError } from "./errors";
import { assertRealPathWithin, assertSafeRelative } from "./path-policy";
import type { ArticlePackage } from "./types";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
type HtmlParent = DefaultTreeAdapterMap["parentNode"];
type HtmlFragment = DefaultTreeAdapterMap["documentFragment"];

export const WECHAT_CODE_TAB_SIZE = 4;
export const WECHAT_CODE_THEME = "github-dark-default";
export const WECHAT_CODE_SLOT_PREFIX = "PUBLISH_ARTICLE_CODE_SLOT:";

const CODE_STYLE = /monospace|white-space\s*:\s*pre|courier|consolas|sf mono/iu;
const DISPLAY_BLOCK = /(?:^|;)\s*display\s*:\s*block\s*(?:;|$)/iu;
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const SLOT_PATTERN = /^PUBLISH_ARTICLE_CODE_SLOT:(0|[1-9][0-9]*)$/u;
const RENDERED_INDEX_ATTRIBUTE = "data-publish-code-index";
const RENDERED_LANGUAGE_ATTRIBUTE = "data-publish-code-language";
const RENDERED_TAB_SIZE_ATTRIBUTE = "data-publish-code-tab-size";
const RENDERED_LINE_ATTRIBUTE = "data-publish-code-line";

export interface MarkdownCodeBlock {
  index: number;
  language: string;
  raw: string;
  expanded: string;
  lines: string[];
}

export interface RenderedWechatCodeBlock {
  index: number;
  language: string;
  tabSize: number;
  lines: string[];
}

export type WechatCodeMismatchKind =
  | "block_count"
  | "block_index"
  | "language"
  | "tab_size"
  | "line_count"
  | "empty_line"
  | "indentation"
  | "line_content"
  | "unmarked_code";

export interface WechatCodeMismatch {
  kind: WechatCodeMismatchKind;
  block?: number;
  line?: number;
  expected?: string | number;
  actual?: string | number;
  expectedSha256?: string;
  actualSha256?: string;
}

export interface WechatCodeFidelityReport {
  schemaVersion: 1;
  ok: boolean;
  tabSize: number;
  sourceBlockCount: number;
  renderedBlockCount: number;
  sourceProjectionSha256: string;
  renderedProjectionSha256: string;
  mismatches: WechatCodeMismatch[];
}

export interface RenderWechatCodeOptions {
  markdown: string;
  candidateHtml: string;
  allowLegacyDetection?: boolean;
  tabSize?: number;
}

export interface RenderWechatCodeResult {
  html: string;
  mode: "slots" | "rendered" | "legacy" | "none";
  report: WechatCodeFidelityReport;
}

interface ReplacementTarget {
  index: number;
  parent: HtmlParent;
  child: DefaultTreeAdapterMap["childNode"];
  language?: string;
}

function fidelityError(message: string, details?: Record<string, unknown>): PublishError {
  return new PublishError("E_WECHAT_CODE_FIDELITY", message, {
    kind: "validation",
    details,
  });
}

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function isParent(node: HtmlNode): node is HtmlParent {
  return "childNodes" in node;
}

function isComment(node: HtmlNode): node is DefaultTreeAdapterMap["commentNode"] {
  return node.nodeName === "#comment" && "data" in node;
}

function getAttribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name)?.value;
}

function directElements(parent: HtmlParent): HtmlElement[] {
  return parent.childNodes.filter(isElement);
}

function walk(node: HtmlNode, visitor: (node: HtmlNode) => void): void {
  visitor(node);
  if (!isParent(node)) return;
  for (const child of node.childNodes) walk(child, visitor);
  if (isElement(node) && node.tagName === "template" && "content" in node) walk(node.content, visitor);
}

function textContent(node: HtmlNode): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  if (!isParent(node)) return "";
  return node.childNodes.map(textContent).join("");
}

function parentOf(node: HtmlNode): HtmlParent | undefined {
  return "parentNode" in node && node.parentNode ? node.parentNode : undefined;
}

function replaceChild(target: ReplacementTarget, replacementHtml: string): void {
  const position = target.parent.childNodes.indexOf(target.child);
  if (position < 0) throw fidelityError("WeChat code replacement target is detached");
  const replacement = parseFragment(replacementHtml).childNodes;
  if (replacement.length !== 1 || !isElement(replacement[0]!)) {
    throw fidelityError("Deterministic code renderer did not produce one component");
  }
  const next = replacement[0]!;
  next.parentNode = target.parent;
  target.parent.childNodes.splice(position, 1, next);
}

function normalizeLanguage(value: string | null | undefined): string {
  return value?.trim().toLowerCase() || "text";
}

function comparableLanguage(value: string): string {
  const normalized = normalizeLanguage(value);
  const aliases: Record<string, string> = {
    console: "shell",
    dotenv: "env",
    javascript: "js",
    shellscript: "shell",
    sh: "shell",
    bash: "shell",
    typescript: "ts",
  };
  return aliases[normalized] ?? normalized;
}

export function expandCodeTabs(value: string, tabSize = WECHAT_CODE_TAB_SIZE): string {
  if (!Number.isSafeInteger(tabSize) || tabSize < 1 || tabSize > 16) {
    throw fidelityError("WeChat code tab size must be an integer between 1 and 16", { tabSize });
  }
  let output = "";
  let column = 0;
  for (const character of value) {
    if (character === "\n") {
      output += character;
      column = 0;
      continue;
    }
    if (character === "\t") {
      const spaces = tabSize - (column % tabSize);
      output += " ".repeat(spaces);
      column += spaces;
      continue;
    }
    output += character;
    column += 1;
  }
  return output;
}

export function extractMarkdownCodeBlocks(
  markdown: string,
  tabSize = WECHAT_CODE_TAB_SIZE,
): MarkdownCodeBlock[] {
  const tree = unified().use(remarkParse).parse(markdown.replace(/\r\n?/gu, "\n")) as Root;
  const blocks: MarkdownCodeBlock[] = [];
  visit(tree, "code", (node: Code) => {
    const raw = node.value.replace(/\r\n?/gu, "\n");
    const expanded = expandCodeTabs(raw, tabSize);
    blocks.push({
      index: blocks.length,
      language: normalizeLanguage(node.lang),
      raw,
      expanded,
      lines: expanded.split("\n"),
    });
  });
  return blocks;
}

export function digestWechatCodeProjection(
  blocks: Array<Pick<MarkdownCodeBlock | RenderedWechatCodeBlock, "index" | "language" | "lines">>,
): string {
  return digestCanonical(blocks.map((block) => ({
    index: block.index,
    language: block.language,
    lines: block.lines,
  })));
}

function leadingSpaces(value: string): number {
  return /^ */u.exec(value)?.[0].length ?? 0;
}

function compareBlocks(
  source: MarkdownCodeBlock[],
  rendered: RenderedWechatCodeBlock[],
  tabSize: number,
  unmarkedCodeCount: number,
): WechatCodeFidelityReport {
  const mismatches: WechatCodeMismatch[] = [];
  if (source.length !== rendered.length) {
    mismatches.push({ kind: "block_count", expected: source.length, actual: rendered.length });
  }
  if (unmarkedCodeCount > 0) {
    mismatches.push({ kind: "unmarked_code", actual: unmarkedCodeCount, expected: 0 });
  }
  const count = Math.max(source.length, rendered.length);
  for (let blockIndex = 0; blockIndex < count; blockIndex += 1) {
    const expected = source[blockIndex];
    const actual = rendered[blockIndex];
    if (!expected || !actual) continue;
    if (actual.index !== expected.index) {
      mismatches.push({ kind: "block_index", block: blockIndex, expected: expected.index, actual: actual.index });
    }
    if (actual.language !== expected.language) {
      mismatches.push({ kind: "language", block: blockIndex, expected: expected.language, actual: actual.language });
    }
    if (actual.tabSize !== tabSize) {
      mismatches.push({ kind: "tab_size", block: blockIndex, expected: tabSize, actual: actual.tabSize });
    }
    if (actual.lines.length !== expected.lines.length) {
      mismatches.push({
        kind: "line_count",
        block: blockIndex,
        expected: expected.lines.length,
        actual: actual.lines.length,
      });
    }
    const lineCount = Math.max(expected.lines.length, actual.lines.length);
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
      const expectedLine = expected.lines[lineIndex];
      const actualLine = actual.lines[lineIndex];
      if (expectedLine === undefined || actualLine === undefined || expectedLine === actualLine) continue;
      let kind: WechatCodeMismatchKind = "line_content";
      if ((expectedLine === "") !== (actualLine === "")) kind = "empty_line";
      else if (leadingSpaces(expectedLine) !== leadingSpaces(actualLine)) kind = "indentation";
      mismatches.push({
        kind,
        block: blockIndex,
        line: lineIndex,
        expectedSha256: sha256Bytes(expectedLine),
        actualSha256: sha256Bytes(actualLine),
      });
    }
  }
  const sourceProjectionSha256 = digestWechatCodeProjection(source);
  const renderedProjectionSha256 = digestWechatCodeProjection(rendered);
  return {
    schemaVersion: 1,
    ok: mismatches.length === 0 && sourceProjectionSha256 === renderedProjectionSha256,
    tabSize,
    sourceBlockCount: source.length,
    renderedBlockCount: rendered.length,
    sourceProjectionSha256,
    renderedProjectionSha256,
    mismatches,
  };
}

function legacyCodeTargets(fragment: HtmlFragment): ReplacementTarget[] {
  const targets: ReplacementTarget[] = [];
  const seenOuter = new Set<HtmlElement>();
  walk(fragment, (node) => {
    if (!isElement(node) || node.tagName !== "section") return;
    const lineElements = directElements(node);
    if (
      lineElements.length === 0
      || lineElements.some((element) => element.tagName !== "p" || !CODE_STYLE.test(getAttribute(element, "style") ?? ""))
    ) return;
    const outer = parentOf(node);
    if (!outer || !isElement(outer) || outer.tagName !== "section" || seenOuter.has(outer)) return;
    const outerChildren = directElements(outer);
    if (outerChildren.length !== 2 || outerChildren[1] !== node) return;
    const header = outerChildren[0]!;
    const headerStyle = getAttribute(header, "style") ?? "";
    if (!/display\s*:\s*flex/iu.test(headerStyle)) return;
    const labels: string[] = [];
    walk(header, (descendant) => {
      if (!isElement(descendant) || descendant.tagName !== "span") return;
      if (!CODE_STYLE.test(getAttribute(descendant, "style") ?? "")) return;
      const label = textContent(descendant).trim();
      if (label && label !== ".") labels.push(label);
    });
    if (labels.length !== 1) return;
    const parent = parentOf(outer);
    if (!parent) return;
    seenOuter.add(outer);
    targets.push({ index: targets.length, parent, child: outer, language: normalizeLanguage(labels[0]) });
  });
  return targets;
}

function slotTargets(fragment: HtmlFragment): ReplacementTarget[] {
  const targets: ReplacementTarget[] = [];
  const malformed: string[] = [];
  walk(fragment, (node) => {
    if (!isComment(node)) return;
    const marker = node.data.trim();
    if (!marker.startsWith(WECHAT_CODE_SLOT_PREFIX)) return;
    const match = SLOT_PATTERN.exec(marker);
    if (!match) {
      malformed.push(marker);
      return;
    }
    const parent = parentOf(node);
    if (!parent) throw fidelityError("WeChat code slot is detached");
    targets.push({ index: Number(match[1]), parent, child: node });
  });
  if (malformed.length > 0) {
    throw fidelityError("Malformed WeChat code slot marker", { markers: malformed });
  }
  return targets;
}

function renderedTargets(fragment: HtmlFragment): ReplacementTarget[] {
  const targets: ReplacementTarget[] = [];
  walk(fragment, (node) => {
    if (!isElement(node)) return;
    const value = getAttribute(node, RENDERED_INDEX_ATTRIBUTE);
    if (value === undefined) return;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
      throw fidelityError("Rendered WeChat code block has an invalid index", { index: value });
    }
    const parent = parentOf(node);
    if (!parent) throw fidelityError("Rendered WeChat code block is detached");
    targets.push({ index: Number(value), parent, child: node, language: getAttribute(node, RENDERED_LANGUAGE_ATTRIBUTE) });
  });
  return targets;
}

function assertTargetContract(targets: ReplacementTarget[], blocks: MarkdownCodeBlock[], mode: string): void {
  if (targets.length !== blocks.length) {
    throw fidelityError(`WeChat ${mode} code block count does not match Markdown`, {
      expected: blocks.length,
      actual: targets.length,
    });
  }
  for (let index = 0; index < blocks.length; index += 1) {
    const target = targets[index]!;
    const block = blocks[index]!;
    if (target.index !== index) {
      throw fidelityError(`WeChat ${mode} code slots must appear once in source order`, {
        position: index,
        index: target.index,
      });
    }
    // Legacy candidates are recognized by the whole two-part code-card structure
    // and are immediately replaced from Markdown. Their decorative language label
    // is not trusted: old agent-generated candidates sometimes changed `bash` to
    // `env`. Explicit slots and already-rendered components remain language-strict.
    if (mode !== "legacy" && target.language && comparableLanguage(target.language) !== comparableLanguage(block.language)) {
      throw fidelityError(`WeChat ${mode} code language does not match Markdown`, {
        block: index,
        expected: block.language,
        actual: target.language,
      });
    }
  }
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeVisibleCode(value: string): string {
  let output = "";
  for (const character of value) {
    if (character === " ") output += "&nbsp;";
    else if (character === "&") output += "&amp;";
    else if (character === "<") output += "&lt;";
    else if (character === ">") output += "&gt;";
    else if (character === '"') output += "&quot;";
    else if (character === "'") output += "&#39;";
    else output += character;
  }
  return output;
}

function tokenStyle(color: string | undefined, fallback: string, fontStyle: number | undefined): string {
  const styles = [`color:${HEX_COLOR.test(color ?? "") ? color!.toUpperCase() : fallback}`];
  if (fontStyle !== undefined && fontStyle >= 0) {
    if ((fontStyle & 1) !== 0) styles.push("font-style:italic");
    if ((fontStyle & 2) !== 0) styles.push("font-weight:700");
    const decorations: string[] = [];
    if ((fontStyle & 4) !== 0) decorations.push("underline");
    if ((fontStyle & 8) !== 0) decorations.push("line-through");
    if (decorations.length > 0) styles.push(`text-decoration:${decorations.join(" ")}`);
  }
  return `${styles.join(";")};`;
}

async function highlightedLines(block: MarkdownCodeBlock): Promise<Array<Array<{ content: string; color?: string; fontStyle?: number }>>> {
  const normalize = (
    lines: Awaited<ReturnType<typeof codeToTokens>>["tokens"],
  ): Array<Array<{ content: string; color?: string; fontStyle?: number }>> => block.lines.map((line, index) => {
    const tokens = lines[index] ?? [];
    if (tokens.map((token) => token.content).join("") !== line) return line ? [{ content: line }] : [];
    return tokens.map((token) => ({
      content: token.content,
      color: token.color,
      fontStyle: token.fontStyle,
    }));
  });
  try {
    const highlighted = await codeToTokens(block.expanded, {
      lang: block.language as BundledLanguage,
      theme: WECHAT_CODE_THEME,
    });
    return normalize(highlighted.tokens);
  } catch {
    const fallback = await codeToTokens(block.expanded, { lang: "text", theme: WECHAT_CODE_THEME });
    return normalize(fallback.tokens);
  }
}

export async function renderWechatCodeBlock(block: MarkdownCodeBlock, tabSize = WECHAT_CODE_TAB_SIZE): Promise<string> {
  const lines = await highlightedLines(block);
  const renderedLines = block.lines.map((line, lineIndex) => {
    const tokens = lines[lineIndex] ?? [];
    const content = line === ""
      ? '<span leaf=""><br></span>'
      : tokens.map((token) => {
          const visible = escapeVisibleCode(token.content);
          return `<span style="${tokenStyle(token.color, "#E2E8F0", token.fontStyle)}"><span leaf="">${visible}</span></span>`;
        }).join("");
    return `<span ${RENDERED_LINE_ATTRIBUTE}="${lineIndex}" style="display:block;min-height:1.6em;margin:0;font-family:'SF Mono',Consolas,Monaco,monospace;font-size:13px;line-height:1.6;white-space:nowrap;">${content}</span>`;
  }).join("");
  const language = escapeAttribute(block.language);
  return `<section ${RENDERED_INDEX_ATTRIBUTE}="${block.index}" ${RENDERED_LANGUAGE_ATTRIBUTE}="${language}" ${RENDERED_TAB_SIZE_ATTRIBUTE}="${tabSize}" style="margin:0 0 20px;border-radius:8px;overflow:hidden;background:#1E293B;box-shadow:0 4px 16px -8px rgba(15,23,42,0.4);"><section style="display:flex;align-items:center;padding:9px 14px;background:#0F172A;"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#FF5F56;margin-right:7px;font-size:0;line-height:0;overflow:hidden;"><span leaf="">.</span></span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#FFBD2E;margin-right:7px;font-size:0;line-height:0;overflow:hidden;"><span leaf="">.</span></span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#27C93F;font-size:0;line-height:0;overflow:hidden;"><span leaf="">.</span></span><span style="margin-left:12px;font-size:12px;color:#64748B;font-family:Consolas,Monaco,monospace;letter-spacing:1px;"><span leaf="">${language}</span></span></section><section data-publish-code-lines="" style="padding:11px 14px;overflow-x:auto;">${renderedLines}</section></section>`;
}

function renderedBlocks(fragment: HtmlFragment): { blocks: RenderedWechatCodeBlock[]; unmarkedCodeCount: number } {
  const markerElements: HtmlElement[] = [];
  walk(fragment, (node) => {
    if (isElement(node) && getAttribute(node, RENDERED_INDEX_ATTRIBUTE) !== undefined) markerElements.push(node);
  });
  const blocks = markerElements.map((element): RenderedWechatCodeBlock => {
    if (element.tagName !== "section") throw fidelityError("Rendered WeChat code marker must be on <section>");
    const indexText = getAttribute(element, RENDERED_INDEX_ATTRIBUTE) ?? "";
    const tabSizeText = getAttribute(element, RENDERED_TAB_SIZE_ATTRIBUTE) ?? "";
    if (!/^(?:0|[1-9][0-9]*)$/u.test(indexText) || !/^(?:[1-9]|1[0-6])$/u.test(tabSizeText)) {
      throw fidelityError("Rendered WeChat code metadata is invalid", { index: indexText, tabSize: tabSizeText });
    }
    const lineElements: HtmlElement[] = [];
    walk(element, (node) => {
      if (isElement(node) && getAttribute(node, RENDERED_LINE_ATTRIBUTE) !== undefined) lineElements.push(node);
    });
    const lines = lineElements.map((line, position) => {
      const lineIndex = getAttribute(line, RENDERED_LINE_ATTRIBUTE) ?? "";
      if (lineIndex !== String(position)) {
        throw fidelityError("Rendered WeChat code lines must be contiguous and ordered", {
          block: Number(indexText),
          position,
          lineIndex,
        });
      }
      if (!DISPLAY_BLOCK.test(getAttribute(line, "style") ?? "")) {
        throw fidelityError("Every rendered WeChat code line must use display:block", {
          block: Number(indexText),
          line: position,
        });
      }
      return textContent(line).replaceAll("\u00A0", " ");
    });
    return {
      index: Number(indexText),
      language: normalizeLanguage(getAttribute(element, RENDERED_LANGUAGE_ATTRIBUTE)),
      tabSize: Number(tabSizeText),
      lines,
    };
  });
  const marked = new Set(markerElements);
  let unmarkedCodeCount = 0;
  walk(fragment, (node) => {
    if (!isElement(node)) return;
    const isBlockCode = node.tagName === "pre"
      || node.tagName === "code"
      || (node.tagName === "p" && CODE_STYLE.test(getAttribute(node, "style") ?? ""));
    if (!isBlockCode) return;
    let current: HtmlParent | undefined = node;
    while (current && isElement(current)) {
      if (marked.has(current)) return;
      current = parentOf(current);
    }
    unmarkedCodeCount += 1;
  });
  return { blocks, unmarkedCodeCount };
}

export function inspectRenderedWechatCodeBlocks(html: string): {
  blocks: RenderedWechatCodeBlock[];
  unmarkedCodeCount: number;
} {
  return renderedBlocks(parseFragment(html));
}

export function validateWechatCodeFidelity(
  markdown: string,
  candidateHtml: string,
  tabSize = WECHAT_CODE_TAB_SIZE,
): WechatCodeFidelityReport {
  const source = extractMarkdownCodeBlocks(markdown, tabSize);
  const rendered = inspectRenderedWechatCodeBlocks(candidateHtml);
  return compareBlocks(source, rendered.blocks, tabSize, rendered.unmarkedCodeCount);
}

export function assertWechatCodeFidelity(
  markdown: string,
  candidateHtml: string,
  tabSize = WECHAT_CODE_TAB_SIZE,
): WechatCodeFidelityReport {
  const report = validateWechatCodeFidelity(markdown, candidateHtml, tabSize);
  if (!report.ok) {
    throw fidelityError("Rendered WeChat code differs from the ArticlePackage Markdown", {
      report,
    });
  }
  return report;
}

export async function renderWechatCode(options: RenderWechatCodeOptions): Promise<RenderWechatCodeResult> {
  const tabSize = options.tabSize ?? WECHAT_CODE_TAB_SIZE;
  const blocks = extractMarkdownCodeBlocks(options.markdown, tabSize);
  const fragment = parseFragment(options.candidateHtml);
  const slots = slotTargets(fragment);
  const alreadyRendered = renderedTargets(fragment);
  let targets: ReplacementTarget[];
  let mode: RenderWechatCodeResult["mode"];
  if (slots.length > 0) {
    if (alreadyRendered.length > 0) throw fidelityError("Candidate mixes code slots with rendered code blocks");
    targets = slots;
    mode = "slots";
  } else if (alreadyRendered.length > 0) {
    targets = alreadyRendered;
    mode = "rendered";
  } else if (blocks.length === 0) {
    targets = [];
    mode = "none";
  } else if (options.allowLegacyDetection) {
    targets = legacyCodeTargets(fragment);
    mode = "legacy";
  } else {
    throw fidelityError("Candidate has Markdown code blocks but no explicit code slots", {
      expectedSlots: blocks.map((block) => `<!--${WECHAT_CODE_SLOT_PREFIX}${block.index}-->`),
    });
  }
  assertTargetContract(targets, blocks, mode);
  const renderedComponents = await Promise.all(blocks.map((block) => renderWechatCodeBlock(block, tabSize)));
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    replaceChild(targets[index]!, renderedComponents[index]!);
  }
  const html = `${serialize(fragment).trim()}\n`;
  const report = assertWechatCodeFidelity(options.markdown, html, tabSize);
  return { html, mode, report };
}

export async function readArticlePackageBody(article: ArticlePackage, packageRoot: string): Promise<string> {
  const relative = assertSafeRelative(article.body.path, "ArticlePackage body path");
  const bodyPath = await assertRealPathWithin(
    packageRoot,
    path.resolve(packageRoot, relative),
    "ArticlePackage body",
  );
  const body = await readFile(bodyPath, "utf8");
  const digest = sha256Bytes(body);
  if (digest !== article.body.sha256) {
    throw fidelityError("ArticlePackage body changed after packaging", {
      expected: article.body.sha256,
      actual: digest,
    });
  }
  return body;
}
