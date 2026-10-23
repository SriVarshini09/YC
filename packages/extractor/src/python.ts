import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { HTTP_METHODS, getProvider, providerForHost, providerForPythonModule, type CallSite, type HttpMethod, type NameValue, type Provider, type Surface } from "@shapi/core";
import { Language, Parser, type Node } from "web-tree-sitter";
import { parseUrl } from "./callsites";

// Python call sites, syntax only (tree-sitter), with the same shape as the TypeScript extractor's:
// HTTP clients (requests, httpx, aiohttp) and provider SDKs, plus what the code depends on in the
// response. Like the TypeScript side: intra-file, no type inference, no imports followed.

let parser: Parser | undefined;

/** Load the Python grammar once. Until it is loaded, Python files are reported as skipped. */
export async function loadPythonParser(): Promise<void> {
  if (parser) return;
  await Parser.init();
  // The published shapi-cli ships the grammar next to its bundle; in the monorepo it comes from tree-sitter-python.
  const bundled = fileURLToPath(new URL("./tree-sitter-python.wasm", import.meta.url));
  const wasm = existsSync(bundled) ? bundled : createRequire(import.meta.url).resolve("tree-sitter-python/tree-sitter-python.wasm");
  const language = await Language.load(wasm);
  const p = new Parser();
  p.setLanguage(language);
  parser = p;
}

export function pythonParserLoaded(): boolean {
  return parser !== undefined;
}

type Lib = "requests" | "httpx" | "aiohttp";
const HTTP_LIBS = new Set<string>(["requests", "httpx", "aiohttp"]);
const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/** What a name in the file refers to. */
type Binding =
  | { kind: "http-module"; lib: Lib }
  | { kind: "http-client"; lib: Lib; baseUrl?: string; headers: NameValue[] }
  | { kind: "sdk-module"; provider: Provider; module: string }
  | { kind: "sdk-client"; provider: Provider; module: string };

interface FileContext {
  names: Map<string, Binding>;
  consts: Map<string, Node>;
}

/** Every call site in one Python file. */
export function extractPython(source: string, file: string): CallSite[] {
  if (!parser) throw new Error("call loadPythonParser() before extracting Python");
  const tree = parser.parse(source);
  if (!tree) return [];
  try {
    const root = tree.rootNode;
    const ctx: FileContext = { names: new Map(), consts: new Map() };
    collectImports(root, ctx);
    collectConsts(root, ctx);
    collectClients(root, ctx);
    const sites: CallSite[] = [];
    for (const call of root.descendantsOfType("call")) {
      if (!call) continue;
      const site = httpCall(ctx, call) ?? sdkCall(ctx, call);
      if (!site) continue;
      site.file = file;
      site.line = call.startPosition.row + 1;
      site.column = call.startPosition.column + 1;
      addResponseSurface(call, site);
      sites.push(site);
    }
    return sites;
  } finally {
    tree.delete();
  }
}

// ---------------------------------------------------------------------------
// Names: imports, module constants, client instances

function collectImports(root: Node, ctx: FileContext): void {
  for (const st of root.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (!st) continue;
    if (st.type === "import_statement") {
      // import requests / import httpx as hx / import stripe
      for (const item of st.namedChildren) {
        if (!item) continue;
        const dotted = item.type === "aliased_import" ? item.childForFieldName("name") : item;
        const alias = item.type === "aliased_import" ? item.childForFieldName("alias")?.text : dotted?.text.split(".")[0];
        if (!dotted || !alias) continue;
        bindModule(ctx, alias, dotted.text);
      }
    } else {
      // from httpx import Client / from openai import OpenAI / from twilio.rest import Client
      const module = st.childForFieldName("module_name")?.text;
      if (!module) continue;
      for (const item of st.childrenForFieldName("name")) {
        if (!item) continue;
        const name = item.type === "aliased_import" ? item.childForFieldName("name")?.text : item.text;
        const alias = item.type === "aliased_import" ? item.childForFieldName("alias")?.text : item.text;
        if (name && alias) bindModule(ctx, alias, `${module}.${name}`);
      }
    }
  }
}

function bindModule(ctx: FileContext, alias: string, dotted: string): void {
  const top = dotted.split(".")[0]!;
  if (HTTP_LIBS.has(top)) {
    ctx.names.set(alias, { kind: "http-module", lib: top as Lib });
    return;
  }
  const provider = providerForPythonModule(top);
  if (provider) ctx.names.set(alias, { kind: "sdk-module", provider, module: dotted });
}

