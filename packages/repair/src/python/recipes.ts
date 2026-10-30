import type { Advisory, Fix, LockedCallSite } from "@shapi/core";
import { parsePython, type PyNode } from "@shapi/extractor";
import { applyEdits, codeSpan, swap, type Edit, type RecipeOutcome } from "../recipe";

/**
 * SHAPI's two deterministic recipes for Python call sites (execution plan U-03), on tree-sitter's syntax tree:
 * - `apply-fix`: the new path, query value or header in what the call sends: its URL (a string, an f-string, a
 *   concatenation, or a name assigned one in the same function or module) and its `params=` and `headers=` dicts.
 *   Renamed response fields and enum values are not rewritten in Python yet.
 * - `status-code-accept-set`: `resp.status_code != 204` becomes `resp.status_code not in (200, 204)`, and a tuple,
 *   list or set of codes compared with `in` gains the new ones.
 * The call site can be a call (requests, httpx, an SDK) or, for urllib and other code SHAPI sees only as a URL, the
 * URL string itself.
 */
export const PYTHON_RECIPES = new Set(["apply-fix", "status-code-accept-set"]);

export function runPythonRecipe(advisory: Advisory, callSite: LockedCallSite, text: string): RecipeOutcome {
  const id = advisory.recipeId;
  if (!id) return { status: "no-recipe", reason: "advisory names no recipe" };
  if (!PYTHON_RECIPES.has(id)) return { status: "no-recipe", recipe: id, reason: `recipe ${id} has no Python version` };
  const tree = parsePython(text);
  if (!tree) return { status: "call-not-found", recipe: id, reason: `${callSite.file} does not parse` };
  try {
    const target = nodeAt(tree.rootNode, callSite.line - 1, callSite.column - 1);
    if (!target) return { status: "call-not-found", recipe: id, reason: `no call at ${callSite.file}:${callSite.line}:${callSite.column}` };
    const where = (n: PyNode) => codeSpan(`${callSite.file}:${n.startPosition.row + 1}`);
    const edits = id === "apply-fix" ? applyFixEdits(target, advisory, where) : statusEdits(target, advisory, where);
    if (!edits.length) return { status: "no-change", recipe: id, reason: "recipe found nothing to change" };
    return { status: "applied", recipe: id, change: { file: callSite.file, before: text, after: applyEdits(text, edits), notes: edits.map((e) => e.note) } };
  } finally {
    tree.delete();
  }
}

/**
 * The node at the call site's position: the smallest call that starts there (`fetch(url).json()` holds two), or else
 * the whole URL expression (a concatenation starts where its first part does).
 */
function nodeAt(root: PyNode, row: number, column: number): PyNode | undefined {
  const at = (types: string[]) => root.descendantsOfType(types).filter((n): n is PyNode => n !== null && n.startPosition.row === row && n.startPosition.column === column);
  const size = (n: PyNode) => n.endIndex - n.startIndex;
  return at(["call"]).sort((a, b) => size(a) - size(b))[0] ?? at(["string", "concatenated_string", "binary_operator"]).sort((a, b) => size(b) - size(a))[0];
}

type Where = (n: PyNode) => string;

const enclosingFunction = (n: PyNode): PyNode | undefined => {
  for (let p = n.parent; p; p = p.parent) if (p.type === "function_definition") return p;
  return undefined;
};

/** What `name` was last assigned before `at`: in the enclosing function, else at module level. */
function assigned(name: string, at: PyNode): PyNode | undefined {
  const scopes = [enclosingFunction(at), at.tree.rootNode].filter((s): s is PyNode => s !== undefined);
  for (const scope of scopes) {
    const found = scope
      .descendantsOfType("assignment")
      .filter((a): a is PyNode => a !== null && a.startIndex < at.startIndex && a.childForFieldName("left")?.text === name)
      // A module-level lookup ignores assignments inside functions.
      .filter((a) => scope.type === "function_definition" || enclosingFunction(a) === undefined)
      .at(-1);
    const right = found?.childForFieldName("right");
    if (right) return right;
  }
  return undefined;
}

