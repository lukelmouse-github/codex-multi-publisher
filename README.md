# Codex Multi Publisher

Codex Multi Publisher is a project-local Codex Skill for preparing one Markdown article and publishing the reviewed result to two endpoints:

- a Hugo/PaperMod blog through a scoped Git commit and push;
- a WeChat Official Account as a private draft through the WeChat API.

The source article remains read-only. Both endpoints are derived from the same immutable `ArticlePackage`, but each receives its own frozen channel candidate. The workflow shows the Blog diff and WeChat preview before it asks for one explicit confirmation.

> This repository provides the publishing workflow and local validation. It does not prove that a particular WeChat account, network, Git remote, Hugo site, or deployment provider is configured correctly. Real access remains environment-specific.

## Capabilities

- Import one explicitly selected local Markdown file and its referenced local images.
- Normalize metadata, body references, and assets into a channel-neutral `ArticlePackage`.
- Keep mutable editing and illustration work under the ignored `.publish/` directory.
- Render a Hugo leaf-bundle candidate without touching the live configured content bundle during preparation.
- Freeze WeChat-compatible HTML and JPG/PNG derivatives with a `renderDigest` and local preview.
- Prepare any registered subset of the `blog` and `wechat` endpoints.
- Bind the article revision, exact channel bytes, endpoint options, Git baseline, account, and actions into one confirmation token.
- After confirmation, apply only the managed Blog bundle, create a scoped commit, perform a lease-guarded fast-forward push, and/or create one private WeChat draft.
- Persist independent endpoint receipts for recovery and duplicate protection.

The bundled style registry defaults to `moyu-green`. Additional profiles can be added deliberately through the Skill configuration and renderer contract.

## Deliberate boundaries

- It never scans a document vault or imports a directory in bulk.
- It never edits the source Markdown or source images.
- It never calls WeChat `freepublish/submit`; public WeChat publication is always manual.
- It does not report a WeChat draft as a public article.
- It does not observe Vercel deployment status. A verified Git push is the Blog endpoint's success boundary.
- It does not automatically retry an operation whose remote outcome is unknown.
- The CLI does not invent a WeChat layout. A Codex agent follows the Skill and the locked `gzh-design-skill` contract to produce candidate HTML, which the CLI then validates and freezes.
- AI illustration is optional and requires a separately installed image-generation capability. Existing local images can be used instead.

## How it works

```text
local Markdown (read-only)
        |
        v
draft editing and image selection
        |
        v
ArticlePackage revision
        |
        +---------------------+
        |                     |
        v                     v
Hugo candidate          frozen WeChat candidate
        |                     |
        v                     v
blog-git plan           wechat-draft plan
        \                     /
         \                   /
          unified report and confirmation
                      |
                      v
             independent receipts
```

The important identities are:

- `revision`: the publication-relevant article metadata, normalized body, and sorted asset hashes;
- `renderDigest`: the exact channel candidate selected for publication;
- `planDigest`: the target, options, baseline, candidate, and ordered actions;
- confirmation token: authorization for that exact aggregate plan;
- receipt: the durable record of what actually happened at one endpoint.

## Requirements

### Core