/** Module-level `NAME = <expression>`, for URLs built from constants. */
function collectConsts(root: Node, ctx: FileContext): void {
  for (const st of root.namedChildren) {
    const assign = st?.type === "expression_statement" ? st.namedChildren[0] : undefined;
    if (assign?.type !== "assignment") continue;
    const left = assign.childForFieldName("left");
    const right = assign.childForFieldName("right");
    if (left?.type === "identifier" && right) ctx.consts.set(left.text, right);
  }
}

/** `x = requests.Session()`, `client = httpx.Client(base_url=...)`, `client = OpenAI()`, `self.http = ...`. */
function collectClients(root: Node, ctx: FileContext): void {
  const visit = (target: string, value: Node) => {
    const call = unwrap(value);
    if (call.type !== "call") return;
    const fn = call.childForFieldName("function");
    const chain = fn ? chainOf(fn) : undefined;
    if (!chain) return;
    const base = ctx.names.get(chain.root);
    if (!base) return;
    if (base.kind === "http-module" || base.kind === "http-client") {
      const ctor = chain.names.at(-1);
      if (!ctor || !/^(Session|Client|AsyncClient|ClientSession)$/.test(ctor)) return;
      const args = call.childForFieldName("arguments");
      const baseUrl = evalString(ctx, keyword(args, "base_url"));
      ctx.names.set(target, { kind: "http-client", lib: base.lib, ...(baseUrl ? { baseUrl } : {}), headers: dictEntries(ctx, keyword(args, "headers")) });
      return;
    }
    // An SDK constructor or factory on the module: OpenAI(), stripe.StripeClient(...), WebClient(token=...),
    // hubspot.Client.create(...). Results of API calls (an endpoint is known) are data, not clients.
    if (base.kind === "sdk-module" && !sdkEndpoint(base.provider, [...modulePath(base), ...chain.names])) {
      ctx.names.set(target, { kind: "sdk-client", provider: base.provider, module: base.module });
    }
  };
  for (const assign of root.descendantsOfType("assignment")) {
    const left = assign?.childForFieldName("left");
    const right = assign?.childForFieldName("right");
    if (left && right && (left.type === "identifier" || left.type === "attribute")) visit(left.text, right);
  }
  // with httpx.Client() as client: / async with aiohttp.ClientSession() as session:
  for (const item of root.descendantsOfType("as_pattern")) {
    const value = item?.namedChildren[0];
    const alias = item?.childForFieldName("alias")?.namedChildren[0] ?? item?.namedChildren.at(-1);
    if (value && alias && alias.type === "identifier") visit(alias.text, value);
  }
}

// ---------------------------------------------------------------------------
// Calls

function httpCall(ctx: FileContext, call: Node): CallSite | undefined {
  const fn = call.childForFieldName("function");
  const chain = fn ? chainOf(fn) : undefined;
  if (!chain || chain.names.length === 0) {
    // from requests import get; get(url)
    return undefined;
  }
  const binding = ctx.names.get(chain.root) ?? ctx.names.get(chain.prefix(chain.names.length - 1));
  const member = chain.names.at(-1)!;
  if (!binding || (binding.kind !== "http-module" && binding.kind !== "http-client")) return undefined;
  if (binding.kind === "http-module" && chain.names.length !== 1) return undefined;
  const args = call.childForFieldName("arguments");
  const positional = (args?.namedChildren ?? []).filter((a) => a && a.type !== "keyword_argument") as Node[];

  let method: HttpMethod | null;
  let urlNode: Node | undefined;
  if (VERBS.has(member)) {
    method = member.toUpperCase() as HttpMethod;
    urlNode = positional[0] ?? keyword(args, "url");
  } else if (member === "request") {
    const m = evalString(ctx, positional[0] ?? keyword(args, "method"))?.toUpperCase();
    method = m && (HTTP_METHODS as readonly string[]).includes(m) ? (m as HttpMethod) : null;
    urlNode = positional[1] ?? keyword(args, "url");
  } else return undefined;

  const base = binding.kind === "http-client" ? binding.baseUrl : undefined;
  const { host, path, query } = parseUrl(joinUrl(base, evalString(ctx, urlNode)));
  const surface = emptySurface();
  surface.headers = [...(binding.kind === "http-client" ? binding.headers : []), ...dictEntries(ctx, keyword(args, "headers"))].map((h) => ({ ...h, name: h.name.toLowerCase() }));
  surface.query = [...query, ...dictEntries(ctx, keyword(args, "params"))];
  const provider = host ? (providerForHost(host)?.id ?? null) : null;
  return { file: "", line: 0, column: 0, provider, kind: "http", client: binding.lib, method, host, endpoint: path, resolved: Boolean(provider && path && method), surface };
}

