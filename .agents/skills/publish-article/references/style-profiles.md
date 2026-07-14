# Style profiles

Visual style is a per-run input, not a permanent property of the publishing pipeline.

## Select a profile

Read `config/style.json` and choose one key from `profiles`. If the user does not choose, use `defaultProfile`. Pass the same profile to illustration prompts and `freeze-wechat --style` so the cover, inline art, and WeChat layout remain coherent.

For `baoyu-article-illustrator`, translate the profile into its Type × Style × Palette model. `moyu-green` normally uses content-appropriate Type, `editorial` or `notion` Style, and the exact custom green palette from `config/style.json`; do not substitute its unrelated built-in `neon`, `warm`, or `macaron` palettes.

The current default is `moyu-green`. It is a default, not a hardcoded requirement.

## Add or switch a profile

To register another profile:

1. Add a new entry under `profiles` with its palette, illustration direction, avoid list, and WeChat provider/theme mapping.
2. If it uses `gzh-design-skill`, add the exact upstream theme path and SHA-256 to `toolchain.lock.json` at the already pinned upstream commit.
3. Keep the upstream checkout external and ignored; do not vendor AGPL theme source into this repository.
4. Run the GZH resolver tests and freeze tests before selecting it.

Never silently fall back to another profile. An unknown or unlocked style must stop the run.

## Maintain frozen output

Style generation may involve model judgment. Review the candidate once, then freeze the exact HTML and derived image bytes. Publication must consume the frozen render digest and must not regenerate the style after confirmation.
