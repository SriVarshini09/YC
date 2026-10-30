import type { Fix } from "@shapi/core";
import { Node, SyntaxKind, type CallExpression, type ObjectLiteralExpression, type SourceFile, type Type } from "ts-morph";
import { codeSpan, swap, type Edit, type Recipe, type RecipeContext } from "../recipe";

/**
 * The change an advisory's `fix` describes, applied to one call site:
 * - `path`, `query`, `header`: rewrite what the call sends, in its URL argument, the same-file
 *   constants that URL is built from, an axios `baseURL`, and `params` (axios), `searchParams` (got)
 *   and `headers` objects;
 * - `fields`: read the renamed response field, falling back to the old name (`(x.new ?? x.old)`);
 * - `enums`: comparisons with a renamed value also accept the new value.
 * Response reads are only changed inside the function that makes the call. In TypeScript the output
 * must still type-check where the code's own types do not know the new name or value yet, so reads
 * and comparisons on such types get a cast (`(x as any).new`, `as unknown[]`, `case "new" as string`).
 */
export const applyFix: Recipe = {
  id: "apply-fix",
  changeClass: "version-sunset",
  description: "Apply the advisory's fix: the new path, query value, header or body field, and the renamed fields and enum values",
  edits({ sourceFile, call, callSite, advisory }: RecipeContext): Edit[] {
    const fix = advisory.fix;
    if (!fix) return [];
    // Notes are Markdown for the PR body: the repository's paths and code go in code spans (see Edit.note).
    const where = (n: Node) => codeSpan(`${sourceFile.getFilePath().slice(1)}:${n.getStartLineNumber()}`);
    const below = fix.query ? advisory.trigger.query?.find((q) => q.name === fix.query!.name)?.below : undefined;
    const edits: Edit[] = [...requestEdits(call, sourceFile, fix, where, below), ...headerEdits(call, fix, where), ...bodyEdits(call, sourceFile, fix, where, callSite.kind === "sdk")];
    const scope = enclosingFunction(call) ?? sourceFile;
    const ts = /\.(c|m)?tsx?$/.test(sourceFile.getFilePath());
    edits.push(...fieldEdits(scope, fix, where, edits, ts));
    return enumEdits(scope, fix, where, edits, ts);
  },
};

type Where = (n: Node) => string;
const TEXT_KINDS = [SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateHead, SyntaxKind.TemplateMiddle, SyntaxKind.TemplateTail];

/** Path and query rewrites, one edit per string or template part so the two never overlap. */
function requestEdits(call: CallExpression, sf: SourceFile, fix: Fix, where: Where, below?: number): Edit[] {
  if (!fix.path && !fix.query) return [];
  // With a threshold ("minorversion below 75") only values under it are retired: a higher one stays.
  const retired = (value: string) => below === undefined || !/^\d+(\.\d+)?$/.test(value) || Number(value) < below;
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
      after = after.replace(re, (m, sep: string, value: string) => (retired(value) ? `${sep}${fix.query!.name}=${fix.query!.value}` : m));
    }
    if (after !== before) edits.push({ start: node.getStart(), end: node.getEnd(), text: after, note: `${where(node)} ${swap(before, after)}` });
  }
  if (fix.query) {
    for (const prop of [...objectProperties(call, "params"), ...objectProperties(call, "searchParams")]) {
      if (propName(prop) !== fix.query.name || !Node.isPropertyAssignment(prop)) continue;
      const init = prop.getInitializer();
      if (!init || !(Node.isNumericLiteral(init) || Node.isStringLiteral(init)) || !retired(init.getLiteralText())) continue;
      const text = /^\d+(\.\d+)?$/.test(fix.query.value) && Node.isNumericLiteral(init) ? fix.query.value : JSON.stringify(fix.query.value);
      if (init.getText() !== text) edits.push({ start: init.getStart(), end: init.getEnd(), text, note: `${where(init)} ${fix.query.name}: ${swap(init.getText(), text)}` });
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
    edits.push({ start: init.getStart(), end: init.getEnd(), text, note: `${where(init)} ${fix.header.name}: ${swap(init.getText(), text)}` });
  }
  return edits;
}

/**
 * `x.old` → `(x.new ?? x.old)` for each renamed field's last segment, skipping writes and anything
 * already edited. Only receivers that are safe to evaluate twice are rewritten: `(await get()).data.old`
 * would send the request again whenever the new field is missing.
 */
function fieldEdits(scope: Node, fix: Fix, where: Where, taken: Edit[], ts: boolean): Edit[] {
  const edits: Edit[] = [];
  for (const { from, to } of fix.fields ?? []) {
    const oldName = leaf(from);
    const newName = leaf(to);
    if (oldName === newName) continue;
    for (const access of scope.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (access.getName() !== oldName || isWrite(access) || !repeatable(access.getExpression()) || overlaps(access, [...taken, ...edits])) continue;
      const receiver = access.getExpression();
      const target = receiver.getText();
      const dot = access.hasQuestionDotToken() ? "?." : ".";
      const typed = ts && !knowsProperty(receiver, newName) ? `(${target} as any)` : target;
      const text = `(${typed}${dot}${newName} ?? ${target}${dot}${oldName})`;
      edits.push({ start: access.getStart(), end: access.getEnd(), text, note: `${where(access)} ${swap(access.getText(), text)}` });
    }
  }
  return edits;
}

