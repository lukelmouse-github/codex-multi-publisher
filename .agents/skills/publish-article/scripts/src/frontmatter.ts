import { parse as parseToml } from "@iarna/toml";
import { parse as parseYaml } from "yaml";
import { PublishError } from "./errors";

export type FrontmatterFormat = "yaml" | "toml" | "none";

export interface ParsedFrontmatter {
  format: FrontmatterFormat;
  data: Record<string, unknown>;
  body: string;
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, jsonSafe(child)]),
    );
  }
  return value;
}

function asRecord(value: unknown, format: Exclude<FrontmatterFormat, "none">): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PublishError("E_FRONTMATTER", `${format.toUpperCase()} frontmatter must be an object`);
  }
  return jsonSafe(value) as Record<string, unknown>;
}

function frontmatterMatch(source: string, delimiter: "---" | "+++"): RegExpMatchArray | null {
  const escaped = delimiter === "---" ? "---" : "\\+\\+\\+";
  return source.match(new RegExp(`^${escaped}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n${escaped}[ \\t]*(?:\\r?\\n|$)`));
}

export function parseFrontmatter(source: string): ParsedFrontmatter {
  const delimiter = source.startsWith("---") ? "---" : source.startsWith("+++") ? "+++" : undefined;
  if (!delimiter) return { format: "none", data: {}, body: source };

  const match = frontmatterMatch(source, delimiter);
  if (!match) {
    throw new PublishError("E_FRONTMATTER", `Unclosed ${delimiter === "---" ? "YAML" : "TOML"} frontmatter`);
  }

  const raw = match[1] ?? "";
  const format = delimiter === "---" ? "yaml" : "toml";
  try {
    const parsed = format === "yaml" ? parseYaml(raw) : parseToml(raw);
    return {
      format,
      data: asRecord(parsed, format),
      body: source.slice(match[0].length),
    };
  } catch (error) {
    if (error instanceof PublishError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new PublishError("E_FRONTMATTER", `Invalid ${format.toUpperCase()} frontmatter: ${reason}`, {
      details: { format },
    });
  }
}
