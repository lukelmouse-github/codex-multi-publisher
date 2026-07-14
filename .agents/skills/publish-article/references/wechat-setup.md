# WeChat endpoint setup

## gzh-design checkout

Keep `isjiamu/gzh-design-skill` outside tracked source. The default resolver looks in:

1. `--gzh-dir`;
2. `GZH_DESIGN_SKILL_DIR`;
3. `<repo>/.publish/toolchains/gzh-design-skill`;
4. `~/.agents/skills/gzh-design-skill`;
5. `$CODEX_HOME/skills/gzh-design-skill`.

It must be a Git checkout at the exact revision recorded in `toolchain.lock.json`. The resolver does not clone or update it automatically. Do not bypass an origin, revision, license, or file-hash mismatch.

## Account alias

The target Blog keeps non-secret account preferences in `.baoyu-skills/baoyu-post-to-wechat/EXTEND.md`. Start from `examples/baoyu-post-to-wechat-EXTEND.md` in the distribution repository. The example endpoint uses the alias `example-account`. Replace it consistently in `config/endpoints.json`, the Baoyu account preferences, and the credential names below. Do not add `app_id` or `app_secret` to account preferences.

## Credentials

Provide credentials with account-prefixed variables:

```text
WECHAT_EXAMPLE_ACCOUNT_APP_ID
WECHAT_EXAMPLE_ACCOUNT_APP_SECRET
```

They may live in the process environment or the ignored `.baoyu-skills/.env`. Never print their values, write them to receipts, or fall back silently to credentials for another account.

Preflight records only a one-way AppID identity digest, never the AppID or AppSecret. That digest is part of the provider fingerprint, so replacing credentials for the same alias invalidates confirmation. Prefer process environment variables during publication to avoid mutable credential-file races.

`prepare` reads the credential source and executes Baoyu `--dry-run`; it does not request a WeChat access token, upload images, or create a draft. The provider fingerprint covers the entire frozen artifact tree, including every body image, and is checked again after the final dry-run. `publish` is the first phase allowed to contact WeChat, and it may only create a private draft. Public publication remains a manual action in the WeChat platform.
