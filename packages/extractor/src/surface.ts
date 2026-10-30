import { Node, SyntaxKind, type CallExpression } from "ts-morph";
import type { Surface } from "@shapi/core";
import type { FoundCall } from "./callsites";
import { descendantsOfKind } from "./walk";

/**
 * How a client wraps the response: where the status code lives and how the
 * body is reached. SDKs other than Octokit return the parsed body directly.
 */
type Envelope = "fetch" | "axios" | "got" | "undici" | "body";

interface Location {
  space: "response" | "body";
  path: string[];
}

/** Property names that are JS methods or built-ins, not API fields; a field path stops before them. */
const NOT_FIELDS = new Set([
  "length", "map", "filter", "forEach", "find", "findIndex", "some", "every", "includes", "indexOf", "reduce",
  "slice", "join", "concat", "flatMap", "sort", "keys", "values", "entries", "at", "push",
  "toString", "toLowerCase", "toUpperCase", "trim", "split", "startsWith", "endsWith", "replace", "match",
  "then", "catch", "finally", "valueOf", "toJSON",
]);

/** Array methods whose callback receives the array's items, and which parameter is the item. */
const ITEM_CALLBACKS: Record<string, number> = { map: 0, flatMap: 0, filter: 0, forEach: 0, find: 0, findIndex: 0, some: 0, every: 0, reduce: 1 };

const MAX_DEPTH = 4;

class Collector {
  fields = new Set<string>();
  statusCodes = new Set<number>();
  checksOk = false;
  enums = new Map<string, Set<string>>();
  responseHeaders = new Set<string>();

  addEnum(field: string, value: string) {
    const set = this.enums.get(field) ?? new Set<string>();
    set.add(value);
    this.enums.set(field, set);
  }
}

/**
 * Fill in the response side of a call site's surface by following the awaited
 * result through the same file: fields read, status codes and `ok` checked,
 * literal comparisons on fields, response headers read.
 */
export function addResponseSurface(found: FoundCall): void {
  const c = new Collector();
  bindFrom(found.call, { space: "response", path: [] }, envelopeOf(found), c, 0);

  const surface: Surface = found.site.surface;
  surface.fields = [...c.fields].sort();
  surface.statusCodes = [...c.statusCodes].sort((a, b) => a - b);
  surface.checksOk = c.checksOk;
  surface.enums = [...c.enums]
    .map(([field, values]) => ({ field, values: [...values].sort() }))
    .sort((a, b) => a.field.localeCompare(b.field));
  surface.responseHeaders = [...c.responseHeaders].sort();
}

function envelopeOf({ site, call }: FoundCall): Envelope {
  if (site.kind === "sdk") return site.provider === "github" ? "axios" : "body";
  switch (site.client) {
    case "axios":
      return "axios";
    case "got":
      return "got";
    case "undici":
      return /request$/.test(call.getExpression().getText()) ? "undici" : "fetch";
    default:
      return "fetch";
  }
}

/** Follow an expression that evaluates to `loc` to wherever its value is bound or used. */
function bindFrom(expr: Node, loc: Location, env: Envelope, c: Collector, depth: number): void {
  if (depth > MAX_DEPTH) return;
  let cur = expr;
  for (;;) {
    const p = cur.getParent();
    if (
      p &&
      (Node.isAwaitExpression(p) || Node.isParenthesizedExpression(p) || Node.isAsExpression(p) ||
        Node.isNonNullExpression(p) || Node.isSatisfiesExpression(p))
    ) {
      cur = p;
    } else break;
  }
  const parent = cur.getParent();
  if (!parent) return;

  // fetch(...).then((res) => ...)
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === cur && parent.getName() === "then") {
    const thenCall = parent.getParent();
    const cb = Node.isCallExpression(thenCall) ? thenCall.getArguments()[0] : undefined;
    if (cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb))) {
      const param = cb.getParameters()[0];
      if (param) bindName(param.getNameNode(), loc, param, env, c, depth);
    }
    return;
  }
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === cur) {
    bindName(parent.getNameNode(), loc, parent, env, c, depth);
    return;
  }
  if (Node.isBinaryExpression(parent) && parent.getRight() === cur && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
    const left = parent.getLeft();
    if (Node.isIdentifier(left)) bindName(left, loc, parent, env, c, depth);
    return;
  }
  // .then((r) => r.json()).then((d) => ...): what a .then callback returns is what the .then call resolves to
  const fn =
    Node.isArrowFunction(parent) && parent.getBody() === cur
      ? parent
      : Node.isReturnStatement(parent)
        ? parent.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a) || Node.isFunctionExpression(a))
        : undefined;
  const thenCall = fn?.getParent();
  if (Node.isCallExpression(thenCall) && thenCall.getArguments()[0] === fn) {
    const callee = thenCall.getExpression();
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === "then") {
      bindFrom(thenCall, loc, env, c, depth + 1);
      return;
    }
  }
  // Used in place: (await fetch(url)).status === 204, got(url).json()
  use(cur, loc, env, c, depth);
}

