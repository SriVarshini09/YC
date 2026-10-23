import type { Fix } from "@shapi/core";
import { Node, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";
import type { Edit, Recipe, RecipeContext } from "../recipe";

/**
 * The change an advisory's `fix` describes, applied to one call site:
 * - `path`, `query`, `header`: rewrite what the call sends, in its URL argument, the same-file
 *   constants that URL is built from, an axios `baseURL`, and `params` / `headers` objects;
 * - `fields`: read the renamed response field, falling back to the old name (`(x.new ?? x.old)`);
 * - `enums`: comparisons with a renamed value also accept the new value.
 * Response reads are only changed inside the function that makes the call.
 */
export const applyFix: Recipe = {
  id: "apply-fix",
  changeClass: "version-sunset",
  description: "Apply the advisory's fix: the new path, query value or header, and the renamed fields and enum values",
  edits({ sourceFile, call, advisory }: RecipeContext): Edit[] {
    const fix = advisory.fix;
    if (!fix) return [];
    const where = (n: Node) => `${sourceFile.getFilePath().slice(1)}:${n.getStartLineNumber()}`;
    const edits: Edit[] = [...requestEdits(call, sourceFile, fix, where), ...headerEdits(call, fix, where)];
    const scope = enclosingFunction(call) ?? sourceFile;
    edits.push(...fieldEdits(scope, fix, where, edits), ...enumEdits(scope, fix, where));
    return edits;
  },
};

type Where = (n: Node) => string;
const TEXT_KINDS = [SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateHead, SyntaxKind.TemplateMiddle, SyntaxKind.TemplateTail];

/** Path and query rewrites, one edit per string or template part so the two never overlap. */
function requestEdits(call: CallExpression, sf: SourceFile, fix: Fix, where: Where): Edit[] {
  if (!fix.path && !fix.query) return [];
  const edits: Edit[] = [];
  for (const node of urlTextNodes(call, sf)) {
    const before = node.getText();
    let after = before;
    if (fix.path) {
      after = after.split(fix.path.from).join(fix.path.to);
      // A base URL constant often ends at the version: "https://graph.facebook.com/v21.0" or `${base}/v21.0${path}`.
      const from = fix.path.from.replace(/\/$/, "");
      const to = fix.path.to.replace(/\/$/, "");
      if (from !== fix.path.from) after = after.replace(new RegExp(`${escapeRe(from)}(?=["'\`]|\\$\\{)`, "g"), to);
    }
    if (fix.query) {
      const re = new RegExp(`([?&])${escapeRe(fix.query.name)}=([^&#\`'"$]+)`, "g");
      after = after.replace(re, (_m, sep: string) => `${sep}${fix.query!.name}=${fix.query!.value}`);
    }
    if (after !== before) edits.push({ start: node.getStart(), end: node.getEnd(), text: after, note: `${where(node)} \`${before}\` → \`${after}\`` });
  }
  if (fix.query) {
    for (const prop of objectProperties(call, "params")) {
      if (propName(prop) !== fix.query.name || !Node.isPropertyAssignment(prop)) continue;
      const init = prop.getInitializer();
      if (!init || !(Node.isNumericLiteral(init) || Node.isStringLiteral(init))) continue;
      const text = /^\d+(\.\d+)?$/.test(fix.query.value) && Node.isNumericLiteral(init) ? fix.query.value : JSON.stringify(fix.query.value);
      if (init.getText() !== text) edits.push({ start: init.getStart(), end: init.getEnd(), text, note: `${where(init)} ${fix.query.name}: \`${init.getText()}\` → \`${text}\`` });
    }
  }
  return edits;
}

function headerEdits(call: CallExpression, fix: Fix, where: Where): Edit[] {
  if (!fix.header) return [];
  const edits: Edit[] = [];
  const text = JSON.stringify(fix.header.value);
  for (const prop of objectProperties(call, "headers")) {
    if (propName(prop)?.toLowerCase() !== fix.header.name.toLowerCase() || !Node.isPropertyAssignment(prop)) continue;
    const init = prop.getInitializer();
    if (!init || !(Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) || init.getLiteralText() === fix.header.value) continue;
    edits.push({ start: init.getStart(), end: init.getEnd(), text, note: `${where(init)} ${fix.header.name}: \`${init.getText()}\` → \`${text}\`` });
  }
  return edits;
}

/** `x.old` → `(x.new ?? x.old)` for each renamed field's last segment, skipping writes and anything already edited. */
function fieldEdits(scope: Node, fix: Fix, where: Where, taken: Edit[]): Edit[] {
  const edits: Edit[] = [];
  for (const { from, to } of fix.fields ?? []) {
    const oldName = leaf(from);
    const newName = leaf(to);
    if (oldName === newName) continue;
    for (const access of scope.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (access.getName() !== oldName || isWrite(access) || overlaps(access, [...taken, ...edits])) continue;
      const target = access.getExpression().getText();
      const dot = access.hasQuestionDotToken() ? "?." : ".";
      const text = `(${target}${dot}${newName} ?? ${target}${dot}${oldName})`;
      edits.push({ start: access.getStart(), end: access.getEnd(), text, note: `${where(access)} \`${access.getText()}\` → \`${text}\`` });
    }
  }
  return edits;
}

/** Comparisons with an old enum value also accept the new one: `===`, `switch` cases and `[…].includes(x)`. */
function enumEdits(scope: Node, fix: Fix, where: Where): Edit[] {
  const edits: Edit[] = [];
  for (const { field, values } of fix.enums ?? []) {
    const name = leaf(field);
    const renamed = new Map(values.map((v) => [v.from, v.to]));
    const isField = (n: Node) => (Node.isPropertyAccessExpression(n) && n.getName() === name) || (Node.isIdentifier(n) && n.getText() === name);

    for (const bin of scope.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      const op = bin.getOperatorToken().getKind();
      const negated = op === SyntaxKind.ExclamationEqualsEqualsToken || op === SyntaxKind.ExclamationEqualsToken;
      if (!negated && op !== SyntaxKind.EqualsEqualsEqualsToken && op !== SyntaxKind.EqualsEqualsToken) continue;
      const [lit, other] = Node.isStringLiteral(bin.getRight()) ? [bin.getRight(), bin.getLeft()] : [bin.getLeft(), bin.getRight()];
      if (!Node.isStringLiteral(lit) || !isField(other)) continue;
      const to = renamed.get(lit.getLiteralText());
      if (to === undefined) continue;
      const text = `${negated ? "!" : ""}${JSON.stringify([lit.getLiteralText(), to])}.includes(${other.getText()})`;
      edits.push({ start: bin.getStart(), end: bin.getEnd(), text, note: `${where(bin)} \`${bin.getText()}\` → \`${text}\`` });
    }

    for (const sw of scope.getDescendantsOfKind(SyntaxKind.SwitchStatement)) {
      if (!isField(sw.getExpression())) continue;
      const cases = sw.getClauses().filter(Node.isCaseClause);
      const present = new Set(cases.map((c) => c.getExpression()).filter(Node.isStringLiteral).map((l) => l.getLiteralText()));
      for (const c of cases) {
        const e = c.getExpression();
        const to = Node.isStringLiteral(e) ? renamed.get(e.getLiteralText()) : undefined;
        if (to === undefined || present.has(to)) continue;
        present.add(to);
        const indent = " ".repeat(c.getSourceFile().getLineAndColumnAtPos(c.getStart()).column - 1);
        edits.push({ start: c.getStart(), end: c.getStart(), text: `case ${JSON.stringify(to)}:\n${indent}`, note: `${where(c)} add case ${JSON.stringify(to)}` });
      }
    }

    for (const inc of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = inc.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "includes" || !isField(inc.getArguments()[0] ?? inc)) continue;
      const arr = callee.getExpression();
      if (!Node.isArrayLiteralExpression(arr)) continue;
      const items = arr.getElements().filter(Node.isStringLiteral).map((l) => l.getLiteralText());
      const add = items.map((v) => renamed.get(v)).filter((v): v is string => v !== undefined && !items.includes(v));
      if (!add.length) continue;
      const text = JSON.stringify([...items, ...new Set(add)]);
      edits.push({ start: arr.getStart(), end: arr.getEnd(), text, note: `${where(arr)} \`${arr.getText()}\` → \`${text}\`` });
    }
  }
  return edits;
}

