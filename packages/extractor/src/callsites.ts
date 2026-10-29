import {
  HTTP_METHODS,
  providerForHost,
  providerForPackage,
  providerForPath,
  sdkEndpoint,
  type CallSite,
  type HttpMethod,
  type NameValue,
  type Provider,
  type Surface,
} from "@shapi/core";
import { Node, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";

export function emptySurface(): Surface {
  return { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] };
}

/** A call site plus the AST nodes later passes (dependency surface) need. */
export interface FoundCall {
  site: CallSite;
  call: CallExpression;
  /** Request options object (fetch init, axios config, SDK params). */
  options?: Node;
  /** Options passed to the SDK client's constructor, for SDK calls. */
  clientOptions?: Node;
}

type HttpLib = "fetch" | "node-fetch" | "axios" | "got" | "ky" | "undici";

const HTTP_MODULES: Record<string, HttpLib> = {
  "node-fetch": "node-fetch",
  "cross-fetch": "node-fetch",
  "isomorphic-fetch": "node-fetch",
  axios: "axios",
  got: "got",
  ky: "ky",
  undici: "undici",
};

const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

interface ImportRef {
  module: string;
  /** "default", "*", or the imported name. */
  imported: string;
}

interface HttpInstance {
  lib: HttpLib;
  baseURL?: string;
}

interface SdkClient {
  provider: Provider;
  pkg: string;
  options?: Node;
}

interface FileContext {
  sf: SourceFile;
  imports: Map<string, ImportRef>;
  consts: Map<string, Node>;
  /** Every const of a name, when functions in the file reuse it (`const api = ...` in each). */
  declared?: Map<string, Node[]>;
  http: Map<string, HttpInstance>;
  sdk: Map<string, SdkClient>;
}