function sdkCall(ctx: FileContext, call: Node): CallSite | undefined {
  const fn = call.childForFieldName("function");
  const chain = fn ? chainOf(fn) : undefined;
  if (!chain || chain.names.length === 0) return undefined;
  const binding = ctx.names.get(chain.root);
  if (!binding || (binding.kind !== "sdk-module" && binding.kind !== "sdk-client")) return undefined;
  const names = binding.kind === "sdk-module" ? [...modulePath(binding), ...chain.names] : chain.names;
  const ep = sdkEndpoint(binding.provider, names);
  // On the module itself only known API methods count: stripe.StripeClient(...) is not a call to the API.
  // On a client, one unknown word (client.close()) is not one either.
  if (!ep && (binding.kind === "sdk-module" || names.length < 2)) return undefined;
  const surface = emptySurface();
  const host = binding.provider.hosts.find((h) => !h.startsWith("*.")) ?? null;
  return {
    file: "",
    line: 0,
    column: 0,
    provider: binding.provider.id,
    kind: "sdk",
    client: binding.module.split(".")[0]!,
    operation: names.join("."),
    method: ep?.method ?? null,
    host,
    endpoint: ep?.path ?? null,
    resolved: Boolean(ep),
    surface,
  };
}

/** `from stripe import checkout` binds `checkout` to "stripe.checkout": its path below the package. */
function modulePath(b: { module: string }): string[] {
  return b.module.split(".").slice(1);
}

function sdkEndpoint(provider: Provider, names: string[]): { method: HttpMethod; path: string } | undefined {
  let op = names.join(".");
  if (provider.id === "stripe") op = op.replace(/^v1\./, "");
  if (provider.id === "slack") {
    // WebClient methods mirror the Web API: chat_postMessage → POST /api/chat.postMessage
    const last = names.at(-1);
    if (names.length !== 1 || !last || !/^[a-z]+(_[a-zA-Z0-9]+)+$/.test(last)) return undefined;
    if (last === "files_upload_v2") return { method: "POST", path: "/api/files.completeUploadExternal" };
    return { method: "POST", path: `/api/${last.replace(/_/g, ".")}` };
  }
  const ref = getProvider(provider.id)?.python?.methods?.[op];
  if (!ref) return undefined;
  const [method, path] = ref.split(" ") as [HttpMethod, string];
  return { method, path };
}

// ---------------------------------------------------------------------------
// Response surface

type Space = "response" | "body";
interface Loc {
  space: Space;
  path: string[];
}
const NOT_FIELDS = new Set([
  "keys", "values", "items", "append", "extend", "lower", "upper", "strip", "split", "startswith", "endswith",
  "replace", "format", "encode", "decode", "count", "index", "copy", "pop", "update", "sort",
]);
/** Methods that return the same data in another form: the fields under them are the same fields. */
const SAME_DATA = new Set(["to_dict", "to_dict_recursive", "model_dump", "dict"]);
const MAX_DEPTH = 4;

class Collector {
  fields = new Set<string>();
  statusCodes = new Set<number>();
  checksOk = false;
  enums = new Map<string, Set<string>>();
  responseHeaders = new Set<string>();
}

function addResponseSurface(call: Node, site: CallSite): void {
  const c = new Collector();
  const envelope = site.kind === "sdk" ? "body" : "response";
  bindFrom(call, { space: envelope, path: [] }, site.client, c, 0);
  const s = site.surface;
  s.fields = [...c.fields].sort();
  s.statusCodes = [...c.statusCodes].sort((a, b) => a - b);
  s.checksOk = c.checksOk;
  s.enums = [...c.enums].map(([field, values]) => ({ field, values: [...values].sort() })).sort((a, b) => a.field.localeCompare(b.field));
  s.responseHeaders = [...c.responseHeaders].sort();
}