function bindName(name: Node, loc: Location, decl: Node, env: Envelope, c: Collector, depth: number): void {
  if (Node.isIdentifier(name)) {
    for (const ref of referencesOf(name.getText(), decl)) use(ref, loc, env, c, depth);
  } else if (Node.isObjectBindingPattern(name)) {
    for (const el of name.getElements()) {
      const prop = el.getPropertyNameNode()?.getText() ?? el.getName();
      bindName(el.getNameNode(), { ...loc, path: [...loc.path, prop] }, decl, env, c, depth);
      // A destructured name is itself a read of that field.
      interpret(env, { ...loc, path: [...loc.path, prop] }, [], el, c, depth, false);
    }
  }
}

/** Identifiers named `name` after `decl`, within the scope that declares it. Intra-file, no type checker. */
function referencesOf(name: string, decl: Node): Node[] {
  const scope =
    decl.getFirstAncestor(
      (n) =>
        Node.isBlock(n) || Node.isSourceFile(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n) ||
        Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n) || Node.isCaseClause(n),
    ) ?? decl.getSourceFile();
  const after = decl.getEnd();
  return descendantsOfKind(scope, SyntaxKind.Identifier).filter((id) => {
    if (id.getText() !== name || id.getStart() < after) return false;
    const p = id.getParent();
    if (Node.isPropertyAccessExpression(p) && p.getNameNode() === id) return false;
    if (Node.isPropertyAssignment(p) && p.getNameNode() === id) return false;
    if (Node.isBindingElement(p) || Node.isVariableDeclaration(p) || Node.isParameterDeclaration(p)) return false;
    return true;
  });
}

/** Climb the property-access chain from a reference and interpret the access. */
function use(ref: Node, loc: Location, env: Envelope, c: Collector, depth: number): void {
  const access: string[] = [];
  let cur = ref;
  for (;;) {
    const p = cur.getParent();
    if (Node.isPropertyAccessExpression(p) && p.getExpression() === cur) {
      access.push(p.getName());
      cur = p;
    } else if (Node.isElementAccessExpression(p) && p.getExpression() === cur) {
      const arg = p.getArgumentExpression();
      if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) access.push(arg.getLiteralValue());
      else access.push("[]");
      cur = p;
    } else if (p && (Node.isNonNullExpression(p) || Node.isParenthesizedExpression(p))) {
      cur = p;
    } else break;
  }
  interpret(env, loc, access, cur, c, depth, true);
}

function interpret(env: Envelope, loc: Location, access: string[], top: Node, c: Collector, depth: number, compare: boolean): void {
  const full = [...loc.path, ...access];
  if (loc.space === "body" || env === "body") {
    body(full, top, c, compare, env, depth);
    return;
  }
  const [first, ...rest] = full;
  if (first === undefined) return;
  const isCall = () => {
    const p = top.getParent();
    return Node.isCallExpression(p) && p.getExpression() === top;
  };

  const statusKey = env === "got" || env === "undici" ? "statusCode" : "status";
  if (first === statusKey && rest.length === 0) {
    if (compare) for (const n of comparedLiterals(top).nums) c.statusCodes.add(n);
    return;
  }
  if (first === "ok" && rest.length === 0) {
    c.checksOk = true;
    return;
  }
  if (first === "headers") {
    const [h] = rest;
    if (h === "get" && isCall()) {
      const arg = (top.getParent() as CallExpression).getArguments()[0];
      if (arg && Node.isStringLiteral(arg)) c.responseHeaders.add(arg.getLiteralValue().toLowerCase());
    } else if (h && h !== "get") c.responseHeaders.add(h.toLowerCase());
    return;
  }
  if (env === "axios" && first === "data") return body(rest, top, c, compare, env, depth);
  if (env === "got" && first === "body") return body(rest, top, c, compare, env, depth);
  // res.json() / got(...).json() / undici body.json()
  const bodyCall =
    ((env === "fetch" || env === "got") && rest.length === 0 && (first === "json" || first === "text")) ||
    (env === "undici" && first === "body" && rest.length === 1 && (rest[0] === "json" || rest[0] === "text"));
  if (bodyCall && isCall()) {
    bindFrom(top.getParent()!, { space: "body", path: [] }, env, c, depth + 1);
  }
}