export function extractFromFile(sf: SourceFile, file: string): FoundCall[] {
  const ctx: FileContext = { sf, imports: new Map(), consts: new Map(), http: new Map(), sdk: new Map() };
  collectImports(ctx);
  collectConsts(ctx);
  collectClients(ctx);

  const found: FoundCall[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const hit = matchHttp(ctx, call) ?? matchSdk(ctx, call);
    if (!hit) continue;
    const { line, column } = sf.getLineAndColumnAtPos(call.getStart());
    hit.site.file = file;
    hit.site.line = line;
    hit.site.column = column;
    found.push(hit);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Per-file symbol tables

function collectImports(ctx: FileContext) {
  for (const decl of ctx.sf.getImportDeclarations()) {
    const module = decl.getModuleSpecifierValue();
    const def = decl.getDefaultImport();
    if (def) ctx.imports.set(def.getText(), { module, imported: "default" });
    const ns = decl.getNamespaceImport();
    if (ns) ctx.imports.set(ns.getText(), { module, imported: "*" });
    for (const named of decl.getNamedImports()) {
      const local = named.getAliasNode()?.getText() ?? named.getName();
      ctx.imports.set(local, { module, imported: named.getName() });
    }
  }
  // CommonJS: const x = require("m"); const { a, b: c } = require("m");
  for (const decl of ctx.sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const module = requiredModule(decl.getInitializer());
    if (!module) continue;
    const name = decl.getNameNode();
    if (Node.isIdentifier(name)) ctx.imports.set(name.getText(), { module, imported: "default" });
    else if (Node.isObjectBindingPattern(name)) {
      for (const el of name.getElements()) {
        const imported = el.getPropertyNameNode()?.getText() ?? el.getName();
        ctx.imports.set(el.getName(), { module, imported });
      }
    }
  }
}

function requiredModule(node: Node | undefined): string | undefined {
  if (!node || !Node.isCallExpression(node)) return undefined;
  const callee = node.getExpression();
  const arg = node.getArguments()[0];
  if (Node.isIdentifier(callee) && callee.getText() === "require" && arg && Node.isStringLiteral(arg)) {
    return arg.getLiteralValue();
  }
  return undefined;
}

function collectConsts(ctx: FileContext) {
  for (const decl of ctx.sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const list = decl.getVariableStatement()?.getDeclarationKind();
    const init = decl.getInitializer();
    if (list === "const" && init && Node.isIdentifier(decl.getNameNode())) {
      ctx.consts.set(decl.getName(), init);
      ctx.declared ??= new Map();
      ctx.declared.set(decl.getName(), [...(ctx.declared.get(decl.getName()) ?? []), init]);
    }
  }
}

/** HTTP instances (axios.create, got.extend, ky.create) and SDK clients (new Octokit(), twilio(), github.getOctokit()). */
function collectClients(ctx: FileContext) {
  const bind = (key: string, init: Node | undefined) => {
    if (!init) return;
    const expr = unwrap(init);
    if (!Node.isNewExpression(expr) && !Node.isCallExpression(expr)) return;
    const callee = expr.getExpression();
    const args = expr.getArguments();

    // axios.create({ baseURL }) / got.extend({ prefixUrl }) / ky.create({ prefixUrl })
    if (Node.isPropertyAccessExpression(callee)) {
      const lib = httpLibOf(ctx, callee.getExpression());
      if (lib && ["create", "extend"].includes(callee.getName())) {
        const opts = args[0];
        const base = Node.isObjectLiteralExpression(opts)
          ? (evalString(ctx, propertyValue(opts, "baseURL")) ?? evalString(ctx, propertyValue(opts, "prefixUrl")))
          : undefined;
        ctx.http.set(key, { lib, baseURL: base });
        return;
      }
    }

    const module = moduleOfCallee(ctx, callee);
    const provider = module ? providerForPackage(module) : undefined;
    if (module && provider) {
      const options = [...args].reverse().find((a) => Node.isObjectLiteralExpression(a));
      ctx.sdk.set(key, { provider, pkg: module, options });
    }
  };

  for (const decl of ctx.sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (Node.isIdentifier(decl.getNameNode())) bind(decl.getName(), decl.getInitializer());
  }
  for (const prop of ctx.sf.getDescendantsOfKind(SyntaxKind.PropertyDeclaration)) {
    bind(`this.${prop.getName()}`, prop.getInitializer());
  }
  for (const bin of ctx.sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    const left = bin.getLeft();
    if (Node.isPropertyAccessExpression(left) && left.getExpression().getKind() === SyntaxKind.ThisKeyword) {
      bind(`this.${left.getName()}`, bin.getRight());
    } else if (Node.isIdentifier(left)) {
      bind(left.getText(), bin.getRight());
    }
  }
}

function moduleOfCallee(ctx: FileContext, callee: Node): string | undefined {
  const root = chainOf(callee)?.root;
  if (root) return ctx.imports.get(root)?.module;
  // require("stripe")(key)
  return requiredModule(callee);
}

function httpLibOf(ctx: FileContext, node: Node): HttpLib | undefined {
  if (!Node.isIdentifier(node)) return undefined;
  const ref = ctx.imports.get(node.getText());
  if (ref) {
    const lib = HTTP_MODULES[ref.module];
    if (lib === "undici") return ref.imported === "*" ? "undici" : undefined;
    return lib && (ref.imported === "default" || ref.imported === "*") ? lib : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// HTTP library calls

function matchHttp(ctx: FileContext, call: CallExpression): FoundCall | undefined {
  const callee = call.getExpression();
  const args = call.getArguments();

  // fetch(url, init) and friends called by bare name
  if (Node.isIdentifier(callee)) {
    const name = callee.getText();
    const ref = ctx.imports.get(name);
    if (!ref && name === "fetch") return fetchStyle(ctx, call, "fetch", args[0], args[1]);
    if (ref) {
      const lib = HTTP_MODULES[ref.module];
      if (lib === "node-fetch") return fetchStyle(ctx, call, lib, args[0], args[1]);
      if (lib === "undici" && ref.imported === "fetch") return fetchStyle(ctx, call, lib, args[0], args[1]);
      if (lib === "undici" && ref.imported === "request") return fetchStyle(ctx, call, lib, args[0], args[1]);
      if (lib === "axios" && ref.imported === "default") return axiosStyle(ctx, call, undefined, undefined);
      if ((lib === "got" || lib === "ky") && ref.imported === "default") return fetchStyle(ctx, call, lib, args[0], args[1]);
    }
    const inst = ctx.http.get(name);
    if (inst?.lib === "axios") return axiosStyle(ctx, call, undefined, inst.baseURL);
    if (inst) return fetchStyle(ctx, call, inst.lib, args[0], args[1], undefined, inst.baseURL);
    return undefined;
  }

  // axios.get(url) / got.post(url) / undici.request(url) / api.get(path)
  if (Node.isPropertyAccessExpression(callee)) {
    const target = callee.getExpression();
    const member = callee.getName();
    const lib = httpLibOf(ctx, target);
    const inst = Node.isIdentifier(target) ? ctx.http.get(target.getText()) : undefined;
    const effective = lib ?? inst?.lib;
    if (!effective) return undefined;
    const base = inst?.baseURL;
    if (effective === "undici") {
      return member === "fetch" || member === "request" ? fetchStyle(ctx, call, "undici", args[0], args[1]) : undefined;
    }
    if (effective === "axios") {
      if (member === "request") return axiosStyle(ctx, call, undefined, base);
      if (VERBS.has(member)) return axiosStyle(ctx, call, member.toUpperCase() as HttpMethod, base);
      return undefined;
    }
    if (VERBS.has(member)) {
      return fetchStyle(ctx, call, effective, args[0], args[1], member.toUpperCase() as HttpMethod, base);
    }
  }
  return undefined;
}

function fetchStyle(
  ctx: FileContext,
  call: CallExpression,
  lib: HttpLib,
  urlArg: Node | undefined,
  optsArg: Node | undefined,
  verb?: HttpMethod,
  baseURL?: string,
): FoundCall {
  const opts = resolveObject(ctx, optsArg);
  let method: HttpMethod | null = verb ?? "GET";
  if (!verb && optsArg) {
    if (opts) method = methodFrom(ctx, propertyValue(opts, "method")) ?? (propertyValue(opts, "method") ? null : "GET");
    else method = null;
  }
  // got and ky take query parameters as `searchParams: { … }`.
  const params = opts && (lib === "got" || lib === "ky") ? resolveObject(ctx, propertyValue(opts, "searchParams")) : undefined;
  return httpSite(ctx, call, lib, joinUrl(baseURL, evalString(ctx, urlArg)), method, opts ? optsArg : undefined, params);
}

/** axios(config) | axios(url, config) | axios.get(url, config) | axios.post(url, data, config) | axios.request(config) */
function axiosStyle(ctx: FileContext, call: CallExpression, verb: HttpMethod | undefined, baseURL: string | undefined): FoundCall {
  const args = call.getArguments();
  const first = args[0];
  const firstObj = resolveObject(ctx, first);
  if (!verb && firstObj && !isStringish(first)) {
    // config object form
    const url = evalString(ctx, propertyValue(firstObj, "url"));
    const base = evalString(ctx, propertyValue(firstObj, "baseURL")) ?? baseURL;
    const method = methodFrom(ctx, propertyValue(firstObj, "method")) ?? (propertyValue(firstObj, "method") ? null : "GET");
    const params = resolveObject(ctx, propertyValue(firstObj, "params"));
    return httpSite(ctx, call, "axios", joinUrl(base, url), method, first, params);
  }
  const hasBody = verb === "POST" || verb === "PUT" || verb === "PATCH";
  const config = hasBody ? args[2] : args[1];
  const cfg = resolveObject(ctx, config);
  let method: HttpMethod | null = verb ?? "GET";
  if (!verb && cfg) method = methodFrom(ctx, propertyValue(cfg, "method")) ?? "GET";
  const params = cfg ? resolveObject(ctx, propertyValue(cfg, "params")) : undefined;
  return httpSite(ctx, call, "axios", joinUrl(baseURL, evalString(ctx, first)), method, config, params);
}

function httpSite(
  ctx: FileContext,
  call: CallExpression,
  lib: HttpLib,
  url: string | undefined,
  method: HttpMethod | null,
  options?: Node,
  params?: Node,
): FoundCall {
  const { host, path, query } = parseUrl(url);
  const surface = emptySurface();
  surface.headers = headersOf(ctx, options);
  surface.query = [...query, ...objectEntries(ctx, params)];
  const provider = providerOf(host, path);
  return {
    call,
    options,
    site: {
      file: "",
      line: 0,
      column: 0,
      provider,
      kind: "http",
      client: lib,
      method,
      host,
      endpoint: path,
      resolved: Boolean(provider && path && method),
      surface,
    },
  };
}

// ---------------------------------------------------------------------------
// SDK calls

function matchSdk(ctx: FileContext, call: CallExpression): FoundCall | undefined {
  const chain = chainOf(call.getExpression());
  if (!chain || chain.names.length === 0) return undefined;
  let client = ctx.sdk.get(chain.root);
  if (!client) {
    const ref = ctx.imports.get(chain.root);
    const provider = ref ? providerForPackage(ref.module) : undefined;
    // Functional SDKs used straight off the import (sgMail.send). Constructors and factories are not calls to the API.
    if (!ref || !provider || ref.imported !== "default") return undefined;
    client = { provider, pkg: ref.module };
  }

  const operation = chain.names.join(".");
  const args = call.getArguments();
  let method: HttpMethod | null = null;
  let endpoint: string | null = null;
  let options: Node | undefined = args[0];

  const route = operation === "request" ? evalString(ctx, args[0]) : undefined;
  if (route) {
    const m = /^([A-Z]+)\s+(\S+)$/.exec(route.trim());
    if (m && (HTTP_METHODS as readonly string[]).includes(m[1]!)) {
      method = m[1] as HttpMethod;
      endpoint = parseUrl(m[2]).path;
    } else if (route.startsWith("/")) {
      method = "GET";
      endpoint = parseUrl(route).path;
    }
    options = args[1];
  } else if (operation === "graphql") {
    method = "POST";
    endpoint = "/graphql";
  } else {
    const ep = sdkEndpoint(client.provider, operation);
    if (ep) {
      method = ep.method;
      endpoint = ep.path;
    }
  }

  const host = client.provider.hosts.find((h) => !h.startsWith("*.")) ?? null;
  const surface = emptySurface();
  surface.headers = [...headersOf(ctx, client.options, "defaultHeaders"), ...headersOf(ctx, options)];
  const apiVersion = client.options ? propertyValue(client.options, "apiVersion") : undefined;
  if (apiVersion) surface.headers.push({ name: `${client.provider.id}-version`, value: evalString(ctx, apiVersion) ?? null });
  surface.headers.sort((a, b) => a.name.localeCompare(b.name));
  return {
    call,
    options,
    clientOptions: client.options,
    site: {
      file: "",
      line: 0,
      column: 0,
      provider: client.provider.id,
      kind: "sdk",
      client: client.pkg,
      operation,
      method,
      host,
      endpoint,
      resolved: Boolean(method && endpoint),
      surface,
    },
  };
}

/** `a.b.c` → { root: "a", names: ["b", "c"] }; `this.a.b` → { root: "this.a", names: ["b"] }. */
function chainOf(node: Node): { root: string; names: string[] } | undefined {
  const names: string[] = [];
  let cur: Node = node;
  while (Node.isPropertyAccessExpression(cur)) {
    names.unshift(cur.getName());
    const inner: Node = cur.getExpression();
    if (inner.getKind() === SyntaxKind.ThisKeyword) {
      const first = names.shift()!;
      return { root: `this.${first}`, names };
    }
    cur = inner;
  }
  if (Node.isIdentifier(cur)) return { root: cur.getText(), names };
  return undefined;
}

// ---------------------------------------------------------------------------
// Static evaluation helpers

function unwrap(node: Node): Node {
  let cur = node;
  for (;;) {
    if (Node.isAwaitExpression(cur) || Node.isParenthesizedExpression(cur) || Node.isAsExpression(cur) || Node.isNonNullExpression(cur)) {
      cur = cur.getExpression();
    } else if (Node.isSatisfiesExpression(cur)) {
      cur = cur.getExpression();
    } else {
      return cur;
    }
  }
}

export function propertyValue(obj: Node, name: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(obj)) return undefined;
  for (const prop of obj.getProperties()) {
    if (Node.isPropertyAssignment(prop) && propName(prop.getNameNode()) === name) return prop.getInitializer();
    if (Node.isShorthandPropertyAssignment(prop) && prop.getName() === name) return prop.getNameNode();
  }
  return undefined;
}

export function propName(node: Node): string {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
  return node.getText();
}

/** `headers` (or another key) of an options object, as lowercased name/value pairs. */
function headersOf(ctx: FileContext, options: Node | undefined, key = "headers"): NameValue[] {
  const obj = resolveObject(ctx, options);
  return obj ? objectEntries(ctx, resolveObject(ctx, propertyValue(obj, key))).map((h) => ({ ...h, name: h.name.toLowerCase() })) : [];
}

function objectEntries(ctx: FileContext, obj: Node | undefined): NameValue[] {
  if (!obj || !Node.isObjectLiteralExpression(obj)) return [];
  const out: NameValue[] = [];
  for (const prop of obj.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      out.push({ name: propName(prop.getNameNode()), value: evalString(ctx, prop.getInitializer()) ?? null });
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      out.push({ name: prop.getName(), value: evalString(ctx, prop.getNameNode()) ?? null });
    }
  }
  return out;
}

/** The object literal an argument refers to, following one level of same-file const. */
function resolveObject(ctx: FileContext, node: Node | undefined): Node | undefined {
  if (!node) return undefined;
  const expr = unwrap(node);
  if (Node.isObjectLiteralExpression(expr)) return expr;
  if (Node.isIdentifier(expr)) {
    const init = ctx.consts.get(expr.getText());
    if (init && Node.isObjectLiteralExpression(unwrap(init))) return unwrap(init);
  }
  return undefined;
}

function isStringish(node: Node | undefined): boolean {
  if (!node) return false;
  const expr = unwrap(node);
  return Node.isStringLiteral(expr) || Node.isTemplateExpression(expr) || Node.isNoSubstitutionTemplateLiteral(expr);
}

function methodFrom(ctx: FileContext, node: Node | undefined): HttpMethod | undefined {
  const value = evalString(ctx, node)?.toUpperCase();
  return value && (HTTP_METHODS as readonly string[]).includes(value) ? (value as HttpMethod) : undefined;
}

/**
 * Evaluate an expression to a string where possible. Unknown template
 * substitutions become "{name}" (from the identifier or last property) or "{}".
 */
export function evalString(ctx: { consts: Map<string, Node>; declared?: Map<string, Node[]> }, node: Node | undefined, depth = 0): string | undefined {
  if (!node || depth > 8) return undefined;
  const expr = unwrap(node);
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) return expr.getLiteralValue();
  if (Node.isNumericLiteral(expr)) return expr.getLiteralText();
  if (Node.isTemplateExpression(expr)) {
    let out = expr.getHead().getLiteralText();
    for (const span of expr.getTemplateSpans()) {
      const inner = span.getExpression();
      out += evalString(ctx, inner, depth + 1) ?? placeholder(inner);
      out += span.getLiteral().getLiteralText();
    }
    return out;
  }
  if (Node.isBinaryExpression(expr)) {
    const op = expr.getOperatorToken().getKind();
    if (op === SyntaxKind.PlusToken) {
      const l = evalString(ctx, expr.getLeft(), depth + 1);
      const r = evalString(ctx, expr.getRight(), depth + 1);
      if (l === undefined && r === undefined) return undefined;
      return (l ?? placeholder(expr.getLeft())) + (r ?? placeholder(expr.getRight()));
    }
    // process.env.API_URL ?? "https://api.github.com": use the literal fallback
    if (op === SyntaxKind.QuestionQuestionToken || op === SyntaxKind.BarBarToken) {
      return evalString(ctx, expr.getLeft(), depth + 1) ?? evalString(ctx, expr.getRight(), depth + 1);
    }
  }
  if (Node.isIdentifier(expr)) {
    const init = nearestConst(ctx, expr) ?? ctx.consts.get(expr.getText());
    return init && init !== node ? evalString(ctx, init, depth + 1) : undefined;
  }
  // url.toString() / String(url) / url.href: the URL itself
  if (Node.isCallExpression(expr)) {
    const callee = expr.getExpression();
    const args = expr.getArguments();
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === "toString" && args.length === 0) return evalString(ctx, callee.getExpression(), depth + 1);
    if (Node.isIdentifier(callee) && callee.getText() === "String" && args.length === 1) return evalString(ctx, args[0], depth + 1);
  }
  if (Node.isPropertyAccessExpression(expr) && expr.getName() === "href") return evalString(ctx, expr.getExpression(), depth + 1);
  if (Node.isNewExpression(expr) && expr.getExpression().getText() === "URL") {
    const [p, base] = expr.getArguments();
    const pathPart = evalString(ctx, p, depth + 1);
    const basePart = evalString(ctx, base, depth + 1);
    return pathPart !== undefined && basePart !== undefined ? joinUrl(basePart, pathPart) : (pathPart ?? undefined);
  }
  return undefined;
}

