# Moyu Green style profile

## Visual intent

Create a relaxed editorial system that feels practical, clear, and slightly playful. Use green as navigation and emphasis, not as a full-canvas wash.

## Palette

```text
Primary       #059669
Primary dark  #065F46
Mint accent   #A7F3D0
Soft surface  #F0FDF4
Ink           #1F2937
Muted text    #64748B
```

## Illustration language

- Prefer editorial infographics, simple spatial metaphors, and hand-drawn accents.
- Keep one clear focal idea per image.
- Use generous whitespace and readable Chinese labels only when labels add real information.
- Keep cover composition strong at mobile thumbnail size.
- Keep inline illustrations subordinate to the article.
- Avoid neon cyberpunk, glossy 3D mascots, generic corporate stock art, heavy gradients, and dense tiny text.

## Default density

- Generate one cover.
- Generate two to four inline illustrations.
- Keep existing screenshots that prove UI, logs, code, or results.
- Skip an illustration when the surrounding text is already concrete and visually obvious.

## WeChat formatting

Use the external gzh-design `moyu-green` theme chosen by the user. Treat it as a separate AGPL toolchain. Record upstream identity in the local provenance sidecar and keep generated HTML out of Git.

Do not assume gzh assembly is byte-deterministic. Freeze and hash the reviewed HTML; publish that exact payload.