/**
 * Comparisons with an old enum value also accept the new one: `===`, `switch` cases and `[…].includes(x)`.
 * Returns `taken` plus these edits; a comparison that holds a field edit is rewritten with that edit inside it.
 */
function enumEdits(scope: Node, fix: Fix, where: Where, taken: Edit[], ts: boolean): Edit[] {
  let kept = [...taken];
  const edits: Edit[] = [];
  /** The node's text with the edits inside it applied; undefined when an edit only partly overlaps it. */
  const textOf = (n: Node): string | undefined => {
    const inner = kept.filter((e) => e.start >= n.getStart() && e.end <= n.getEnd());
    if (kept.some((e) => !inner.includes(e) && e.start < n.getEnd() && n.getStart() < e.end)) return undefined;
    let out = n.getText();
    for (const e of [...inner].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start - n.getStart()) + e.text + out.slice(e.end - n.getStart());
    return out;
  };
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
      const value = textOf(other);
      if (to === undefined || value === undefined || overlaps(bin, edits)) continue;
      // `["a","b"].includes(x)` is string[].includes, which tsc rejects for a typed (or nullable) x.
      const values = JSON.stringify([lit.getLiteralText(), to]);
      const list = ts && !acceptsAnyString(other) ? `(${values} as unknown[])` : values;
      const text = `${negated ? "!" : ""}${list}.includes(${value})`;
      kept = kept.filter((e) => !(e.start >= bin.getStart() && e.end <= bin.getEnd()));
      edits.push({ start: bin.getStart(), end: bin.getEnd(), text, note: `${where(bin)} ${swap(bin.getText(), text)}` });
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
        // A value the switch's union type does not have yet is "not comparable" to tsc unless widened.
        const label = ts && !acceptsAnyString(sw.getExpression()) ? `${JSON.stringify(to)} as string` : JSON.stringify(to);
        edits.push({ start: c.getStart(), end: c.getStart(), text: `case ${label}:\n${indent}`, note: `${where(c)} add case ${label}` });
      }
    }

    for (const inc of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = inc.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "includes" || !isField(inc.getArguments()[0] ?? inc)) continue;
      const arr = callee.getExpression();
      if (!Node.isArrayLiteralExpression(arr)) continue;
      const items = arr.getElements().filter(Node.isStringLiteral).map((l) => l.getLiteralText());
      const add = items.map((v) => renamed.get(v)).filter((v): v is string => v !== undefined && !items.includes(v));
      if (!add.length || overlaps(arr, [...kept, ...edits])) continue;
      const text = JSON.stringify([...items, ...new Set(add)]);
      edits.push({ start: arr.getStart(), end: arr.getEnd(), text, note: `${where(arr)} ${swap(arr.getText(), text)}` });
    }
  }
  return [...kept, ...edits];
}

/** The receiver's type is `any` or already declares `name`, so reading `name` type-checks without a cast. */
function knowsProperty(receiver: Node, name: string): boolean {
  const type = receiver.getType();
  return isPlainAny(type) || type.getNonNullableType().getProperty(name) !== undefined;
}

/** Comparing the expression with any string type-checks: its type is `any` or `string`. */
function acceptsAnyString(expr: Node): boolean {
  const type = expr.getType();
  return isPlainAny(type) || type.isString();
}

/** `any`, but not the checker's stand-in for a type it could not resolve (an import from another file or package). */
function isPlainAny(type: Type): boolean {
  return type.isAny() && (type.compilerType as { intrinsicName?: string }).intrinsicName !== "error";
}