/** Of several consts with this name, the one whose block encloses the use most closely. */
function nearestConst(ctx: { declared?: Map<string, Node[]> }, id: Node): Node | undefined {
  const inits = ctx.declared?.get(id.getText());
  if (!inits || inits.length < 2) return undefined;
  let best: { init: Node; size: number } | undefined;
  for (const init of inits) {
    const scope = init.getFirstAncestor((a) => Node.isBlock(a) || Node.isSourceFile(a));
    if (!scope || id.getPos() < scope.getPos() || id.getEnd() > scope.getEnd()) continue;
    const size = scope.getEnd() - scope.getPos();
    if (!best || size < best.size) best = { init, size };
  }
  return best?.init;
}

function placeholder(node: Node): string {
  const expr = unwrap(node);
  if (Node.isIdentifier(expr)) return `{${expr.getText()}}`;
  if (Node.isPropertyAccessExpression(expr)) return `{${expr.getName()}}`;
  // encodeURIComponent(owner), String(id)
  if (Node.isCallExpression(expr) && expr.getArguments().length === 1) return placeholder(expr.getArguments()[0]!);
  return "{}";
}

/** The provider a URL belongs to: by its host, or by a path only one provider serves when the host is built at runtime. */
export function providerOf(host: string | null, path: string | null): string | null {
  if (host) return providerForHost(host)?.id ?? null;
  return path ? (providerForPath(path)?.id ?? null) : null;
}

