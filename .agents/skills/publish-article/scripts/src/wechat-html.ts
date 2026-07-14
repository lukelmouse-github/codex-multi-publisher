import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { PublishError } from "./errors";
import { assertRealPathWithin, assertSafeRelative } from "./path-policy";
import { WECHAT_BODY_IMAGE_MAX_BYTES } from "./wechat-images";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
type HtmlParent = DefaultTreeAdapterMap["parentNode"];

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/u;
const HALF_PUNCTUATION = /[\u3400-\u4dbf\u4e00-\u9fff][,;!?]/u;
const ASCII_QUOTES = /["']/u;
const FORBIDDEN_TAGS = new Set(["style", "script", "div", "link"]);
const FORBIDDEN_STYLE = [
  /position\s*:\s*(?:fixed|absolute|sticky)/iu,
  /float\s*:/iu,
  /@media/iu,
  /@keyframes/iu,
  /@import/iu,
  /display\s*:\s*grid/iu,
  /var\s*\(\s*--/iu,
  /url\s*\([^)]*\.(?:woff2?|ttf|otf|eot)/iu,
] as const;
const CODE_STYLE = /monospace|white-space\s*:\s*pre|courier|consolas|sf mono/iu;
const PREVIEW_START = "<!--PUBLISH_ARTICLE_WECHAT_PAYLOAD_START-->";
const PREVIEW_END = "<!--PUBLISH_ARTICLE_WECHAT_PAYLOAD_END-->";

export type WechatHtmlMode = "candidate" | "frozen";

export interface WechatImageReference {
  index: number;
  src: string;
  alt?: string;
}

export interface WechatHtmlInspection {
  images: WechatImageReference[];
  leafSpanCount: number;
}

function htmlError(code: string, message: string, details?: Record<string, unknown>): PublishError {
  return new PublishError(code, message, { kind: "validation", details });
}

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function isParent(node: HtmlNode): node is HtmlParent {
  return "childNodes" in node;
}

function getAttribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name)?.value;
}

function hasAttribute(element: HtmlElement, name: string): boolean {
  return element.attrs.some((attribute) => attribute.name.toLowerCase() === name);
}

function walk(node: HtmlNode, visitor: (node: HtmlNode, ancestors: HtmlElement[]) => void, ancestors: HtmlElement[] = []): void {
  visitor(node, ancestors);
  if (!isParent(node)) return;
  const nextAncestors = isElement(node) ? [...ancestors, node] : ancestors;
  for (const child of node.childNodes) walk(child, visitor, nextAncestors);
  if (isElement(node) && node.tagName === "template" && "content" in node) {
    walk(node.content, visitor, nextAncestors);
  }
}

function meaningfulChildren(fragment: DefaultTreeAdapterMap["documentFragment"]): HtmlNode[] {
  return fragment.childNodes.filter((node) => {
    if (node.nodeName === "#comment") return false;
    if (node.nodeName === "#text" && "value" in node) return node.value.trim().length > 0;
    return true;
  });
}

function validateImageReference(src: string, mode: WechatHtmlMode): void {
  if (/^(?:https?:)?\/\//iu.test(src) || /^(?:data|blob|file):/iu.test(src)) {
    throw htmlError("E_WECHAT_IMAGE_REMOTE", `Image source must be a frozen local resource: ${src}`);
  }
  if (mode === "candidate" && src.startsWith("asset://")) {
    const id = src.slice("asset://".length);
    if (!id || !/^[A-Za-z0-9._-]+$/u.test(id)) {
      throw htmlError("E_WECHAT_ASSET_REFERENCE", `Invalid asset reference: ${src}`);
    }
    return;
  }
  if (src.includes("://")) {
    throw htmlError("E_WECHAT_IMAGE_SCHEME", `Unsupported image source scheme: ${src}`);
  }
  const relative = assertSafeRelative(src, "WeChat image source");
  if (mode === "frozen" && !/\.(?:jpe?g|png)$/iu.test(path.posix.extname(relative))) {
    throw htmlError("E_WECHAT_IMAGE_FORMAT", `Frozen WeChat image must be JPG or PNG: ${src}`);
  }
}

export function normalizeWechatHtml(html: string): string {
  const normalized = html.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  if (!normalized) throw htmlError("E_WECHAT_HTML_EMPTY", "WeChat HTML is empty");
  return `${normalized}\n`;
}