/**
 * The string and template parts the call's URL is made of: its URL argument (or `url` property),
 * same-file constants that URL refers to, and `baseURL` values in the file (axios instances).
 */
function urlTextNodes(call: CallExpression, sf: SourceFile): Node[] {
  const out = new Set<Node>();
  const seen = new Set<Node>();
  const visit = (n: Node | undefined, depth: number) => {
    if (!n || depth > 4 || seen.has(n)) return;
    seen.add(n);
    if (TEXT_KINDS.includes(n.getKind())) out.add(n);
    if (Node.isIdentifier(n)) {
      const decl = sf.getVariableDeclaration(n.getText());
      if (decl?.getVariableStatement()?.getDeclarationKind() === "const") visit(decl.getInitializer(), depth + 1);
      return;
    }
    n.forEachChild((c) => visit(c, depth));
  };
  const [first] = call.getArguments();
  if (first && Node.isObjectLiteralExpression(first)) {
    const url = first.getProperty("url");
    if (url && Node.isPropertyAssignment(url)) visit(url.getInitializer(), 0);
  } else visit(first, 0);
  for (const prop of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) if (propName(prop) === "baseURL") visit(prop.getInitializer(), 0);
  return [...out];
}

/** Properties of `name: { … }` objects among the call's object-literal arguments (one level deep). */
function objectProperties(call: CallExpression, name: string): Node[] {
  const out: Node[] = [];
  for (const arg of call.getArguments()) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    const prop = arg.getProperties().find((p) => propName(p) === name);
    const value = prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
    if (value && Node.isObjectLiteralExpression(value)) out.push(...value.getProperties());
  }
  return out;
}

function propName(p: Node): string | undefined {
  if (!(Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p))) return undefined;
  const n = p.getNameNode();
  return Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n) ? n.getLiteralText() : n.getText();
}

function enclosingFunction(call: Node): Node | undefined {
  return call.getFirstAncestor((n) => Node.isFunctionDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isMethodDeclaration(n));
}

function isWrite(access: Node): boolean {
  const p = access.getParent();
  return Node.isBinaryExpression(p) && p.getLeft() === access && p.getOperatorToken().getKind() === SyntaxKind.EqualsToken;
}

function overlaps(n: Node, edits: Edit[]): boolean {
  return edits.some((e) => n.getStart() < e.end && e.start < n.getEnd());
}

/** "results[].stages[].stageId" → "stageId". */
function leaf(path: string): string {
  return path.split(".").pop()!.replace(/\[\]/g, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
