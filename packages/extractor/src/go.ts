import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { HTTP_METHODS, providerForHost, type CallSite, type HttpMethod, type NameValue, type Surface } from "@shapi/core";
import { Language, Parser, type Node } from "web-tree-sitter";
import { parseUrl } from "./callsites";

// Go call sites, syntax only (tree-sitter), scan only (execution plan U-07): net/http requests, with the
// same CallSite shape as the TypeScript and Python extractors. What the code depends on in the response
// comes from the struct it decodes into: the JSON names of the fields it reads, the strings it compares
// them to, the status codes it checks and the headers it reads. Intra-file, no type checking.

let parser: Parser | undefined;

/** Load the Go grammar once. Until it is loaded, Go files are reported as skipped. */
export async function loadGoParser(): Promise<void> {
  if (parser) return;
  await Parser.init();
  // The published shapi-cli ships the grammar next to its bundle; in the monorepo it comes from tree-sitter-go.
  const bundled = fileURLToPath(new URL("./tree-sitter-go.wasm", import.meta.url));
  const wasm = existsSync(bundled) ? bundled : createRequire(import.meta.url).resolve("tree-sitter-go/tree-sitter-go.wasm");
  const language = await Language.load(wasm);
  const p = new Parser();
  p.setLanguage(language);
  parser = p;
}

export function goParserLoaded(): boolean {
  return parser !== undefined;
}

/** net/http's package-level request functions and the method each one sends. */
const SHORTHANDS: Record<string, HttpMethod> = { Get: "GET", Head: "HEAD", Post: "POST", PostForm: "POST" };

/** net/http's status constants that code compares against, by name. */
const STATUS: Record<string, number> = {
  StatusOK: 200, StatusCreated: 201, StatusAccepted: 202, StatusNoContent: 204, StatusMovedPermanently: 301,
  StatusFound: 302, StatusNotModified: 304, StatusBadRequest: 400, StatusUnauthorized: 401, StatusPaymentRequired: 402,
  StatusForbidden: 403, StatusNotFound: 404, StatusMethodNotAllowed: 405, StatusConflict: 409, StatusGone: 410,
  StatusPreconditionFailed: 412, StatusUnprocessableEntity: 422, StatusTooManyRequests: 429,
  StatusInternalServerError: 500, StatusBadGateway: 502, StatusServiceUnavailable: 503, StatusGatewayTimeout: 504,
};

interface FileContext {
  /** Local names of imported packages, by import path: "net/http" → "http". */
  imports: Map<string, string>;
  consts: Map<string, Node>;
  types: Map<string, Node>;
}

/** Every call site in one Go file. */
export function extractGo(source: string, file: string): CallSite[] {
  if (!parser) throw new Error("call loadGoParser() before extracting Go");
  const tree = parser.parse(source);
  if (!tree) return [];
  try {
    const root = tree.rootNode;
    const ctx: FileContext = { imports: imports(root), consts: new Map(), types: new Map() };
    collectDecls(root, ctx);
    const http = ctx.imports.get("net/http");
    if (!http) return [];
    const sites: CallSite[] = [];
    for (const call of root.descendantsOfType("call_expression")) {
      if (!call) continue;
      const site = httpCall(ctx, http, call);
      if (site) sites.push({ ...site, file });
    }
    return sites;
  } finally {
    tree.delete();
  }
}

// ---------------------------------------------------------------------------
// Names: imports, package-level constants and types

function imports(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const spec of root.descendantsOfType("import_spec")) {
    const p = spec ? stringLiteral(spec.childForFieldName("path") ?? undefined) : undefined;
    if (!p) continue;
    const alias = spec!.childForFieldName("name")?.text;
    out.set(p, alias ?? p.split("/").at(-1)!);
  }
  return out;
}

