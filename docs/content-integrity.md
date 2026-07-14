# Publication content-integrity design

The pipeline treats platform rendering as a data-integrity boundary, not only a visual formatting step.

## Failure model

Two classes of drift must stop before publication:

1. A Blog theme or local layout override changes the DOM contract required by the active typography CSS.
2. A WeChat candidate remains valid HTML but changes Markdown code lines, indentation, ordering, or language metadata.

Platform syntax validation alone cannot detect either failure.

## Required invariants

- `ArticlePackage` remains the channel-neutral source of truth.
- A Hugo build is successful only when the generated article contains PaperMod's `post-content md-content` container.
- Every fenced Markdown code block has a stable ordinal and language label.
- WeChat code HTML is produced by the deterministic serializer, never copied from model-authored line markup.
- Tabs use one declared expansion rule; every remaining ASCII space is represented with a non-collapsing entity.
- Every source line maps to one rendered line, including empty lines.
- Freezing compares source and rendered code projections and fails on any mismatch.
- Confirmation binds the exact Blog tree and frozen WeChat render digest after all integrity checks pass.

## Boundary between design and data

The selected style profile may control colors, containers, captions, and other presentation. It may not rewrite code content. The external `gzh-design-skill` remains a pinned theme reference and platform validator; project-owned code performs the final code serialization and fidelity check. This keeps AGPL theme source outside the MIT distribution while making content correctness testable.

## Release order

The public distribution is the source of truth. Changes are tested there, synchronized into the target Blog, and checked for byte-for-byte equality. The current article is then rendered again from one new package revision. Remote Git and WeChat operations remain behind the confirmation plan; when a provider cannot update a draft safely, the endpoint creates a replacement draft and retains both media IDs in the handoff.
