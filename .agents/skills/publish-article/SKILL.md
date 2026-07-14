---
name: publish-article
description: Prepare, illustrate, format, validate, and publish a local Markdown article to this Hugo/PaperMod blog and a WeChat Official Account draft. Use when the user provides or refers to any local article path and asks to 同步文章、改造文章、发布博客、git push 自动部署、公众号排版、保存微信公众号草稿、为文章配图, or run the blog publishing workflow. Keep the source read-only, generate a frozen Blog candidate and a switchable styled WeChat preview (Moyu Green by default), show validation and diff, and require explicit confirmation before commit, push, or creating a WeChat draft.
---

# Publish Article

Transform one explicitly selected local Markdown article into a reviewed, immutable publication snapshot. Render the same snapshot for Hugo and WeChat, then publish only the confirmed endpoint plans.

## Resolve paths

Set these logical paths before running commands:

```text
REPO_ROOT=<repository containing this skill>
SKILL_DIR=<REPO_ROOT>/.agents/skills/publish-article
CLI=bun <SKILL_DIR>/scripts/src/cli.ts
```

Run CLI commands with argument arrays. Do not build shell strings from titles, summaries, account names, or user paths.

Read references only when needed:

- Read [references/article-package.md](references/article-package.md) when importing, editing, or repairing a package.
- Read [references/endpoint-contract.md](references/endpoint-contract.md) before preparing or publishing endpoints.
- Read [references/style-profiles.md](references/style-profiles.md) before selecting or changing a visual profile.
- Read [references/moyu-green-style.md](references/moyu-green-style.md) when the selected profile is `moyu-green`.
- Read [references/wechat-setup.md](references/wechat-setup.md) when the GZH or Baoyu preflight reports missing toolchain, account, or credentials.

## Enforce invariants

- Treat only the explicitly provided article as in scope. Never scan or bulk-import any directory or document vault.
- Keep the source Markdown and source images read-only. Work only inside the repository's ignored `.publish/` directory and the managed Hugo bundle.
- Preserve facts, code semantics, numbers, links, and the author's conclusions.
- Preserve useful existing screenshots. Generate 1 cover plus 2–4 inline illustrations by default.
- Build Blog and WeChat artifacts from the same immutable ArticlePackage revision.
- Treat creative output as nondeterministic until frozen. After preview, bind exact bytes with `renderDigest`; never re-render during publish.
- Keep credentials and previews out of Git.
- Never call, implement, or suggest `freepublish/submit`. The WeChat endpoint ends at a saved draft.
- Stop on ambiguous image paths, missing assets, toolchain drift, invalid HTML, build failures, stale confirmation, or unknown remote outcomes.

## Workflow

### 1. Import the explicit source

Resolve the user-provided file to an absolute path. Verify that it is a readable Markdown file.

Run:

```text
$CLI import --source <absolute-source.md>
```

Capture the returned `runRoot`. Confirm that import reports the source digest, parsed metadata, resource count, unresolved references, and remote image references. Stop if any local resource is ambiguous or missing. If `remoteImageReferences` is non-empty, the Blog candidate may continue, but ask for explicit authorization to download or replace those images before preparing WeChat.

### 2. Lightly edit the working copy

Edit only `<runRoot>/draft/body.md` and its draft metadata.

Improve:

- title and summary;
- heading hierarchy and paragraph rhythm;
- repeated wording and weak transitions;
- mobile readability.

Do not invent facts or rewrite the article into a different argument. Present material editorial changes to the user when judgment is required.

### 3. Select a style, then plan and generate illustrations

Read `config/style.json`. Use its `defaultProfile` unless the user chooses another registered profile. The profile is selected per run, so do not hardcode Moyu Green into article metadata or generated prompts. Analyze the article structure and choose positions where a visual materially improves understanding.

Prefer the installed `baoyu-article-illustrator` capability. If `.baoyu-skills/baoyu-article-illustrator/EXTEND.md` exists in the target project, load its preferences; otherwise derive Type × Style × Palette from the selected profile and the user's explicit choices. Run illustration work from `<runRoot>/working/` so it never writes beside the read-only source. Treat an explicit user choice of profile, type, or density as already answered; otherwise confirm Type and Density once before generation. Save the outline and prompt files before generation, and keep rejected variants in `working/`.

Create:

- one cover;
- two to four inline illustrations;
- no replacement for evidence-bearing screenshots unless explicitly requested.