- A Codex-compatible agent that discovers project-local Skills under `.agents/skills/`.
- [Bun](https://bun.sh/) for the TypeScript CLI and dependencies.
- Git with a configured upstream and push URL for the Blog endpoint.
- Hugo installed locally.
- Python 3 for the upstream WeChat HTML validator.
- A Hugo site that uses leaf bundles below the configured content root. `contentRoot` must be `content` or a directory below `content/`; the default is `content/posts`, and the renderer is designed for PaperMod metadata.
- A `vercel.json` containing `build.env.HUGO_VERSION`, even when another system performs the final deployment.

### External publishing tools

- [`JimLiu/baoyu-skills`](https://github.com/JimLiu/baoyu-skills), specifically its `baoyu-post-to-wechat` Skill at the version and file hashes recorded in `toolchain.lock.json`.
- [`isjiamu/gzh-design-skill`](https://github.com/isjiamu/gzh-design-skill) checked out at the exact revision recorded in `toolchain.lock.json`.
- Optionally, `baoyu-article-illustrator` or another image generator when the agent should create illustrations.

The publisher verifies locked third-party files and stops on version or hash drift. It does not automatically clone or update these dependencies.

### WeChat account

- A WeChat Official Account AppID and AppSecret.
- API access for access tokens, content-image upload, permanent material upload, and `draft/add`.
- The public egress IP of the machine running `publish` in the account's API IP allowlist.
- A stable account alias shared by `config/endpoints.json`, the Baoyu `EXTEND.md`, and credential variable names.

Account type, verification state, API quota, and interface availability are controlled by WeChat and must be checked in the account console.

## Install the Skill into a Hugo repository

The Skill calculates its default repository root from its own location, so copy the complete directory into the Hugo repository that it will manage:

```bash
DISTRIBUTION_ROOT=/absolute/path/to/codex-multi-publisher
HUGO_REPOSITORY=/absolute/path/to/hugo-repository

mkdir -p "$HUGO_REPOSITORY/.agents/skills"
cp -R "$DISTRIBUTION_ROOT/.agents/skills/publish-article" \
  "$HUGO_REPOSITORY/.agents/skills/publish-article"

cd "$HUGO_REPOSITORY/.agents/skills/publish-article/scripts"
bun install --frozen-lockfile
```

Do not copy only `SKILL.md`; the CLI, references, configuration, lock file, license, and third-party notices are part of the distribution.

Merge these rules into the target repository's root `.gitignore` before running the Skill:

```gitignore
/.publish/
/.baoyu-skills/.env
```

After creating the local paths, verify the rules from the target repository:

```bash
git check-ignore .publish/probe .baoyu-skills/.env
```

Both paths must be reported as ignored. The Blog endpoint stages only its managed article bundle, but this repository-level guard also protects ordinary manual Git commands.

Install `baoyu-post-to-wechat` using its upstream instructions. Place it at one of the locations described in the Skill, or export an explicit path:

```bash
export BAOYU_POST_TO_WECHAT_DIR=/absolute/path/to/baoyu-post-to-wechat
```

Clone `gzh-design-skill` outside tracked source, then check out the exact `gzhDesignSkill.revision` from `.agents/skills/publish-article/toolchain.lock.json`:

```bash
cd "$HUGO_REPOSITORY"
mkdir -p .publish/toolchains
git clone https://github.com/isjiamu/gzh-design-skill.git \
  .publish/toolchains/gzh-design-skill
GZH_REVISION="$(python3 -c 'import json; print(json.load(open(".agents/skills/publish-article/toolchain.lock.json"))["gzhDesignSkill"]["revision"])')"
git -C .publish/toolchains/gzh-design-skill checkout "$GZH_REVISION"
```

Alternatively, keep the checkout elsewhere and export:

```bash
export GZH_DESIGN_SKILL_DIR=/absolute/path/to/gzh-design-skill
```

## Configure the Hugo endpoint

Edit `.agents/skills/publish-article/config/endpoints.json` in the target Hugo repository:

```json
{
  "schemaVersion": 1,
  "defaultTargets": ["blog", "wechat"],
  "endpoints": {
    "blog": {
      "driver": "blog-git",
      "branch": "main",
      "remote": "origin",
      "contentRoot": "content/posts"
    },
    "wechat": {
      "driver": "wechat-draft-baoyu",
      "account": "example-account",
      "mode": "draft"
    }
  }
}
```

The Blog endpoint expects:

- the current branch to match `branch`;
- `HEAD`, its upstream, and the observed remote branch to match at preparation time;
- no unrelated staged files;
- the configured push URL to remain unchanged after confirmation;
- the remote SHA to remain at the confirmed baseline until the guarded push.

Add the deployed Hugo version to `vercel.json`. Replace the example with the exact version used by your deployment:

```json
{
  "build": {
    "env": {
      "HUGO_VERSION": "0.163.1"
    }
  }
}
```

Preparation runs a local Hugo build and checks that the target article HTML exists. A local/deployed version difference is reported; it is not silently ignored.

## Configure the WeChat endpoint

Create `.baoyu-skills/baoyu-post-to-wechat/EXTEND.md` in the target repository. You can copy [`examples/baoyu-post-to-wechat-EXTEND.md`](examples/baoyu-post-to-wechat-EXTEND.md) from this distribution, or create the equivalent configuration below. Keep credentials out of this file:

```bash
mkdir -p .baoyu-skills/baoyu-post-to-wechat
cp "$DISTRIBUTION_ROOT/examples/baoyu-post-to-wechat-EXTEND.md" \
  .baoyu-skills/baoyu-post-to-wechat/EXTEND.md
```

```yaml
default_theme: default
default_publish_method: api

accounts:
  - name: Example Account
    alias: example-account
    default: true
    default_publish_method: api
    default_author: Example Author
    need_open_comment: 1
    only_fans_can_comment: 0
```

The alias `example-account` becomes `EXAMPLE_ACCOUNT` in environment-variable names. Copy the distribution template into the target repository and fill it locally:

```bash
mkdir -p .baoyu-skills
cp "$DISTRIBUTION_ROOT/.env.example" .baoyu-skills/.env
chmod 600 .baoyu-skills/.env
```

```dotenv
WECHAT_EXAMPLE_ACCOUNT_APP_ID=your_app_id
WECHAT_EXAMPLE_ACCOUNT_APP_SECRET=your_app_secret
```

Account-prefixed credentials are required by default. Do not commit `.baoyu-skills/.env`, print its contents, or place AppID/AppSecret values in `EXTEND.md`.

### IP allowlist

In the WeChat Official Account console, add the public egress IP of the process that will run the `publish` command to the API IP allowlist.

- Use the public egress address, not `127.0.0.1` or a private LAN address.
- A VPN, proxy, mobile network, or dynamic ISP address may change the observed egress IP.
- If publication runs on CI or a server, allowlist that runner's stable egress IP, not a developer laptop's IP.

`prepare` checks the credential source and runs Baoyu's local `--dry-run`, but it deliberately does not request a WeChat access token. Therefore `prepare` cannot prove that the AppSecret, IP allowlist, API permissions, or quota are valid. The first confirmed `publish` is the first WeChat API operation allowed to upload assets and create a draft.

## Complete CLI workflow

Run commands from the target Hugo repository:

```bash
CLI=.agents/skills/publish-article/scripts/src/cli.ts
```

### 1. Import one source article

```bash
SOURCE=/absolute/path/to/article.md
bun "$CLI" import --source "$SOURCE"
```

Record the returned `runRoot`. The command copies normalized working assets under `.publish/`; it does not edit the source tree.

```bash
RUN_ROOT=/absolute/path/printed/by/import
```

### 2. Review the mutable draft

Review and, when needed, edit only:

```text
<runRoot>/draft/body.md
<runRoot>/draft/metadata.json
<runRoot>/draft/assets/
```

Ensure metadata includes a non-empty title, slug, summary, author, and language. The Blog target additionally requires a non-future `publishedAt`. A WeChat `news` draft requires a cover asset. Every file under `draft/assets/` must be listed in `draft/metadata.json`.

### 3. Freeze the channel-neutral article package

```bash
bun "$CLI" package --run "$RUN_ROOT"
```

Any content or asset change after this point requires a new package revision.

### 4. Render and validate the Blog candidate

```bash
bun "$CLI" render-blog --run "$RUN_ROOT"
```

This writes only to the ignored run directory. It does not replace the live Blog bundle.

### 5. Produce the WeChat candidate HTML

Ask the agent to follow `SKILL.md`, the selected style profile, and the locked `gzh-design-skill` theme. Save the generated candidate under the run's `working/` directory, for example:

```text
<runRoot>/working/wechat-candidate.html
```

This is intentionally an agent-guided creative step; there is no CLI subcommand that invents the layout.

### 6. Validate and freeze the WeChat candidate

```bash
bun "$CLI" freeze-wechat \
  --run "$RUN_ROOT" \
  --html "$RUN_ROOT/working/wechat-candidate.html" \
  --style moyu-green
```

The frozen candidate contains validated HTML, JPG/PNG image derivatives, a local preview, a render manifest, and third-party provenance. Publishing reuses these exact bytes instead of rendering again.

### 7. Prepare endpoint plans

Prepare both endpoints:

```bash
bun "$CLI" prepare --run "$RUN_ROOT" --targets blog,wechat
```

Or prepare one endpoint explicitly:

```bash
bun "$CLI" prepare --run "$RUN_ROOT" --targets blog
bun "$CLI" prepare --run "$RUN_ROOT" --targets wechat
```

Read the returned preparation report. It includes the Blog diff, Hugo result, WeChat preview path, upload list, account alias, exact side effects, and one aggregate confirmation token.

Stop here until a human has reviewed the report and preview.

### 8. Publish the exact confirmed plan

```bash
CONFIRMATION_TOKEN=confirm:v1:replace-with-token-from-prepare
bun "$CLI" publish --run "$RUN_ROOT" --confirm "$CONFIRMATION_TOKEN"
```

For the Blog endpoint, this can replace the managed bundle, stage only that path, create a commit, and perform an exact-lease fast-forward push. For WeChat, this can upload the frozen images and create one private draft. Endpoint results are recorded independently.

### 9. Inspect recorded status

```bash
bun "$CLI" status --run "$RUN_ROOT"
```

Blog status can compare the receipt commit with the bound remote branch. WeChat status is reported as unsupported because the adapter does not expose a safe draft-status lookup contract; inspect the account's draft box when manual verification is required.

## Failure and retry rules

| Result | Meaning | Required action |
| --- | --- | --- |
| `failed` / `not_applied` | No target-side effect was proven | Fix the cause and prepare again; retry only when explicitly safe |
| `committed` | Blog commit exists but push is pending or failed | Preserve the receipt and resume the guarded push path |
| `partial` | Some side effect occurred | Follow the endpoint checkpoint; inspect or clean up before proceeding |
| `outcome_unknown` | Success or failure cannot be proven | Inspect Git remote or WeChat drafts before any retry |
| `pushed` | The Blog remote branch was verified at the receipt commit | Do not create another commit for the same plan |
| `draft_created` | One private WeChat draft was created without a known image-upload failure | Review and publish it manually in WeChat |

If WeChat returns a draft media ID while reporting a body-image upload failure, the result is `partial`, not success. Do not automatically recreate the draft.

## Security model

- Source files and source images are read-only.
- Temporary work, previews, receipts, journals, and credentials remain outside Git.
- Absolute paths, `..` traversal, symlinks, unresolved assets, unsupported WeChat image formats, and toolchain drift are rejected.
- A confirmation token is valid only for the exact article revision, render bytes, endpoint options, Git baseline, account identity, and ordered actions shown in the preparation report.
- Changing content, style, target branch, push URL, remote SHA, bound account AppID/identity, or locked tool files invalidates the plan. Rotating only the AppSecret may instead surface as an authentication result at publish time.
- The Blog endpoint stages only its managed bundle and never runs `git add .`.
- The exact `--force-with-lease=<ref>:<confirmed-sha>` form is used as compare-and-swap protection only after proving that the new commit directly descends from the confirmed SHA. It is not permission to rewrite history.
- Secrets and access tokens are redacted from diagnostics and never stored in receipts.
- WeChat public publication is outside the automated boundary.

Keep `.publish/` until all endpoint outcomes are resolved; deleting receipts or journals weakens recovery and duplicate protection.

## Minimal example

[`examples/minimal-article/article.md`](examples/minimal-article/article.md) contains three short paragraphs and three local, anonymous SVG illustrations. The first image is also selected as the cover through `coverAssetId`, so the example does not require a fourth image. It is an input fixture, not a standalone Hugo site; the target repository still needs the Hugo, Git, and endpoint prerequisites described above.

SVG is accepted as a source asset. The WeChat freezer derives API-compatible JPG/PNG files before publication.

## Validation

From the Skill scripts directory:

```bash
bun run typecheck
bun test
```

Run a Hugo build in the target repository as an additional site-level check. Real WeChat draft creation should only be attempted with a dedicated test article after credentials, account permissions, and the IP allowlist have been reviewed.

## Documentation

- [Architecture and failure model](docs/architecture.md)
- [Adding a publisher endpoint](docs/adding-an-endpoint.md)
- [Skill workflow](.agents/skills/publish-article/SKILL.md)
- [ArticlePackage contract](.agents/skills/publish-article/references/article-package.md)
- [Publisher endpoint contract](.agents/skills/publish-article/references/endpoint-contract.md)
- [Style profiles](.agents/skills/publish-article/references/style-profiles.md)
- [Moyu Green rendering rules](.agents/skills/publish-article/references/moyu-green-style.md)
- [WeChat setup](.agents/skills/publish-article/references/wechat-setup.md)
- [Pinned third-party toolchains](.agents/skills/publish-article/toolchain.lock.json)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

This repository is licensed under the [MIT License](LICENSE).

Third-party tools remain under their own licenses. See [Third-party notices](THIRD_PARTY_NOTICES.md) before redistribution or production use.
