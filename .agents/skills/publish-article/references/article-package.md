# ArticlePackage reference

## Contents

1. Directory layout
2. Identity and revision
3. Metadata
4. Assets
5. Draft workspace

## Directory layout

Use this immutable package layout:

```text
package/
├── article.json
├── body.md
└── assets/
    └── <asset-id>-<hash>.<ext>
```

Keep paths relative to `package/`. Reject absolute paths, `..`, and symlinks resolving outside the package.

## Identity and revision

- Keep `articleId` stable across title or slug changes.
- Compute `revision` from canonical publication metadata, normalized body bytes, and sorted asset hashes.
- Exclude timestamps, mtimes, absolute local paths, preview files, receipts, and credentials.
- Represent hashes as `sha256:<lowercase-hex>`.
- Rewrite body images to `asset://<asset-id>` before calculating the revision.

## Metadata

Require:

```text
title
slug
summary
author
language
```

Allow optional `publishedAt`, `updatedAt`, `tags`, `categories`, and `coverAssetId`. Preserve an existing publication date when updating. The channel-neutral package may omit `publishedAt`; the Hugo renderer requires a valid, non-future date while `buildFuture=false`.

## Assets

Record for each asset:

```text
id, path, sha256, bytes, mediaType, role, alt
```

Use content-derived names. Preserve evidence-bearing screenshots. Store Blog-optimized originals in the package; derive WeChat JPG/PNG files only inside the WeChat render directory.

## Draft workspace

Keep mutable creative work outside the immutable package:

```text
<runRoot>/
├── draft/
│   ├── body.md
│   ├── metadata.json
│   └── assets/
├── working/
├── package/
├── renders/
└── receipts/
```

Never write into the original source directory.