/** The string nodes an expression is built from, following names once each. */
function strings(n: PyNode | null | undefined, seen = new Set<number>()): PyNode[] {
  if (!n || seen.has(n.id)) return [];
  seen.add(n.id);
  if (n.type === "string") return [n];
  if (n.type === "concatenated_string" || n.type === "parenthesized_expression") return n.namedChildren.flatMap((c) => strings(c, seen));
  if (n.type === "binary_operator") return [n.childForFieldName("left"), n.childForFieldName("right")].flatMap((c) => strings(c, seen));
  if (n.type === "identifier") return strings(assigned(n.text, n), seen);
  return [];
}

/** A call's keyword argument, or its first positional argument for `url`. */
function argument(call: PyNode, name: string): PyNode | undefined {
  const args = call.childForFieldName("arguments")?.namedChildren.filter((a): a is PyNode => a !== null) ?? [];
  const kw = args.find((a) => a.type === "keyword_argument" && a.childForFieldName("name")?.text === name);
  if (kw) return kw.childForFieldName("value") ?? undefined;
  return name === "url" ? args.find((a) => a.type !== "keyword_argument") : undefined;
}

/** A dict literal an expression is (or a name assigned one). */
function dict(n: PyNode | undefined): PyNode | undefined {
  if (!n) return undefined;
  if (n.type === "dictionary") return n;
  if (n.type === "identifier") return dict(assigned(n.text, n));
  return undefined;
}

const unquote = (s: PyNode) => s.namedChildren.filter((c) => c?.type === "string_content").map((c) => c!.text).join("");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function applyFixEdits(target: PyNode, advisory: Advisory, where: Where): Edit[] {
  const fix: Fix | undefined = advisory.fix;
  if (!fix) return [];
  const call = target.type === "call" ? target : undefined;
  const below = fix.query ? advisory.trigger.query?.find((q) => q.name === fix.query!.name)?.below : undefined;
  // With a threshold ("minorversion below 75") only values under it are retired: a higher one stays.
  const retired = (value: string) => below === undefined || !/^\d+(\.\d+)?$/.test(value) || Number(value) < below;
  const edits: Edit[] = [];

  if (fix.path || fix.query) {
    const urls = call ? strings(argument(call, "url")) : strings(target);
    for (const s of urls) {
      const before = s.text;
      let after = before;
      if (fix.path) {
        after = after.split(fix.path.from).join(fix.path.to);
        // A base URL constant often ends at the version: "https://graph.facebook.com/v21.0".
        const from = fix.path.from.replace(/\/$/, "");
        if (from !== fix.path.from) after = after.replace(new RegExp(`${escapeRe(from)}(?=["'{])`, "g"), fix.path.to.replace(/\/$/, ""));
      }
      if (fix.query) {
        const re = new RegExp(`([?&])${escapeRe(fix.query.name)}=([^&#"'{}\\s]+)`, "g");
        after = after.replace(re, (m, sep: string, value: string) => (retired(value) ? `${sep}${fix.query!.name}=${fix.query!.value}` : m));
      }
      if (after !== before) edits.push({ start: s.startIndex, end: s.endIndex, text: after, note: `${where(s)} ${swap(before, after)}` });
    }
  }

  const pairs = (name: string) =>
    (dict(call ? argument(call, name) : undefined)?.namedChildren ?? []).filter((p): p is PyNode => p?.type === "pair").map((p) => ({ key: p.childForFieldName("key"), value: p.childForFieldName("value") }));
  if (fix.query && call) {
    for (const { key, value } of pairs("params")) {
      if (key?.type !== "string" || unquote(key) !== fix.query.name || !value) continue;
      const current = value.type === "string" ? unquote(value) : value.type === "integer" || value.type === "float" ? value.text : undefined;
      if (current === undefined || current === fix.query.value || !retired(current)) continue;
      const text = value.type !== "string" && /^\d+(\.\d+)?$/.test(fix.query.value) ? fix.query.value : JSON.stringify(fix.query.value);
      edits.push({ start: value.startIndex, end: value.endIndex, text, note: `${where(value)} ${fix.query.name}: ${swap(value.text, text)}` });
    }
  }
  if (fix.header && call) {
    const text = JSON.stringify(fix.header.value);
    for (const { key, value } of pairs("headers")) {
      if (key?.type !== "string" || unquote(key).toLowerCase() !== fix.header.name.toLowerCase() || value?.type !== "string" || unquote(value) === fix.header.value) continue;
      // An f-string or a value built at runtime is left alone.
      if (value.namedChildren.some((c) => c?.type === "interpolation")) continue;
      edits.push({ start: value.startIndex, end: value.endIndex, text, note: `${where(value)} ${fix.header.name}: ${swap(value.text, text)}` });
    }
  }
  return edits;
}

