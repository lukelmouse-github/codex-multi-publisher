import { appendFile } from "node:fs/promises";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const mode = dryRun
  ? (process.env.FAKE_BAOYU_DRY_MODE ?? "success")
  : (process.env.FAKE_BAOYU_DRAFT_MODE ?? "success");

if (process.env.FAKE_BAOYU_CALL_LOG) {
  await appendFile(process.env.FAKE_BAOYU_CALL_LOG, `${JSON.stringify({ dryRun, args })}\n`);
}

if (mode === "timeout") {
  await Bun.sleep(Number(process.env.FAKE_BAOYU_TIMEOUT_MS ?? 10_000));
}

if (mode === "malformed") {
  process.stdout.write("not-json\n");
  process.exit(0);
}

if (mode === "auth-error") {
  process.stderr.write("Error: Access token error 40164: invalid ip 203.0.113.10\n");
  process.exit(1);
}

if (mode === "draft-error") {
  process.stderr.write("Error: Publish failed 45009: reach max api daily quota limit\n");
  process.exit(1);
}

if (mode === "secret-error") {
  process.stderr.write(
    "Error: request https://api.example.invalid/token?appid=fixture-app-id&secret=fixture-app-secret&access_token=fixture-access-token failed\n",
  );
  process.exit(1);
}

const valueAfter = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

if (dryRun) {
  process.stderr.write("[wechat-api] Using HTML fixture\n");
  process.stdout.write(`${JSON.stringify({
    articleType: "news",
    title: valueAfter("--title") ?? "Fixture title",
    author: valueAfter("--author"),
    digest: valueAfter("--summary"),
    htmlPath: args[0],
    contentLength: 321,
    placeholderImageCount: 2,
    account: valueAfter("--account"),
  }, null, 2)}\n`);
  process.exit(0);
}

if (mode === "partial") {
  process.stderr.write("[wechat-api] Failed to upload placeholder WECHATIMGPH_1: Error: Upload failed 40005\n");
}

if (mode === "missing-media") {
  process.stdout.write(`${JSON.stringify({ success: true, title: valueAfter("--title"), articleType: "news" })}\n`);
  process.exit(0);
}

process.stderr.write("[wechat-api] Published successfully! media_id: fixture-media-id\n");
process.stdout.write(`${JSON.stringify({
  success: true,
  media_id: process.env.FAKE_BAOYU_MEDIA_ID ?? "fixture-media-id",
  title: valueAfter("--title") ?? "Fixture title",
  articleType: "news",
}, null, 2)}\n`);