Place final selected files under `<runRoot>/draft/assets/`. Add each selected file to `<runRoot>/draft/metadata.json` with a stable `id`, `file`, `role`, and `alt`; unlisted files intentionally fail packaging. Keep prompts and rejected variants under `<runRoot>/working/`.

### 4. Freeze the ArticlePackage

Run:

```text
$CLI package --run <runRoot>
```

Review the package report. Verify that the revision contains no timestamp, mtime, absolute source path, or secret.

### 5. Render the Blog candidate

Run:

```text
$CLI render-blog --run <runRoot>
```

Require:

- a repository `vercel.json` with `build.env.HUGO_VERSION` matching the deployment contract;
- `draft=false`;
- a non-future publication date;
- all `asset://` references resolved;
- Hugo build success;
- the target article HTML present in the build output;
- a scoped target-bundle diff.

Do not touch the live `<contentRoot>/<slug>/` bundle during prepare.

### 6. Produce and freeze the WeChat candidate

Resolve the external `gzh-design-skill` Git checkout from `--gzh-dir`, `GZH_DESIGN_SKILL_DIR`, or the ignored `.publish/toolchains/gzh-design-skill` location. Verify its locked origin, commit, license, and selected theme files. Read its instructions and the theme named by the selected profile. Do not copy its theme library into this repository.

Generate the candidate HTML once from the frozen ArticlePackage. Save it inside `<runRoot>/working/` and validate it with the upstream validator.

Run:

```text
$CLI freeze-wechat --run <runRoot> --html <candidate.html> --style <profile>
```

Require:

- WeChat payload HTML frozen without later reformatting;
- local images converted to valid JPG/PNG derivatives;
- no absolute path, `..`, WebP, unresolved `asset://`, script, or external stylesheet in the payload;
- preview bytes derived from the frozen payload;
- render manifest, renderDigest, and AGPL provenance sidecar present.

### 7. Prepare selected endpoints

Default to both registered targets unless the user explicitly narrows them:

```text
$CLI prepare --run <runRoot> --targets blog,wechat
```

Show the complete human-readable report, including:

- article revision and metadata;
- asset list and generated illustrations;
- Hugo version/build result;
- Blog diff;
- WeChat preview path and upload list;
- account alias without credentials;
- exact side effects per endpoint;
- one aggregate confirmation token bound to every selected endpoint plan.

Stop here and request explicit confirmation. Do not stage, commit, push, request a WeChat token, upload an image, or create a draft before confirmation.

### 8. Publish the confirmed plan

After explicit confirmation, run exactly once:

```text
$CLI publish --run <runRoot> --confirm <confirmation-token>
```

The Blog endpoint may apply the managed bundle, stage only its managed files, commit, and perform a lease-guarded fast-forward push. The exact-SHA `--force-with-lease` flag is used only as compare-and-swap after proving the new commit directly descends from the confirmed remote SHA; never use unconditional force, rewrite history, or run `git add .`.

The WeChat endpoint may run Baoyu dry-run with the same frozen inputs, verify the account and credentials source, upload frozen images, and create one draft. Never retry a real draft automatically.

Report endpoint receipts independently:

- `pushed`: include commit SHA and remote ref; report Vercel as unobserved unless separately checked.
- `draft_created`: include draft media ID and say that public publication remains manual.
- `partial`: state which side effect happened and the required manual cleanup.
- `outcome_unknown`: tell the user to inspect the remote target before any retry.

## Handle WeChat results strictly

Treat Baoyu `exit 0 + media_id` as complete only when stderr contains no known image upload failure marker.

If any body image upload fails but a draft ID exists, record `partial`, retain the draft ID, and instruct the user to inspect or delete the incomplete draft. Do not recreate it automatically.

If the child times out or its outcome cannot be proven, record `outcome_unknown`. Do not infer success and do not retry.

End every successful WeChat run with: “微信公众号草稿已保存，请前往公众平台人工预览并发布。”

## Validate changes

Before handing off implementation or Skill changes, run:

```text
cd <SKILL_DIR>/scripts
bun run typecheck
bun test

cd <REPO_ROOT>
python3 <skill-creator>/scripts/quick_validate.py .agents/skills/publish-article
git diff --check
hugo --destination <temporary-destination>
```

Keep `.publish/` and `.superpowers/` ignored. Show the final diff and wait for confirmation before committing or pushing Skill changes.