/** Follow an expression's value to where it is bound or used. */
function bindFrom(expr: Node, loc: Loc, lib: string, c: Collector, depth: number): void {
  if (depth > MAX_DEPTH) return;
  let cur = expr;
  while (cur.parent && (cur.parent.type === "await" || cur.parent.type === "parenthesized_expression")) cur = cur.parent;
  const parent = cur.parent;
  if (!parent) return;
  if (parent.type === "assignment" && parent.childForFieldName("right")?.id === cur.id) {
    const left = parent.childForFieldName("left");
    if (left?.type === "identifier") bindName(left.text, parent, loc, lib, c, depth);
    return;
  }
  // with session.get(url) as resp:
  if (parent.type === "as_pattern" && parent.namedChildren[0]?.id === cur.id) {
    const alias = parent.childForFieldName("alias")?.namedChildren[0] ?? parent.namedChildren.at(-1);
    if (alias?.type === "identifier") bindName(alias.text, parent, loc, lib, c, depth);
    return;
  }
  use(cur, loc, lib, c, depth);
}

function bindName(name: string, decl: Node, loc: Loc, lib: string, c: Collector, depth: number): void {
  for (const ref of referencesOf(name, decl)) use(ref, loc, lib, c, depth);
}

/** Identifiers named `name` after `decl`, in the function (or module) that contains it. */
function referencesOf(name: string, decl: Node): Node[] {
  let scope: Node | null = decl.parent;
  while (scope && scope.type !== "function_definition" && scope.type !== "lambda" && scope.type !== "module") scope = scope.parent;
  if (!scope) return [];
  return scope.descendantsOfType("identifier").filter((id): id is Node => {
    if (!id || id.text !== name || id.startIndex < decl.endIndex) return false;
    const p = id.parent;
    if (p?.type === "attribute" && p.childForFieldName("attribute")?.id === id.id) return false;
    if (p?.type === "keyword_argument" && p.childForFieldName("name")?.id === id.id) return false;
    if (p?.type === "assignment" && p.childForFieldName("left")?.id === id.id) return false;
    return true;
  });
}

/** Climb attribute, subscript and `.get("k")` accesses from a reference, then interpret them. */
function use(ref: Node, loc: Loc, lib: string, c: Collector, depth: number): void {
  const access: string[] = [];
  let cur = ref;
  for (;;) {
    const p = cur.parent;
    if (!p) break;
    if (p.type === "attribute" && p.childForFieldName("object")?.id === cur.id) {
      const name = p.childForFieldName("attribute")?.text ?? "";
      const call = p.parent?.type === "call" && p.parent.childForFieldName("function")?.id === p.id ? p.parent : undefined;
      if (call && name === "get" && (loc.space === "body" || access.length > 0)) {
        // data.get("key") / resp.headers.get("x")
        const key = stringValue(call.childForFieldName("arguments")?.namedChildren[0] ?? undefined);
        if (key === undefined) break;
        access.push(key);
        cur = call;
        continue;
      }
      if (call && SAME_DATA.has(name) && loc.space === "body") {
        cur = call;
        continue;
      }
      access.push(name);
      cur = p;
    } else if (p.type === "subscript" && p.childForFieldName("value")?.id === cur.id) {
      const key = stringValue(p.childForFieldName("subscript") ?? undefined);
      access.push(key ?? "[]");
      cur = p;
    } else if (p.type === "parenthesized_expression" || p.type === "await") {
      cur = p;
    } else break;
  }
  interpret(loc, access, cur, lib, c, depth);
}

function interpret(loc: Loc, access: string[], top: Node, lib: string, c: Collector, depth: number): void {
  const full = [...loc.path, ...access];
  if (loc.space === "body") return body(full, top, lib, c, depth);
  const [first, ...rest] = full;
  if (first === undefined) return;
  const isCall = top.parent?.type === "call" && top.parent.childForFieldName("function")?.id === top.id;
  const statusKey = lib === "aiohttp" ? "status" : "status_code";
  if (first === statusKey && rest.length === 0) {
    for (const n of comparedLiterals(top).nums) c.statusCodes.add(n);
    return;
  }
  if ((first === "ok" && rest.length === 0) || (first === "raise_for_status" && isCall)) {
    c.checksOk = true;
    return;
  }
  if (first === "headers") {
    if (rest[0]) c.responseHeaders.add(rest[0].toLowerCase());
    return;
  }
  // resp.json() / await resp.json()
  if (first === "json" && rest.length === 0 && isCall) bindFrom(top.parent!, { space: "body", path: [] }, lib, c, depth + 1);
}