const STATUS_ATTRS = new Set(["status_code", "status", "code"]);

function statusEdits(target: PyNode, advisory: Advisory, where: Where): Edit[] {
  const oldCodes = advisory.trigger.statusCodes ?? [];
  const accept = [...new Set([...oldCodes, ...(advisory.trigger.newStatusCodes ?? [])])].sort((a, b) => a - b);
  if (!oldCodes.length || accept.length === oldCodes.length) return [];
  const scope = enclosingFunction(target) ?? target.tree.rootNode;
  // The response's name: `resp = requests.post(...)`, or `with urlopen(req) as resp:`. Unknown: any status in the scope.
  const response = responseName(target);
  const isStatus = (n: PyNode | null | undefined) =>
    n?.type === "attribute" && STATUS_ATTRS.has(n.childForFieldName("attribute")?.text ?? "") && (!response || n.childForFieldName("object")?.text === response);
  const edits: Edit[] = [];
  for (const cmp of scope.descendantsOfType("comparison_operator")) {
    if (!cmp) continue;
    const operands = cmp.namedChildren.filter((c): c is PyNode => c !== null);
    const ops = cmp.children.filter((c) => c !== null && !c.isNamed).map((c) => c!.text);
    if (operands.length !== 2 || ops.length === 0) continue;
    const [left, right] = operands as [PyNode, PyNode];
    const status = isStatus(left) ? left : isStatus(right) ? right : undefined;
    if (!status) continue;
    const other = status === left ? right : left;
    const op = ops.join(" ");
    if ((op === "==" || op === "!=") && other.type === "integer" && oldCodes.includes(Number(other.text))) {
      const text = `${status.text} ${op === "!=" ? "not in" : "in"} (${accept.join(", ")})`;
      edits.push({ start: cmp.startIndex, end: cmp.endIndex, text, note: `${where(cmp)} ${swap(cmp.text, text)}` });
    } else if ((op === "in" || op === "not in") && status === left && ["tuple", "list", "set"].includes(other.type)) {
      const values = other.namedChildren.filter((c): c is PyNode => c?.type === "integer").map((c) => Number(c.text));
      if (!values.some((v) => oldCodes.includes(v))) continue;
      const merged = [...new Set([...values, ...accept])].sort((a, b) => a - b);
      if (merged.length === values.length) continue;
      const [open, close] = other.type === "tuple" ? ["(", ")"] : other.type === "list" ? ["[", "]"] : ["{", "}"];
      const text = `${open}${merged.join(", ")}${close}`;
      edits.push({ start: other.startIndex, end: other.endIndex, text, note: `${where(other)} ${swap(other.text, text)}` });
    }
  }
  return edits;
}

function responseName(target: PyNode): string | undefined {
  for (let p: PyNode | null = target.parent; p && p.type !== "function_definition"; p = p.parent) {
    if (p.type === "assignment") return p.childForFieldName("left")?.type === "identifier" ? p.childForFieldName("left")!.text : undefined;
    if (p.type === "as_pattern") return p.childForFieldName("alias")?.text ?? p.namedChildren.at(-1)?.text;
    if (p.type === "with_item") return p.namedChildren.find((c) => c?.type === "as_pattern")?.namedChildren.at(-1)?.text;
  }
  return undefined;
}
