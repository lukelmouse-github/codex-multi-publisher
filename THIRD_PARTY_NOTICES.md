# Third-party tools

Codex Multi Publisher is distributed under the MIT License. It interoperates with external projects that are not vendored into this repository and remain governed by their own licenses:

- [`JimLiu/baoyu-skills`](https://github.com/JimLiu/baoyu-skills), used for the WeChat draft API adapter. The expected version and participating file hashes are recorded in `.agents/skills/publish-article/toolchain.lock.json`.
- [`isjiamu/gzh-design-skill`](https://github.com/isjiamu/gzh-design-skill), used as an external HTML design and validation sidecar. The locked revision is licensed under AGPL-3.0-or-later, as recorded in `.agents/skills/publish-article/toolchain.lock.json`.
- Runtime and development packages listed in `.agents/skills/publish-article/scripts/package.json` and `.agents/skills/publish-article/scripts/bun.lock`, each governed by its own package license.

Install and use these dependencies according to their upstream license terms. This repository's MIT License does not replace or relicense third-party software.