function body(path: string[], top: Node, lib: string, c: Collector, depth: number): void {
  const cut = path.findIndex((p) => NOT_FIELDS.has(p));
  const fieldPath = cut >= 0 ? path.slice(0, cut) : path;
  if (fieldPath.length === 0) {
    if (path.length === 0 && depth < MAX_DEPTH) iterate(top, { space: "body", path: [] }, lib, c, depth);
    return;
  }
  const field = fieldPath.join(".").replace(/\.\[\]/g, "[]");
  c.fields.add(field);
  if (cut < 0) {
    for (const s of comparedLiterals(top).strs) {
      const set = c.enums.get(field) ?? new Set<string>();
      set.add(s);
      c.enums.set(field, set);
    }
    if (depth < MAX_DEPTH) {
      // results = data["results"]
      const parent = top.parent;
      if (parent?.type === "assignment" && parent.childForFieldName("right")?.id === top.id) {
        const left = parent.childForFieldName("left");
        if (left?.type === "identifier") bindName(left.text, parent, { space: "body", path: fieldPath }, lib, c, depth + 1);
      }
      iterate(top, { space: "body", path: fieldPath }, lib, c, depth);
    }
  }
}

/** `for item in <top>:` and `[… for item in <top>]`: the loop variable is an item of the list at `loc`. */
function iterate(top: Node, loc: Loc, lib: string, c: Collector, depth: number): void {
  const p = top.parent;
  const items: Loc = { space: "body", path: [...loc.path, "[]"] };
  if (p?.type === "for_statement" && p.childForFieldName("right")?.id === top.id) {
    const left = p.childForFieldName("left");
    if (left?.type === "identifier") bindName(left.text, left, items, lib, c, depth + 1);
  } else if (p?.type === "for_in_clause" && p.childForFieldName("right")?.id === top.id) {
    const left = p.childForFieldName("left");
    const comp = p.parent;
    if (left?.type === "identifier" && comp) {
      for (const id of comp.descendantsOfType("identifier")) {
        if (id && id.text === left.text && id.id !== left.id) use(id, items, lib, c, depth + 1);
      }
    }
  }
}

/** Literals an expression is compared to: ==, !=, `in (a, b)`, `not in [...]`. */
function comparedLiterals(node: Node): { nums: number[]; strs: string[] } {
  const nums: number[] = [];
  const strs: string[] = [];
  let cur = node;
  while (cur.parent?.type === "parenthesized_expression") cur = cur.parent;
  const p = cur.parent;
  if (p?.type !== "comparison_operator") return { nums, strs };
  const take = (n: Node | null | undefined) => {
    if (!n) return;
    if (n.type === "integer") nums.push(Number(n.text));
    else if (n.type === "string") {
      const v = stringValue(n);
      if (v !== undefined) strs.push(v);
    } else if (n.type === "tuple" || n.type === "list" || n.type === "set") n.namedChildren.forEach(take);
  };
  for (const operand of p.namedChildren) if (operand && operand.id !== cur.id) take(operand);
  return { nums, strs };
}

// ---------------------------------------------------------------------------
// Expressions

interface Chain {
  root: string;
  names: string[];
  /** The dotted name of the root and the first `n` names: "self.http". */
  prefix(n: number): string;
}

/** `a.b.c` → root "a", names ["b", "c"]; calls in the middle (`hubspot.Client.create(...).crm`) end the chain. */
function chainOf(node: Node): Chain | undefined {
  const names: string[] = [];
  let cur = node;
  while (cur.type === "attribute") {
    names.unshift(cur.childForFieldName("attribute")!.text);
    cur = cur.childForFieldName("object")!;
  }
  if (cur.type !== "identifier") return undefined;
  const root = cur.text;
  return { root, names, prefix: (n) => [root, ...names.slice(0, n)].join(".") };
}

function unwrap(n: Node): Node {
  let cur = n;
  while (cur.type === "await" || cur.type === "parenthesized_expression") cur = cur.namedChildren[0] ?? cur;
  return cur;
}

function keyword(args: Node | null | undefined, name: string): Node | undefined {
  for (const a of args?.namedChildren ?? []) {
    if (a?.type === "keyword_argument" && a.childForFieldName("name")?.text === name) return a.childForFieldName("value") ?? undefined;
  }
  return undefined;
}

/** The literal value of a plain string (no interpolation), or undefined. */
function stringValue(n: Node | undefined): string | undefined {
  if (!n || n.type !== "string") return undefined;
  if (n.namedChildren.some((c) => c?.type === "interpolation")) return undefined;
  return n.namedChildren.filter((c) => c?.type === "string_content" || c?.type === "escape_sequence").map((c) => c!.text).join("");
}

