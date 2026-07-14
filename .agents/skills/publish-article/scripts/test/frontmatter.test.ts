import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../src/frontmatter";

describe("parseFrontmatter", () => {
  test("parses YAML without changing the Markdown body", () => {
    const result = parseFrontmatter("---\ntitle: Example\ntags: [one, two]\n---\n# Body\n");

    expect(result.format).toBe("yaml");
    expect(result.data).toEqual({ title: "Example", tags: ["one", "two"] });
    expect(result.body).toBe("# Body\n");
  });

  test("parses TOML and normalizes dates to JSON-safe strings", () => {
    const result = parseFrontmatter("+++\ntitle = \"Example\"\npublishedAt = 2026-07-14T08:00:00Z\n+++\nBody\n");

    expect(result.format).toBe("toml");
    expect(result.data.title).toBe("Example");
    expect(result.data.publishedAt).toBe("2026-07-14T08:00:00.000Z");
    expect(result.body).toBe("Body\n");
  });

  test("returns an untouched document when frontmatter is absent", () => {
    const source = "# No frontmatter\n\nText\n";
    expect(parseFrontmatter(source)).toEqual({ format: "none", data: {}, body: source });
  });

  test("reports malformed frontmatter as a structured publish error", () => {
    expect(() => parseFrontmatter("---\ntitle: [broken\n---\nBody\n")).toThrow("frontmatter");
  });
});