function collectDecls(root: Node, ctx: FileContext): void {
  for (const decl of root.namedChildren) {
    if (decl?.type === "const_declaration" || decl?.type === "var_declaration") {
      for (const spec of decl.descendantsOfType(["const_spec", "var_spec"])) {
        const names = spec?.childrenForFieldName("name") ?? [];
        const values = spec?.childForFieldName("value")?.namedChildren ?? [];
        names.forEach((n, i) => {
          if (n && values[i]) ctx.consts.set(n.text, values[i]!);
        });
      }
    } else if (decl?.type === "type_declaration") {
      for (const spec of decl.namedChildren) {
        const name = spec?.childForFieldName("name")?.text;
        const type = spec?.childForFieldName("type");
        if (name && type) ctx.types.set(name, type);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Calls

function httpCall(ctx: FileContext, http: string, call: Node): CallSite | undefined {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "selector_expression" || fn.childForFieldName("operand")?.text !== http) return undefined;
  const name = fn.childForFieldName("field")?.text ?? "";
  const args = (call.childForFieldName("arguments")?.namedChildren ?? []).filter(Boolean) as Node[];
  const scope = functionOf(call);
  let method: HttpMethod | null;
  let urlNode: Node | undefined;
  let request: string | undefined;
  if (SHORTHANDS[name]) {
    method = SHORTHANDS[name]!;
    urlNode = args[0];
  } else if (name === "NewRequest" || name === "NewRequestWithContext") {
    const [m, u] = name === "NewRequest" ? args : args.slice(1);
    method = methodOf(ctx, http, m, scope);
    urlNode = u;
    request = assignedName(call);
  } else return undefined;

  const { host, path, query } = parseUrl(evalString(ctx, urlNode, scope));
  const surface = emptySurface();
  surface.query = query;
  if (request && scope) surface.headers = requestHeaders(ctx, scope, request, call);
  // The response: the shorthand's result, or what client.Do(req) returns.
  const response = request && scope ? doResult(scope, request, call) : assignedName(call);
  if (response && scope) responseSurface(ctx, scope, response, call, surface);
  const provider = host ? (providerForHost(host)?.id ?? null) : null;
  return {
    file: "",
    line: call.startPosition.row + 1,
    column: call.startPosition.column + 1,
    provider,
    kind: "http",
    client: "net/http",
    method,
    host,
    endpoint: path,
    resolved: Boolean(provider && path && method),
    surface,
  } satisfies CallSite;
}

function methodOf(ctx: FileContext, http: string, node: Node | undefined, scope: Node | undefined): HttpMethod | null {
  if (node?.type === "selector_expression" && node.childForFieldName("operand")?.text === http) {
    const m = node.childForFieldName("field")?.text.replace(/^Method/, "").toUpperCase();
    return m && (HTTP_METHODS as readonly string[]).includes(m) ? (m as HttpMethod) : null;
  }
  const m = evalString(ctx, node, scope)?.toUpperCase();
  return m && (HTTP_METHODS as readonly string[]).includes(m) ? (m as HttpMethod) : null;
}

/** `req.Header.Set("K", v)` and `.Add` on the request, after it is made. */
function requestHeaders(ctx: FileContext, scope: Node, request: string, after: Node): NameValue[] {
  const out: NameValue[] = [];
  for (const c of scope.descendantsOfType("call_expression")) {
    if (!c || c.startIndex < after.endIndex) continue;
    const fn = c.childForFieldName("function");
    const chain = fn ? chainOf(fn) : undefined;
    if (!chain || chain.root !== request || chain.names.length !== 2 || chain.names[0] !== "Header" || !["Set", "Add"].includes(chain.names[1]!)) continue;
    const [k, v] = (c.childForFieldName("arguments")?.namedChildren ?? []) as Node[];
    const name = evalString(ctx, k, scope);
    if (name) out.push({ name: name.toLowerCase(), value: v ? (evalString(ctx, v, scope) ?? null) : null });
  }
  return out;
}

/** `resp, err := client.Do(req)`: the name the response of `request` is bound to. */
function doResult(scope: Node, request: string, after: Node): string | undefined {
  for (const c of scope.descendantsOfType("call_expression")) {
    if (!c || c.startIndex < after.endIndex) continue;
    const fn = c.childForFieldName("function");
    if (fn?.type !== "selector_expression" || fn.childForFieldName("field")?.text !== "Do") continue;
    const arg = c.childForFieldName("arguments")?.namedChildren[0];
    if (arg?.type === "identifier" && arg.text === request) return assignedName(c);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Response surface

/** What the code reads from the response bound to `resp`: status codes, headers, and the decoded body. */
function responseSurface(ctx: FileContext, scope: Node, resp: string, after: Node, s: Surface): void {
  const fields = new Set<string>();
  const statusCodes = new Set<number>();
  const enums = new Map<string, Set<string>>();
  const headers = new Set<string>();
  const bodies = new Set<string>([`${resp}.Body`]);
  for (const sel of references(scope, resp, after)) {
    const chain = chainUp(sel);
    if (chain.names[0] === "StatusCode") {
      for (const n of compared(chain.top).nums) statusCodes.add(n);
      if (compared(chain.top).range) s.checksOk = true;
    } else if (chain.names[0] === "Header" && chain.names[1] === "Get") {
      const arg = chain.call?.childForFieldName("arguments")?.namedChildren[0];
      const h = arg ? stringLiteral(arg) : undefined;
      if (h) headers.add(h.toLowerCase());
    }
  }
  // body, _ := io.ReadAll(resp.Body): the bytes json.Unmarshal reads.
  for (const c of scope.descendantsOfType("call_expression")) {
    if (c?.childForFieldName("function")?.text.endsWith("ReadAll") && c.childForFieldName("arguments")?.namedChildren[0]?.text === `${resp}.Body`) {
      const name = assignedName(c);
      if (name) bodies.add(name);
    }
  }
  // json.NewDecoder(resp.Body).Decode(&v) / json.Unmarshal(body, &v)
  for (const c of scope.descendantsOfType("call_expression")) {
    if (!c) continue;
    const fn = c.childForFieldName("function");
    const args = (c.childForFieldName("arguments")?.namedChildren ?? []) as Node[];
    let target: Node | undefined;
    if (fn?.type === "selector_expression" && fn.childForFieldName("field")?.text === "Decode") {
      const decoder = fn.childForFieldName("operand");
      const src = decoder?.type === "call_expression" ? decoder.childForFieldName("arguments")?.namedChildren[0]?.text : undefined;
      if (src && bodies.has(src)) target = args[0];
    } else if (fn?.text.endsWith("Unmarshal") && args[0] && bodies.has(args[0].text)) target = args[1];
    const v = target?.type === "unary_expression" ? target.childForFieldName("operand") : target;
    if (v?.type !== "identifier") continue;
    const type = varType(ctx, scope, v.text);
    if (type) readFields(ctx, scope, v.text, type, [], c, { fields, enums }, 0);
  }
  s.statusCodes = [...statusCodes].sort((a, b) => a - b);
  s.responseHeaders = [...headers].sort();
  s.fields = [...fields].sort();
  s.enums = [...enums].map(([field, values]) => ({ field, values: [...values].sort() })).sort((a, b) => a.field.localeCompare(b.field));
}

interface Found {
  fields: Set<string>;
  enums: Map<string, Set<string>>;
}

/** Selector chains on `name` (a value of struct `type`), as JSON paths; range loops over its slices follow the items. */
function readFields(ctx: FileContext, scope: Node, name: string, type: Node, prefix: string[], after: Node, out: Found, depth: number): void {
  if (depth > 4) return;
  for (const ref of references(scope, name, after)) {
    let t: Node | undefined = type;
    const path = [...prefix];
    let cur = ref;
    for (;;) {
      const p = cur.parent;
      if (p?.type === "selector_expression" && p.childForFieldName("operand")?.id === cur.id) {
        const field: { json: string; type: Node | undefined } | undefined = t ? structField(ctx, t, p.childForFieldName("field")?.text ?? "") : undefined;
        if (!field) break;
        path.push(field.json);
        t = field.type;
        cur = p;
      } else if (p?.type === "index_expression" && p.childForFieldName("operand")?.id === cur.id) {
        const elem = t ? elementOf(ctx, t) : undefined;
        if (!elem) break;
        path.push("[]");
        t = elem;
        cur = p;
      } else if (p?.type === "parenthesized_expression") cur = p;
      else break;
    }
    if (path.length === prefix.length) continue;
    const field = path.join(".").replace(/\.\[\]/g, "[]");
    out.fields.add(field);
    for (const str of compared(cur).strs) {
      const set = out.enums.get(field) ?? new Set<string>();
      set.add(str);
      out.enums.set(field, set);
    }
    // for _, item := range v.Items
    const range = cur.parent?.type === "range_clause" && cur.parent.childForFieldName("right")?.id === cur.id ? cur.parent : undefined;
    const elem = range && t ? elementOf(ctx, t) : undefined;
    const item = range?.childForFieldName("left")?.namedChildren[1];
    if (elem && item?.type === "identifier" && item.text !== "_") {
      readFields(ctx, range!.parent ?? scope, item.text, elem, [...path, "[]"], range!, out, depth + 1);
    }
  }
}

/** A struct field's JSON name (its tag, or the Go name) and type. */
function structField(ctx: FileContext, type: Node, goName: string): { json: string; type: Node | undefined } | undefined {
  const struct = resolve(ctx, type);
  if (struct?.type !== "struct_type") return undefined;
  for (const decl of struct.descendantsOfType("field_declaration")) {
    if (!decl || decl.parent?.parent?.id !== struct.id) continue;
    if (!decl.childrenForFieldName("name").some((n) => n?.text === goName)) continue;
    const tag = decl.childForFieldName("tag");
    const json = tag ? /json:"([^",]*)/.exec(stringLiteral(tag) ?? "")?.[1] : undefined;
    if (json === "-") return undefined;
    return { json: json || goName, type: decl.childForFieldName("type") ?? undefined };
  }
  return undefined;
}

function elementOf(ctx: FileContext, type: Node): Node | undefined {
  const t = resolve(ctx, type);
  if (t?.type === "slice_type" || t?.type === "array_type") return t.childForFieldName("element") ?? undefined;
  if (t?.type === "map_type") return t.childForFieldName("value") ?? undefined;
  return undefined;
}

/** Follow pointers and named types declared in this file. */
function resolve(ctx: FileContext, type: Node, depth = 0): Node | undefined {
  if (depth > 8) return undefined;
  if (type.type === "pointer_type") return resolve(ctx, type.namedChildren[0]!, depth + 1);
  if (type.type === "type_identifier") {
    const named = ctx.types.get(type.text);
    return named ? resolve(ctx, named, depth + 1) : undefined;
  }
  return type;
}

/** The declared type of a local: `var v T`, `var v struct{…}`, `v := T{}`, `v := &T{}`, `v := new(T)`. */
function varType(ctx: FileContext, scope: Node, name: string): Node | undefined {
  for (const spec of scope.descendantsOfType("var_spec")) {
    if (spec?.childrenForFieldName("name").some((n) => n?.text === name)) return spec.childForFieldName("type") ?? undefined;
  }
  for (const decl of scope.descendantsOfType("short_var_declaration")) {
    const left = decl?.childForFieldName("left")?.namedChildren ?? [];
    const i = left.findIndex((n) => n?.text === name);
    if (i < 0) continue;
    let v = decl!.childForFieldName("right")?.namedChildren[i];
    if (v?.type === "unary_expression") v = v.childForFieldName("operand") ?? undefined;
    if (v?.type === "composite_literal") return v.childForFieldName("type") ?? undefined;
    if (v?.type === "call_expression" && v.childForFieldName("function")?.text === "new") return v.childForFieldName("arguments")?.namedChildren[0] ?? undefined;
  }
  return undefined;
}

/** Literals an expression is compared to (==, !=, switch cases), and whether it is range-checked (>= 200, < 300). */
function compared(node: Node): { nums: number[]; strs: string[]; range: boolean } {
  const nums: number[] = [];
  const strs: string[] = [];
  let range = false;
  const take = (n: Node | null | undefined) => {
    if (!n) return;
    if (n.type === "int_literal") nums.push(Number(n.text));
    else if (n.type === "selector_expression" && STATUS[n.childForFieldName("field")?.text ?? ""]) nums.push(STATUS[n.childForFieldName("field")!.text]!);
    else {
      const s = stringLiteral(n);
      if (s !== undefined) strs.push(s);
    }
  };
  let cur = node;
  while (cur.parent?.type === "parenthesized_expression") cur = cur.parent;
  const p = cur.parent;
  if (p?.type === "binary_expression") {
    const op = p.childForFieldName("operator")?.text;
    const other = p.childForFieldName("left")?.id === cur.id ? p.childForFieldName("right") : p.childForFieldName("left");
    if (op === "==" || op === "!=") take(other);
    else if (op && ["<", "<=", ">", ">="].includes(op)) range = true;
  } else if (p?.type === "expression_switch_statement" && p.childForFieldName("value")?.id === cur.id) {
    for (const c of p.namedChildren) {
      if (c?.type === "expression_case") for (const v of c.childForFieldName("value")?.namedChildren ?? []) take(v);
    }
  }
  return { nums, strs, range };
}

// ---------------------------------------------------------------------------
// Expressions

function functionOf(node: Node): Node | undefined {
  let cur: Node | null = node.parent;
  while (cur && cur.type !== "function_declaration" && cur.type !== "method_declaration" && cur.type !== "func_literal") cur = cur.parent;
  return cur?.childForFieldName("body") ?? undefined;
}

/** The first name a call's result is bound to: `x, err := call()` / `x = call()` → "x". */
function assignedName(call: Node): string | undefined {
  let cur = call;
  while (cur.parent?.type === "parenthesized_expression") cur = cur.parent;
  const list = cur.parent;
  const decl = list?.parent;
  if (list?.type !== "expression_list" || (decl?.type !== "short_var_declaration" && decl?.type !== "assignment_statement")) return undefined;
  if (decl.childForFieldName("right")?.id !== list.id) return undefined;
  const left = decl.childForFieldName("left")?.namedChildren[0];
  return left?.type === "identifier" && left.text !== "_" ? left.text : undefined;
}

/** Identifiers named `name` after `after`, in `scope`. */
function references(scope: Node, name: string, after: Node): Node[] {
  return scope.descendantsOfType("identifier").filter((id): id is Node => Boolean(id && id.text === name && id.startIndex >= after.endIndex));
}

/** `a.b.c` → root "a", names ["b", "c"]. */
function chainOf(node: Node): { root: string; names: string[] } | undefined {
  const names: string[] = [];
  let cur = node;
  while (cur.type === "selector_expression") {
    names.unshift(cur.childForFieldName("field")!.text);
    cur = cur.childForFieldName("operand")!;
  }
  return cur.type === "identifier" ? { root: cur.text, names } : undefined;
}

/** From a reference, climb its selectors: `resp.Header.Get` → names ["Header", "Get"], with the call if it is one. */
function chainUp(ref: Node): { names: string[]; top: Node; call?: Node } {
  const names: string[] = [];
  let cur = ref;
  while (cur.parent?.type === "selector_expression" && cur.parent.childForFieldName("operand")?.id === cur.id) {
    names.push(cur.parent.childForFieldName("field")!.text);
    cur = cur.parent;
  }
  const call = cur.parent?.type === "call_expression" && cur.parent.childForFieldName("function")?.id === cur.id ? cur.parent : undefined;
  return { names, top: cur, ...(call ? { call } : {}) };
}

function stringLiteral(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "raw_string_literal") return n.text.slice(1, -1);
  if (n.type !== "interpreted_string_literal") return undefined;
  return n.namedChildren.map((c) => (c?.type === "escape_sequence" ? JSON.parse(`"${c.text}"`) : (c?.text ?? ""))).join("");
}

/** A string expression's value, with unknown parts as {name}: literals, `+`, constants, locals, fmt.Sprintf. */
function evalString(ctx: FileContext, node: Node | undefined, scope: Node | undefined, depth = 0): string | undefined {
  if (!node || depth > 8) return undefined;
  const lit = stringLiteral(node);
  if (lit !== undefined) return lit;
  if (node.type === "parenthesized_expression") return evalString(ctx, node.namedChildren[0] ?? undefined, scope, depth + 1);
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
    const l = node.childForFieldName("left") ?? undefined;
    const r = node.childForFieldName("right") ?? undefined;
    const lv = evalString(ctx, l, scope, depth + 1);
    const rv = evalString(ctx, r, scope, depth + 1);
    if (lv === undefined && rv === undefined) return undefined;
    return (lv ?? placeholder(l)) + (rv ?? placeholder(r));
  }
  if (node.type === "identifier") {
    const local = scope ? localValue(scope, node) : undefined;
    const init = local ?? ctx.consts.get(node.text);
    return init && init.id !== node.id ? evalString(ctx, init, scope, depth + 1) : undefined;
  }
  if (node.type === "call_expression" && /^(fmt\.)?Sprintf$/.test(node.childForFieldName("function")?.text ?? "")) {
    const [format, ...rest] = (node.childForFieldName("arguments")?.namedChildren ?? []) as Node[];
    const f = evalString(ctx, format, scope, depth + 1);
    if (f === undefined) return undefined;
    let i = 0;
    return f.replace(/%[-+# 0]*\d*(\.\d+)?[svdqx]/g, () => {
      const arg = rest[i++];
      return evalString(ctx, arg, scope, depth + 1) ?? placeholder(arg);
    });
  }
  return undefined;
}

/** `x := expr` earlier in the function. */
function localValue(scope: Node, id: Node): Node | undefined {
  for (const decl of scope.descendantsOfType("short_var_declaration")) {
    if (!decl || decl.startIndex >= id.startIndex) continue;
    const left = decl.childForFieldName("left")?.namedChildren ?? [];
    const right = decl.childForFieldName("right")?.namedChildren ?? [];
    const i = left.findIndex((n) => n?.text === id.text);
    if (i >= 0 && left.length === right.length) return right[i] ?? undefined;
  }
  return undefined;
}

function placeholder(n: Node | undefined): string {
  if (!n) return "{}";
  if (n.type === "identifier") return `{${n.text}}`;
  if (n.type === "selector_expression") return `{${n.childForFieldName("field")?.text ?? ""}}`;
  // os.Getenv("GITHUB_TOKEN")
  if (n.type === "call_expression" && /(^|.)Getenv$/.test(n.childForFieldName("function")?.text ?? "")) {
    const name = stringLiteral(n.childForFieldName("arguments")?.namedChildren[0] ?? undefined);
    if (name) return `{${name}}`;
  }
  // url.PathEscape(name), strconv.Itoa(id)
  const args = n.type === "call_expression" ? (n.childForFieldName("arguments")?.namedChildren ?? []).filter(Boolean) : [];
  if (args.length === 1) return placeholder(args[0]!);
  return "{}";
}

function emptySurface(): Surface {
  return { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] };
}
