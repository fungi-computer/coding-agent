import { parse } from "yaml";

interface ParsedFrontmatter<T extends Record<string, unknown>> {
  body: string;
  frontmatter: T;
}

const normalizeNewlines = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const extractFrontmatter = (
  content: string,
): { body: string; yamlString: null | string } => {
  const normalized = normalizeNewlines(content);

  if (!normalized.startsWith("---")) {
    return { body: normalized, yamlString: null };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { body: normalized, yamlString: null };
  }

  return {
    body: normalized.slice(endIndex + 4).trim(),
    yamlString: normalized.slice(4, endIndex),
  };
};

export const parseFrontmatter = <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  content: string,
): ParsedFrontmatter<T> => {
  const { body, yamlString } = extractFrontmatter(content);
  if (!yamlString) {
    return { body, frontmatter: {} as T };
  }
  const parsed = parse(yamlString);
  return { body, frontmatter: (parsed ?? {}) as T };
};

export const stripFrontmatter = (content: string): string =>
  parseFrontmatter(content).body;