/** A string expression's value, with unknown parts as {name}: literals, f-strings, `+`, constants, os.getenv defaults. */
function evalString(ctx: FileContext, node: Node | undefined, depth = 0): string | undefined {
  if (!node || depth > 8) return undefined;
  const n = unwrap(node);
  if (n.type === "string") {
    let out = "";
    for (const part of n.namedChildren) {
      if (!part) continue;
      if (part.type === "string_content" || part.type === "escape_sequence") out += part.text;
      else if (part.type === "interpolation") {
        const inner = part.childForFieldName("expression") ?? part.namedChildren[0];
        out += (inner && evalString(ctx, inner, depth + 1)) ?? placeholder(inner ?? undefined);
      }
    }
    return out;
  }
  if (n.type === "concatenated_string") return n.namedChildren.map((s) => evalString(ctx, s ?? undefined, depth + 1) ?? "").join("");
  if (n.type === "binary_operator" && n.childForFieldName("operator")?.text === "+") {
    const l = evalString(ctx, n.childForFieldName("left") ?? undefined, depth + 1);
    const r = evalString(ctx, n.childForFieldName("right") ?? undefined, depth + 1);
    if (l === undefined && r === undefined) return undefined;
    return (l ?? placeholder(n.childForFieldName("left") ?? undefined)) + (r ?? placeholder(n.childForFieldName("right") ?? undefined));
  }
  if (n.type === "identifier") {
    const init = ctx.consts.get(n.text);
    return init && init.id !== node.id ? evalString(ctx, init, depth + 1) : undefined;
  }
  // os.getenv("API_URL", "https://...") / os.environ.get("X", "https://...")
  if (n.type === "call") {
    const fn = n.childForFieldName("function")?.text;
    const args = (n.childForFieldName("arguments")?.namedChildren ?? []).filter(Boolean) as Node[];
    if ((fn === "os.getenv" || fn === "getenv" || fn === "os.environ.get") && args[1]) return evalString(ctx, args[1], depth + 1);
  }
  return undefined;
}

function placeholder(n: Node | undefined): string {
  if (!n) return "{}";
  const e = unwrap(n);
  if (e.type === "identifier") return `{${e.text}}`;
  if (e.type === "attribute") return `{${e.childForFieldName("attribute")?.text ?? ""}}`;
  // quote(name), str(id)
  const args = e.type === "call" ? (e.childForFieldName("arguments")?.namedChildren ?? []).filter(Boolean) : [];
  if (args.length === 1) return placeholder(args[0]!);
  return "{}";
}

/** A dict literal's string keys and values (non-literal values as null), or a same-file constant dict. */
function dictEntries(ctx: FileContext, node: Node | undefined, depth = 0): NameValue[] {
  if (!node || depth > 3) return [];
  const n = unwrap(node);
  if (n.type === "identifier") {
    const init = ctx.consts.get(n.text);
    return init ? dictEntries(ctx, init, depth + 1) : [];
  }
  if (n.type === "call" && n.childForFieldName("function")?.text === "dict") {
    return (n.childForFieldName("arguments")?.namedChildren ?? [])
      .filter((a): a is Node => a?.type === "keyword_argument")
      .map((a) => ({ name: a.childForFieldName("name")!.text, value: literal(ctx, a.childForFieldName("value") ?? undefined) }));
  }
  if (n.type !== "dictionary") return [];
  const out: NameValue[] = [];
  for (const pair of n.namedChildren) {
    if (pair?.type !== "pair") continue;
    const key = stringValue(pair.childForFieldName("key") ?? undefined);
    if (key !== undefined) out.push({ name: key, value: literal(ctx, pair.childForFieldName("value") ?? undefined) });
  }
  return out;
}

function literal(ctx: FileContext, n: Node | undefined): string | null {
  if (!n) return null;
  if (n.type === "integer" || n.type === "float") return n.text;
  if (n.type === "true" || n.type === "false") return n.text.toLowerCase();
  return evalString(ctx, n) ?? null;
}

function joinUrl(base: string | undefined, url: string | undefined): string | undefined {
  if (url === undefined) return base;
  if (!base || /^[a-z]+:\/\//i.test(url)) return url;
  return base.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
}

function emptySurface(): Surface {
  return { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] };
}