/** Evaluating the expression twice is harmless: names, `this`, property and element access with no calls, awaits or assignments. */
function repeatable(n: Node): boolean {
  if (Node.isIdentifier(n) || n.getKind() === SyntaxKind.ThisKeyword) return true;
  if (Node.isPropertyAccessExpression(n) || Node.isNonNullExpression(n) || Node.isParenthesizedExpression(n)) return repeatable(n.getExpression());
  if (Node.isElementAccessExpression(n)) {
    const arg = n.getArgumentExpression();
    return repeatable(n.getExpression()) && arg !== undefined && (Node.isStringLiteral(arg) || Node.isNumericLiteral(arg) || Node.isIdentifier(arg));
  }
  return false;
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

/** The access is assigned, updated or deleted (`=`, `+=`, `++`, `delete`, a destructuring target or a for-in/of head): `(a ?? b) = v` is not code. */
function isWrite(access: Node): boolean {
  let cur: Node = access;
  for (;;) {
    const p = cur.getParent();
    if (!p) return false;
    if (Node.isParenthesizedExpression(p) || Node.isNonNullExpression(p)) cur = p;
    else if (Node.isDeleteExpression(p) || Node.isPostfixUnaryExpression(p)) return true;
    else if (Node.isPrefixUnaryExpression(p)) return p.getOperatorToken() === SyntaxKind.PlusPlusToken || p.getOperatorToken() === SyntaxKind.MinusMinusToken;
    else if (Node.isBinaryExpression(p)) {
      const op = p.getOperatorToken().getKind();
      return p.getLeft() === cur && op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment;
    } else if (Node.isForInStatement(p) || Node.isForOfStatement(p)) return p.getInitializer() === cur;
    // Inside an array or object literal it is a write only if that literal is a destructuring target.
    else if (
      Node.isArrayLiteralExpression(p) || Node.isObjectLiteralExpression(p) || Node.isSpreadElement(p) || Node.isSpreadAssignment(p) ||
      (Node.isPropertyAssignment(p) && p.getInitializer() === cur) || Node.isShorthandPropertyAssignment(p)
    ) cur = p;
    else return false;
  }
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

/**
 * The objects a call sends as its body: an SDK method's object argument, a `body: JSON.stringify({...})` (fetch),
 * `data` (axios) or `json` (got), each also through a `const` the function or file defines.
 */
function bodyObjects(call: CallExpression, sf: SourceFile, sdk: boolean): ObjectLiteralExpression[] {
  const out: ObjectLiteralExpression[] = [];
  const objectOf = (n: Node | undefined, depth = 0): ObjectLiteralExpression | undefined => {
    if (!n || depth > 3) return undefined;
    if (Node.isObjectLiteralExpression(n)) return n;
    if (Node.isParenthesizedExpression(n) || Node.isAsExpression(n) || Node.isSatisfiesExpression(n)) return objectOf(n.getExpression(), depth + 1);
    if (Node.isCallExpression(n) && n.getExpression().getText() === "JSON.stringify") return objectOf(n.getArguments()[0], depth + 1);
    if (Node.isIdentifier(n)) {
      const scope = enclosingFunction(call) ?? sf;
      const decl = scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find((d) => d.getName() === n.getText() && d.getStart() < call.getStart()) ?? sf.getVariableDeclaration(n.getText());
      return objectOf(decl?.getInitializer(), depth + 1);
    }
    return undefined;
  };
  const args = call.getArguments();
  for (const arg of args) {
    const obj = objectOf(arg);
    if (!obj) continue;
    if (sdk) out.push(obj);
    for (const name of ["body", "data", "json"]) {
      const prop = obj.getProperty(name);
      const inner = prop && Node.isPropertyAssignment(prop) ? objectOf(prop.getInitializer()) : undefined;
      if (inner) out.push(inner);
    }
  }
  // axios.post(url, data) and got.post(url, { json }) put the body second.
  const second = objectOf(args[1]);
  if (!sdk && second && !out.includes(second) && !["method", "headers", "body", "json"].some((k) => second.getProperty(k))) out.push(second);
  return [...new Set(out)];
}

/** C-07: the body fields a fix changes: a value (`model`), a name (`max_tokens` → `max_completion_tokens`), or the field itself. */
function bodyEdits(call: CallExpression, sf: SourceFile, fix: Fix, where: Where, sdk: boolean): Edit[] {
  if (!fix.body) return [];
  const edits: Edit[] = [];
  for (const obj of bodyObjects(call, sf, sdk)) {
    const props = obj.getProperties();
    for (const change of fix.body) {
      const prop = props.find((p) => propName(p) === change.field);
      if (!prop || !Node.isPropertyAssignment(prop)) continue;
      if (change.remove) {
        // The property and the comma after it (or before it, for the last one).
        const i = props.indexOf(prop);
        const next = props[i + 1];
        const start = next ? prop.getStart() : (props[i - 1]?.getEnd() ?? prop.getStart());
        const end = next ? next.getStart() : prop.getEnd();
        edits.push({ start, end, text: "", note: `${where(prop)} stop sending ${codeSpan(prop.getText())}` });
        continue;
      }
      const init = prop.getInitializer();
      const value = init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) ? init.getLiteralText() : undefined;
      const to = change.values?.find((v) => v.from === value)?.to;
      const nameNode = prop.getNameNode();
      if (change.rename) {
        const name = /^[A-Za-z_$][\w$]*$/.test(change.rename) ? change.rename : JSON.stringify(change.rename);
        const text = to !== undefined && init ? `${name}: ${quoteLike(init.getText(), to)}` : `${name}: ${init?.getText() ?? ""}`;
        edits.push({ start: nameNode.getStart(), end: prop.getEnd(), text, note: `${where(prop)} ${swap(prop.getText(), text)}` });
      } else if (to !== undefined && init) {
        const text = quoteLike(init.getText(), to);
        edits.push({ start: init.getStart(), end: init.getEnd(), text, note: `${where(init)} ${change.field}: ${swap(init.getText(), text)}` });
      }
    }
  }
  return edits;
}

/** `to` as a string literal in the quote style of `literal`. */
function quoteLike(literal: string, to: string): string {
  const q = literal[0] === "'" || literal[0] === "`" ? literal[0] : '"';
  return q === '"' ? JSON.stringify(to) : `${q}${to.replace(/\\/g, "\\\\").replaceAll(q, `\\${q}`)}${q}`;
}