export function inspectWechatHtml(html: string, mode: WechatHtmlMode = "candidate"): WechatHtmlInspection {
  const parseErrors: string[] = [];
  const fragment = parseFragment(html, {
    onParseError(error) {
      parseErrors.push(error.code);
    },
  });
  if (parseErrors.length > 0) {
    throw htmlError("E_WECHAT_HTML_PARSE", "WeChat HTML contains parser errors", { errors: parseErrors });
  }

  const roots = meaningfulChildren(fragment);
  if (roots.length !== 1 || !isElement(roots[0]!) || roots[0]!.tagName !== "section") {
    throw htmlError("E_WECHAT_HTML_ROOT", "WeChat HTML must be one clean <section> fragment");
  }

  const images: WechatImageReference[] = [];
  let leafSpanCount = 0;
  walk(fragment, (node, ancestors) => {
    if (isElement(node)) {
      const tagName = node.tagName.toLowerCase();
      if (FORBIDDEN_TAGS.has(tagName)) {
        throw htmlError("E_WECHAT_HTML_FORBIDDEN_TAG", `Forbidden WeChat HTML tag: <${tagName}>`);
      }
      if (hasAttribute(node, "class") || hasAttribute(node, "id")) {
        throw htmlError("E_WECHAT_HTML_FORBIDDEN_ATTRIBUTE", `class/id is forbidden on <${tagName}>`);
      }
      const style = getAttribute(node, "style") ?? "";
      for (const pattern of FORBIDDEN_STYLE) {
        if (pattern.test(style)) {
          throw htmlError("E_WECHAT_HTML_FORBIDDEN_STYLE", `Unsupported inline style on <${tagName}>`);
        }
      }
      if (tagName === "span" && hasAttribute(node, "leaf")) leafSpanCount += 1;

      if (tagName === "img") {
        if (hasAttribute(node, "srcset")) {
          throw htmlError("E_WECHAT_IMAGE_SRCSET", "srcset is not allowed because every image byte must be frozen");
        }
        const src = getAttribute(node, "src")?.trim();
        if (!src) throw htmlError("E_WECHAT_IMAGE_SRC", "Every <img> must have a non-empty src");
        validateImageReference(src, mode);
        images.push({ index: images.length, src, alt: getAttribute(node, "alt") || undefined });
      }
      return;
    }

    if (node.nodeName !== "#text") return;
    const text = node.value.trim();
    if (!text || !CJK.test(text)) return;
    const insideLeaf = ancestors.some((ancestor) => ancestor.tagName === "span" && hasAttribute(ancestor, "leaf"));
    if (!insideLeaf) {
      throw htmlError("E_WECHAT_HTML_LEAF", "Chinese text must be wrapped by <span leaf=\"\">");
    }
    const insideCode = ancestors.some((ancestor) => {
      const style = getAttribute(ancestor, "style") ?? "";
      return ancestor.tagName === "code" || ancestor.tagName === "pre" || CODE_STYLE.test(style);
    });
    if (!insideCode && (HALF_PUNCTUATION.test(text) || ASCII_QUOTES.test(text))) {
      throw htmlError("E_WECHAT_HTML_PUNCTUATION", "Chinese prose contains half-width punctuation or ASCII quotes");
    }
  });

  if (CJK.test(html) && leafSpanCount === 0) {
    throw htmlError("E_WECHAT_HTML_LEAF", "WeChat HTML has no <span leaf=\"\"> wrappers");
  }
  return { images, leafSpanCount };
}

export function rewriteWechatImageSources(html: string, replacements: ReadonlyMap<string, string>): string {
  const fragment = parseFragment(html);
  const seen = new Set<string>();
  walk(fragment, (node) => {
    if (!isElement(node) || node.tagName !== "img") return;
    const src = getAttribute(node, "src")?.trim();
    if (!src) throw htmlError("E_WECHAT_IMAGE_SRC", "Every <img> must have a non-empty src");
    const replacement = replacements.get(src);
    if (!replacement) {
      throw htmlError("E_WECHAT_IMAGE_UNRESOLVED", `No frozen image exists for ${src}`);
    }
    validateImageReference(replacement, "frozen");
    const attribute = node.attrs.find((item) => item.name.toLowerCase() === "src");
    if (!attribute) throw htmlError("E_WECHAT_IMAGE_SRC", "Every <img> must have a src");
    attribute.value = replacement;
    seen.add(src);
  });

  for (const source of replacements.keys()) {
    if (!seen.has(source)) {
      throw htmlError("E_WECHAT_IMAGE_UNUSED", `Frozen image mapping is unused: ${source}`);
    }
  }

  const rewritten = normalizeWechatHtml(serialize(fragment));
  inspectWechatHtml(rewritten, "frozen");
  return rewritten;
}