/** An absolute URL, or a path that names its provider on its own (`/admin/api/2026-01/...`, `crm-pipelines/v1/...`). */
export function urlParts(value: string): { host: string | null; path: string | null; query: NameValue[] } | undefined {
  // {{shop}} (template engines) reads like {shop}
  const v = value.trim().replace(/\{\{\s*([^{}]*?)\s*\}\}/g, "{$1}");
  if (/^(?:https?:)?\/\//i.test(v)) return parseUrl(v);
  // "{HUB}/crm-pipelines/v1/...": a base from elsewhere, then a path that names its provider
  const asPath = "/" + v.replace(/^\{[^}]*\}(?=\/)/, "").replace(/^\/+/, "");
  if (providerForPath(asPath.split(/[?#]/)[0]!)) return parseUrl(asPath);
  return undefined;
}

// ---------------------------------------------------------------------------
// URLs outside the clients above

/**
 * URLs of known APIs that no recognized client sends: a helper (`ctx.fetch`, `apiRequest.call(...)`), a
 * config object (`baseUrl: "https://..."`) or a value returned for a framework to call. Each counts as a
 * call site with an unknown method, unless a recognized call in the file already covers it. A URL that
 * only prefixes another one in the file (a base constant) is not counted on its own.
 */
export function looseUrlSites(sf: SourceFile, file: string, found: FoundCall[]): CallSite[] {
  const ctx: FileContext = { sf, imports: new Map(), consts: new Map(), http: new Map(), sdk: new Map() };
  collectConsts(ctx);
  const covered = new Set(found.map((f) => `${f.site.provider} ${f.site.endpoint}`));
  const inFoundCall = (node: Node) => found.some((f) => node.getPos() >= f.call.getPos() && node.getEnd() <= f.call.getEnd());
  const candidates: { node: Node; host: string | null; path: string; query: NameValue[]; provider: string }[] = [];
  for (const node of sf.getDescendants()) {
    if (!Node.isStringLiteral(node) && !Node.isNoSubstitutionTemplateLiteral(node) && !Node.isTemplateExpression(node) && !isConcat(node)) continue;
    const parent = node.getParent();
    if (parent && (Node.isTemplateSpan(parent) || isConcat(parent) || Node.isImportDeclaration(parent) || Node.isExportDeclaration(parent))) continue;
    if (parent && Node.isPropertyAssignment(parent) && parent.getNameNode() === node) continue;
    if (inFoundCall(node)) continue;
    const value = evalString(ctx, node);
    const parts = value === undefined ? undefined : urlParts(value);
    if (!parts?.path || parts.path === "/") continue;
    const provider = providerOf(parts.host, parts.path);
    if (provider) candidates.push({ node, host: parts.host, path: parts.path, query: parts.query, provider });
  }
  const sites: CallSite[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.provider} ${c.path}`;
    if (covered.has(key) || seen.has(key)) continue;
    // a base: another URL in the file extends it
    if (candidates.some((o) => o.provider === c.provider && o.path !== c.path && o.path.startsWith(`${c.path}/`))) continue;
    if (found.some((f) => f.site.provider === c.provider && f.site.endpoint?.startsWith(`${c.path}/`))) continue;
    seen.add(key);
    const { line, column } = sf.getLineAndColumnAtPos(c.node.getStart());
    const surface = emptySurface();
    surface.query = c.query;
    sites.push({ file, line, column, provider: c.provider, kind: "http", client: "url", method: null, host: c.host, endpoint: c.path, resolved: true, surface });
  }
  return sites;
}

function isConcat(node: Node): boolean {
  return Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken;
}

function joinUrl(base: string | undefined, url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (!base || /^[a-z]+:\/\//i.test(url)) return url;
  return base.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
}

export function parseUrl(url: string | undefined): { host: string | null; path: string | null; query: NameValue[] } {
  if (url === undefined) return { host: null, path: null, query: [] };
  let host: string | null = null;
  let rest = url;
  const m = /^(?:[a-z]+:)?\/\/([^/?#]+)(.*)$/i.exec(url);
  if (m) {
    host = m[1]!.includes("{") ? null : m[1]!.toLowerCase();
    rest = m[2] || "/";
  } else if (!url.startsWith("/")) {
    // "{base}/repos/x": unknown base, keep the path after it
    const slash = url.indexOf("/");
    rest = slash >= 0 ? url.slice(slash) : "/";
    if (slash < 0) return { host: null, path: null, query: [] };
  }
  let path = rest.split(/[?#]/)[0]!.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/$/, "");
  const search = /\?([^#]*)/.exec(rest)?.[1] ?? "";
  const query = search
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const [name, ...value] = pair.split("=");
      return { name: name!, value: value.length ? value.join("=") : null };
    });
  return { host, path: path || "/", query };
}
