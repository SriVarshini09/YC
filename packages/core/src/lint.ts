import type { Advisory } from "./advisory";

/**
 * Deprecated-shape lint (execution plan S-06): names that verified advisories retire, found anywhere in the code, not
 * only in the call sites SHAPI resolves. A model id in a config constant, an old enum value in a comparison, an old field
 * name read from a response stored elsewhere: the matcher can miss these when the call itself isn't resolved.
 */
export type LintKind = "model" | "enum" | "field";

export interface LintRule {
  kind: LintKind;
  /** The retired name: a model id, an enum value, a field name. */
  name: string;
  /** What replaces it, when the advisory says. */
  replacement?: string;
  /** Enum rules: the field the value belongs to (`ui_mode`). */
  field?: string;
  advisoryId: string;
  provider: string;
}

export interface LintFinding extends LintRule {
  file: string;
  line: number;
  column: number;
}

/**
 * Field names this short or this plain are everywhere (`id`, `status`), so a field rule needs a distinctive name:
 * snake_case, camelCase, or at least 8 characters.
 */
const distinctive = (name: string) => /[_A-Z]/.test(name) || name.length >= 8;

/** One rule per retired name in the verified advisories: model ids they sunset, and the fields and enum values their fix renames. */
export function deprecatedShapeRules(advisories: Advisory[]): LintRule[] {
  const rules = new Map<string, LintRule>();
  const add = (r: LintRule) => rules.has(`${r.kind}:${r.name}`) || rules.set(`${r.kind}:${r.name}`, r);
  for (const a of advisories) {
    if (a.status !== "verified") continue;
    const base = { advisoryId: a.id, provider: a.provider };
    if (a.changeClass === "version-sunset") {
      for (const b of a.trigger.body ?? []) if (b.field === "model") for (const name of b.values ?? []) add({ kind: "model", name, ...base });
    }
    for (const f of a.fix?.fields ?? []) if (distinctive(f.from)) add({ kind: "field", name: f.from, replacement: f.to, ...base });
    for (const e of a.fix?.enums ?? []) for (const v of e.values) add({ kind: "enum", name: v.from, replacement: v.to, field: e.field, ...base });
  }
  return [...rules.values()].sort((x, y) => x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `ui_mode` and its camelCase form `uiMode`, as words. */
const fieldMention = (field: string) => {
  const camel = field.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  return new RegExp(`\\b(?:${escape(field)}${camel === field ? "" : `|${escape(camel)}`})\\b`);
};

/**
 * Where a rule's name appears in one file: as a whole string literal (model, enum), or read as a property (field).
 * Enum values are plain words ("hosted", "custom"), so an enum rule counts only in a file that also names its field.
 */
export function lintSource(file: string, text: string, rules: LintRule[]): LintFinding[] {
  const patterns = rules.filter((r) => r.kind !== "enum" || !r.field || fieldMention(r.field).test(text)).map((r) => ({
    rule: r,
    re:
      r.kind === "field"
        ? new RegExp(`(?:\\.|\\[\\s*["'\`])${escape(r.name)}\\b`, "g")
        : new RegExp(`(["'\`])${escape(r.name)}\\1`, "g"),
  }));
  const out: LintFinding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const { rule, re } of patterns) {
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) out.push({ ...rule, file, line: i + 1, column: m.index + 1 });
    }
  });
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** The source files the lint reads: what the extractor scans (TypeScript, JavaScript, Python). */
export const isLintable = (file: string) => /\.(?:[mc]?[jt]sx?|py)$/.test(file) && !/(?:^|\/)(?:node_modules|dist|build|\.git)\//.test(file);

/**
 * Lint a repository's files (S-06): every retired name, except on a line where an affected finding for the same
 * advisory is already reported, so a call site isn't flagged twice.
 */
export function lintFiles(files: { path: string; text: string }[], advisories: Advisory[], affected: { advisory: { id: string }; callSite: { file: string; line: number } }[] = []): LintFinding[] {
  const rules = deprecatedShapeRules(advisories);
  if (!rules.length) return [];
  const key = (advisory: string, file: string, line: number) => `${advisory}:${file}:${line}`;
  const covered = new Set(affected.map((f) => key(f.advisory.id, f.callSite.file, f.callSite.line)));
  return files
    .filter((f) => isLintable(f.path))
    .flatMap((f) => lintSource(f.path, f.text, rules))
    .filter((l) => !covered.has(key(l.advisoryId, l.file, l.line)))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}
