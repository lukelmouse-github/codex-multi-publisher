import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_GZH_THEME_ID,
  GZH_DESIGN_REPOSITORY,
  GZH_DESIGN_REVISION,
  GZH_REQUIRED_FILES,
  gzhSkillCandidates,
  normalizeGithubRepository,
  resolveGzhToolchain,
  type GzhDesignToolchainLock,
  type GzhGitRunner,
} from "../src/gzh-toolchain";
import { sha256File } from "../src/toolchain";
import type { GzhDesignProvenanceInput } from "../src/wechat-freeze";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

interface FakeCheckout {
  skillDir: string;
  lock: GzhDesignToolchainLock;
}

async function fakeCheckout(root: string, themes: string[] = [DEFAULT_GZH_THEME_ID]): Promise<FakeCheckout> {
  const skillDir = path.join(root, "gzh-design-skill");
  await mkdir(path.join(skillDir, ".git"), { recursive: true });
  const contents: Record<string, string> = {
    LICENSE: "fixture AGPL license\n",
    "SKILL.md": "fixture layout instructions\n",
    "references/common-components.md": "fixture common components\n",
    "references/theme-index.md": "fixture theme index\n",
    "scripts/validate_gzh_html.py": "# fixture validator\n",
  };
  for (const theme of themes) contents[`references/theme-${theme}.md`] = `fixture theme ${theme}\n`;
  for (const [relative, content] of Object.entries(contents)) {
    const target = path.join(skillDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const files: Record<string, string> = {};
  for (const relative of GZH_REQUIRED_FILES) files[relative] = await sha256File(path.join(skillDir, relative));
  const lockedThemes: Record<string, { path: string; sha256: string }> = {};
  for (const theme of themes) {
    const relative = `references/theme-${theme}.md`;
    lockedThemes[theme] = { path: relative, sha256: await sha256File(path.join(skillDir, relative)) };
  }
  return {
    skillDir,
    lock: {
      schemaVersion: 1,
      gzhDesignSkill: {
        repository: GZH_DESIGN_REPOSITORY,
        revision: GZH_DESIGN_REVISION,
        license: "AGPL-3.0-or-later",
        runnerContract: "gzh-design-sidecar/v1",
        files,
        themes: lockedThemes,
      },
    },
  };
}

function gitRunner(options: { origin?: string; revision?: string } = {}): GzhGitRunner {
  return async ({ args }) => {
    if (args[0] === "remote") {
      return { exitCode: 0, stdout: `${options.origin ?? `${GZH_DESIGN_REPOSITORY}.git`}\n`, stderr: "" };
    }
    if (args[0] === "rev-parse") {
      return { exitCode: 0, stdout: `${options.revision ?? GZH_DESIGN_REVISION}\n`, stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected command" };
  };
}

describe("gzh-design toolchain discovery", () => {
  test("uses explicit, env, project, user-agent, and Codex candidates in that order", async () => {
    const root = await tempRoot("gzh-candidates-");
    const options = {
      repoRoot: path.join(root, "repo"),
      explicitDir: path.join(root, "explicit"),
      env: { GZH_DESIGN_SKILL_DIR: path.join(root, "env"), CODEX_HOME: path.join(root, "codex-home") },
      homeDir: path.join(root, "home"),
    };
    expect(gzhSkillCandidates(options)).toEqual([
      path.join(root, "explicit"),
      path.join(root, "env"),
      path.join(root, "repo", ".publish", "toolchains", "gzh-design-skill"),
      path.join(root, "home", ".agents", "skills", "gzh-design-skill"),
      path.join(root, "codex-home", "skills", "gzh-design-skill"),
    ]);
  });

  test("does not install or access the network when no checkout exists", async () => {
    const root = await tempRoot("gzh-not-found-");
    let gitCalled = false;
    await expect(resolveGzhToolchain({
      repoRoot: root,
      homeDir: path.join(root, "home"),
      codexHome: path.join(root, "codex"),
      env: { PATH: process.env.PATH },
      lock: (await fakeCheckout(path.join(root, "lock-fixture"))).lock,
      gitRunner: async () => {
        gitCalled = true;
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    })).rejects.toMatchObject({ data: { code: "E_GZH_NOT_FOUND", details: { installAttempted: false } } });
    expect(gitCalled).toBe(false);
  });
});

describe("gzh-design Git and hash verification", () => {
  test("returns provenance directly accepted by freezeWechatCandidate", async () => {
    const root = await tempRoot("gzh-resolve-");
    const checkout = await fakeCheckout(root);
    const resolved = await resolveGzhToolchain({
      repoRoot: root,
      explicitDir: checkout.skillDir,
      lock: checkout.lock,
      gitRunner: gitRunner(),
    });

    const acceptsFreezeProvenance = (value: GzhDesignProvenanceInput): GzhDesignProvenanceInput => value;
    expect(acceptsFreezeProvenance(resolved.provenance)).toEqual(resolved.provenance);
    expect(resolved).toMatchObject({
      skillDir: checkout.skillDir,
      repository: GZH_DESIGN_REPOSITORY,
      revision: GZH_DESIGN_REVISION,
      themeId: DEFAULT_GZH_THEME_ID,
    });
    expect(resolved.provenance).toMatchObject({
      repository: GZH_DESIGN_REPOSITORY,
      revision: GZH_DESIGN_REVISION,
      license: "AGPL-3.0-or-later",
      themeId: "moyu-green",
      runnerContract: "gzh-design-sidecar/v1",
    });
    expect(resolved.provenance.toolchainLockDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(resolved.provenance.files.map((file) => file.path)).toEqual([
      "references/common-components.md",
      "references/theme-index.md",
      "references/theme-moyu-green.md",
      "scripts/validate_gzh_html.py",
      "SKILL.md",
    ].sort((left, right) => left.localeCompare(right)));
    expect(JSON.stringify(resolved.provenance)).not.toContain(checkout.skillDir);
  });

  test("supports a dynamic theme only when that theme is locked", async () => {
    const root = await tempRoot("gzh-theme-");
    const checkout = await fakeCheckout(root, ["moyu-green", "custom-blue"]);
    const custom = await resolveGzhToolchain({
      repoRoot: root,
      explicitDir: checkout.skillDir,
      themeId: "custom-blue",
      lock: checkout.lock,
      gitRunner: gitRunner(),
    });
    expect(custom.themeId).toBe("custom-blue");
    expect(custom.provenance.files.some((file) => file.path === "references/theme-custom-blue.md")).toBe(true);
    expect(custom.provenance.files.some((file) => file.path === "references/theme-moyu-green.md")).toBe(false);

    await expect(resolveGzhToolchain({
      repoRoot: root,
      explicitDir: checkout.skillDir,
      themeId: "not-locked",
      lock: checkout.lock,
      gitRunner: gitRunner(),
    })).rejects.toMatchObject({ data: { code: "E_GZH_THEME_NOT_LOCKED" } });
  });

  test("accepts canonical HTTPS, SSH, and SCP GitHub origins", () => {
    expect(normalizeGithubRepository(`${GZH_DESIGN_REPOSITORY}.git`)).toBe(GZH_DESIGN_REPOSITORY);
    expect(normalizeGithubRepository("git@github.com:isjiamu/gzh-design-skill.git")).toBe(GZH_DESIGN_REPOSITORY);
    expect(normalizeGithubRepository("ssh://git@github.com/isjiamu/gzh-design-skill.git")).toBe(GZH_DESIGN_REPOSITORY);
  });

  test("blocks a different origin and a non-full or different HEAD", async () => {
    const root = await tempRoot("gzh-git-mismatch-");
    const checkout = await fakeCheckout(root);
    await expect(resolveGzhToolchain({
      repoRoot: root,
      explicitDir: checkout.skillDir,
      lock: checkout.lock,
      gitRunner: gitRunner({ origin: "https://github.com/attacker/gzh-design-skill.git" }),
    })).rejects.toMatchObject({ data: { code: "E_GZH_ORIGIN_MISMATCH" } });
    await expect(resolveGzhToolchain({
      repoRoot: root,
      explicitDir: checkout.skillDir,
      lock: checkout.lock,
      gitRunner: gitRunner({ revision: GZH_DESIGN_REVISION.slice(0, 7) }),
    })).rejects.toMatchObject({ data: { code: "E_GZH_REVISION_MISMATCH" } });
    await expect(resolveGzhToolchain({
      repoRoot: root,
      explicitDir: checkout.skillDir,
      lock: checkout.lock,
      gitRunner: gitRunner({ revision: "0".repeat(40) }),
    })).rejects.toMatchObject({ data: { code: "E_GZH_REVISION_MISMATCH" } });
  });

  test("blocks changes to LICENSE, instructions, common components, validator, index, or theme", async () => {
    for (const relative of [...GZH_REQUIRED_FILES, "references/theme-moyu-green.md"]) {
      const root = await tempRoot("gzh-file-mismatch-");
      const checkout = await fakeCheckout(root);
      await writeFile(path.join(checkout.skillDir, relative), "changed\n");
      await expect(resolveGzhToolchain({
        repoRoot: root,
        explicitDir: checkout.skillDir,
        lock: checkout.lock,
        gitRunner: gitRunner(),
      })).rejects.toMatchObject({ data: { code: "E_GZH_FILE_MISMATCH" } });
    }
  });

  test("the tracked lock pins the selected upstream commit and real participating files", async () => {
    const lockPath = path.resolve(import.meta.dir, "../../toolchain.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as GzhDesignToolchainLock;
    expect(lock.gzhDesignSkill).toMatchObject({
      repository: GZH_DESIGN_REPOSITORY,
      revision: GZH_DESIGN_REVISION,
      license: "AGPL-3.0-or-later",
      runnerContract: "gzh-design-sidecar/v1",
    });
    expect(Object.keys(lock.gzhDesignSkill.files).sort()).toEqual([...GZH_REQUIRED_FILES].sort());
    expect(lock.gzhDesignSkill.themes["moyu-green"]?.path).toBe("references/theme-moyu-green.md");
  });
});