function body(path: string[], top: Node, c: Collector, compare: boolean, env: Envelope, depth: number): void {
  const cut = path.findIndex((p) => NOT_FIELDS.has(p));
  const fieldPath = cut >= 0 ? path.slice(0, cut) : path;
  if (fieldPath.length === 0) return;
  const field = fieldPath.join(".").replace(/\.\[\]/g, "[]");
  c.fields.add(field);
  if (compare && cut < 0) {
    // Numeric codes count as enum values too (Twilio's error_code === 30036), as their decimal string.
    const { strs, nums } = comparedLiterals(top);
    for (const v of [...strs, ...nums.map(String)]) c.addEnum(field, v);
  }
  if (depth >= MAX_DEPTH) return;
  const items: Location = { space: "body", path: [...fieldPath, "[]"] };

  // body.results.map((item) => item.id), and const first = body.results.find(...)
  const method = cut >= 0 && cut === path.length - 1 ? path[cut]! : undefined;
  const call = top.getParent();
  if (method && method in ITEM_CALLBACKS && Node.isCallExpression(call) && call.getExpression() === top) {
    const cb = call.getArguments()[0];
    const param = cb && (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb)) ? cb.getParameters()[ITEM_CALLBACKS[method]!] : undefined;
    if (param) bindName(param.getNameNode(), items, param, env, c, depth + 1);
    if (method === "find") bindFrom(call, items, env, c, depth + 1);
    return;
  }
  // for (const item of body.results) { item.id }
  const loop = top.getParent();
  if (cut < 0 && Node.isForOfStatement(loop) && loop.getExpression() === top) {
    const list = loop.getInitializer();
    const decl = Node.isVariableDeclarationList(list) ? list.getDeclarations()[0] : undefined;
    if (decl) bindName(decl.getNameNode(), items, decl, env, c, depth + 1);
  }
}

/** Literals an expression is compared to: ===, !==, ==, !=, switch cases, [a, b].includes(x). */
function comparedLiterals(node: Node): { nums: number[]; strs: string[] } {
  const nums: number[] = [];
  const strs: string[] = [];
  const take = (n: Node | undefined) => {
    if (!n) return;
    if (Node.isNumericLiteral(n)) nums.push(Number(n.getLiteralValue()));
    else if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) strs.push(n.getLiteralValue());
  };
  let cur = node;
  while (Node.isParenthesizedExpression(cur.getParent())) cur = cur.getParent()!;
  const p = cur.getParent();
  if (Node.isBinaryExpression(p)) {
    const op = p.getOperatorToken().getKind();
    if (
      op === SyntaxKind.EqualsEqualsEqualsToken || op === SyntaxKind.ExclamationEqualsEqualsToken ||
      op === SyntaxKind.EqualsEqualsToken || op === SyntaxKind.ExclamationEqualsToken
    ) {
      take(p.getLeft() === cur ? p.getRight() : p.getLeft());
    }
  } else if (Node.isSwitchStatement(p) && p.getExpression() === cur) {
    for (const clause of p.getClauses()) if (Node.isCaseClause(clause)) take(clause.getExpression());
  } else if (Node.isCallExpression(p) && p.getArguments()[0] === cur) {
    const callee = p.getExpression();
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === "includes") {
      // `(["hosted", "hosted_page"] as unknown[]).includes(x)`: SHAPI's own fixes widen the list's type for tsc.
      let arr: Node = callee.getExpression();
      while (Node.isParenthesizedExpression(arr) || Node.isAsExpression(arr) || Node.isSatisfiesExpression(arr)) arr = arr.getExpression();
      if (Node.isArrayLiteralExpression(arr)) arr.getElements().forEach(take);
    }
  }
  return { nums, strs };
}