export async function validateFrozenWechatImageFiles(
  html: string,
  frozenRoot: string,
): Promise<WechatImageReference[]> {
  const inspection = inspectWechatHtml(html, "frozen");
  const checked = new Set<string>();
  for (const image of inspection.images) {
    if (checked.has(image.src)) continue;
    checked.add(image.src);
    const relative = assertSafeRelative(image.src, "frozen WeChat image");
    const absolute = path.resolve(frozenRoot, relative);
    const realPath = await assertRealPathWithin(frozenRoot, absolute, `frozen WeChat image ${relative}`);
    const bytes = await readFile(realPath);
    if (bytes.byteLength > WECHAT_BODY_IMAGE_MAX_BYTES) {
      throw htmlError("E_WECHAT_IMAGE_TOO_LARGE", `Frozen body image exceeds 1 MiB: ${relative}`, {
        bytes: bytes.byteLength,
        maxBytes: WECHAT_BODY_IMAGE_MAX_BYTES,
      });
    }
    let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      metadata = await sharp(bytes, { failOn: "error", animated: false }).metadata();
    } catch (error) {
      throw htmlError("E_WECHAT_IMAGE_DECODE", `Cannot decode frozen image: ${relative}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const expectedFormat = /\.png$/iu.test(relative) ? "png" : "jpeg";
    if (metadata.format !== expectedFormat) {
      throw htmlError("E_WECHAT_IMAGE_FORMAT", `Image extension and bytes disagree: ${relative}`, {
        expectedFormat,
        actualFormat: metadata.format,
      });
    }
  }
  return inspection.images;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildWechatPreview(payloadHtml: string, title: string): string {
  if (payloadHtml.includes(PREVIEW_START) || payloadHtml.includes(PREVIEW_END)) {
    throw htmlError("E_WECHAT_PREVIEW_SENTINEL", "Payload contains a reserved preview marker");
  }
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
body{margin:0;background:#f3f4f6;color:#111827;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.toolbar{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:12px 18px;background:#fff;border-bottom:1px solid #e5e7eb}
.paper{max-width:677px;margin:24px auto;padding:28px 24px;background:#fff;box-shadow:0 8px 30px rgba(15,23,42,.08)}
button{border:0;border-radius:999px;padding:9px 16px;background:#059669;color:#fff;font-weight:700;cursor:pointer}
</style>
</head>
<body>
<div class="toolbar"><strong>${safeTitle}</strong><button id="copy">复制到公众号</button></div>
<main class="paper" id="wechat-preview-payload">${PREVIEW_START}${payloadHtml}${PREVIEW_END}</main>
<script>
document.getElementById("copy").addEventListener("click",async()=>{
  const source=document.getElementById("wechat-preview-payload");
  const clone=source.cloneNode(true);const walker=document.createTreeWalker(clone,NodeFilter.SHOW_COMMENT);const comments=[];while(walker.nextNode())comments.push(walker.currentNode);comments.forEach(node=>node.remove());const html=clone.innerHTML;
  if(window.ClipboardItem&&navigator.clipboard?.write){
    await navigator.clipboard.write([new ClipboardItem({"text/html":new Blob([html],{type:"text/html"}),"text/plain":new Blob([source.innerText],{type:"text/plain"})})]);
  }else{
    const range=document.createRange();range.selectNodeContents(source);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.execCommand("copy");selection.removeAllRanges();
  }
});
</script>
</body>
</html>
`;
}

export function extractWechatPreviewPayload(previewHtml: string): string {
  const start = previewHtml.indexOf(PREVIEW_START);
  const end = previewHtml.indexOf(PREVIEW_END, start + PREVIEW_START.length);
  if (start < 0 || end < 0 || previewHtml.indexOf(PREVIEW_START, start + 1) >= 0 || previewHtml.indexOf(PREVIEW_END, end + 1) >= 0) {
    throw htmlError("E_WECHAT_PREVIEW_PAYLOAD", "Preview does not contain exactly one frozen payload");
  }
  return previewHtml.slice(start + PREVIEW_START.length, end);
}
