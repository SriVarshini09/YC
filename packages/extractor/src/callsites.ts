import {
  HTTP_METHODS,
  pathUnresolved,
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
import { posix } from "node:path";
import { Node, SyntaxKind, type ArrowFunction, type CallExpression, type FunctionExpression, type SourceFile } from "ts-morph";
import { descendantsOfKind } from "./walk";

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
  /** The instance's options (`headers` apply to every call) and its default query (`params`, `searchParams`). */
  options?: Node;
  params?: Node;
}

interface SdkClient {
  provider: Provider;
  pkg: string;
  options?: Node;
  /** The file that constructs the client, when another file imports it. */
  ctx?: FileContext;
  /** The `client` a Bolt listener receives (a Web API client), not the Bolt App itself. */
  boltListener?: boolean;
}

interface FileContext {
  sf: SourceFile;
  imports: Map<string, ImportRef>;
  consts: Map<string, Node>;
  /** Every const of a name, when functions in the file reuse it (`const api = ...` in each). */
  declared?: Map<string, Node[]>;
  http: Map<string, HttpInstance>;
  sdk: Map<string, SdkClient>;
  /** SDK clients that imported names resolve to in other files, once looked up. */
  importedSdk?: Map<string, SdkClient | undefined>;
}

/**
 * Call sites in one file. SDK clients imported from another file of the same project (`import { openai }
 * from "./lib/openai"`) are followed to the module that constructs them, so the project should hold every
 * source file before this runs.
 */
export function extractFromFile(sf: SourceFile, file: string): FoundCall[] {
  const ctx = contextOf(sf);
  const position = positionsOf(sf);

  const found: FoundCall[] = [];
  for (const call of descendantsOfKind(sf, SyntaxKind.CallExpression)) {
    const hit = matchHttp(ctx, call) ?? matchSdk(ctx, call);
    if (!hit) continue;
    const { line, column } = position(call.getStart());
    hit.site.file = file;
    hit.site.line = line;
    hit.site.column = column;
    found.push(hit);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Per-file symbol tables

const contexts = new WeakMap<SourceFile, FileContext>();

/** A file's symbol table, kept only once it is complete, so a file that fails to build fails on its own turn too. */
function contextOf(sf: SourceFile): FileContext {
  let ctx = contexts.get(sf);
  if (!ctx) {
    ctx = { sf, imports: new Map(), consts: new Map(), http: new Map(), sdk: new Map() };
    collectImports(ctx);
    collectConsts(ctx);
    collectClients(ctx);
    contexts.set(sf, ctx);
  }
  return ctx;
}

/** Another file's symbol table, or undefined when it fails to build: that file is reported as skipped, not the importer. */
function importedContext(sf: SourceFile): FileContext | undefined {
  try {
    return contextOf(sf);
  } catch {
    return undefined;
  }
}

const positions = new WeakMap<SourceFile, (pos: number) => { line: number; column: number }>();

/**
 * 1-based line and column of a position, as `sf.getLineAndColumnAtPos` gives them (lines end at "\n",
 * columns count from the last "\n" or "\r"), without scanning the text from the start for every call.
 */
function positionsOf(sf: SourceFile): (pos: number) => { line: number; column: number } {
  let fn = positions.get(sf);
  if (!fn) {
    const text = sf.getFullText();
    const afterLf: number[] = [];
    const afterCr: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 10) afterLf.push(i + 1);
      else if (ch === 13) afterCr.push(i + 1);
    }
    // how many of the sorted starts are at or before pos
    const count = (starts: number[], pos: number) => {
      let lo = 0;
      let hi = starts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid]! <= pos) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    fn = (pos) => {
      const lf = count(afterLf, pos);
      const cr = count(afterCr, pos);
      const lineStart = Math.max(lf ? afterLf[lf - 1]! : 0, cr ? afterCr[cr - 1]! : 0);
      return { line: lf + 1, column: pos - lineStart + 1 };
    };
    positions.set(sf, fn);
  }
  return fn;
}

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
  // TypeScript: import x = require("m");
  for (const decl of descendantsOfKind(ctx.sf, SyntaxKind.ImportEqualsDeclaration)) {
    const ref = decl.getModuleReference();
    const arg = Node.isExternalModuleReference(ref) ? ref.getExpression() : undefined;
    if (arg && Node.isStringLiteral(arg)) ctx.imports.set(decl.getName(), { module: arg.getLiteralValue(), imported: "default" });
  }
  // CommonJS: const x = require("m"); const { a, b: c } = require("m"); const x = require("m").default;
  for (const decl of descendantsOfKind(ctx.sf, SyntaxKind.VariableDeclaration)) {
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
  // require("m").default: the ES module's default export, which is what `require("m")` means here too
  if (node && Node.isPropertyAccessExpression(node) && node.getName() === "default") node = node.getExpression();
  if (!node || !Node.isCallExpression(node)) return undefined;
  const callee = node.getExpression();
  const arg = node.getArguments()[0];
  if (Node.isIdentifier(callee) && callee.getText() === "require" && arg && Node.isStringLiteral(arg)) {
    return arg.getLiteralValue();
  }
  return undefined;
}

function collectConsts(ctx: FileContext) {
  for (const decl of descendantsOfKind(ctx.sf, SyntaxKind.VariableDeclaration)) {
    const list = decl.getVariableStatement()?.getDeclarationKind();
    const init = decl.getInitializer();
    if (list === "const" && init && Node.isIdentifier(decl.getNameNode())) {
      ctx.consts.set(decl.getName(), init);
      ctx.declared ??= new Map();
      const same = ctx.declared.get(decl.getName());
      if (same) same.push(init);
      else ctx.declared.set(decl.getName(), [init]);
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
        const opts = resolveObject(ctx, args[0]);
        const base = opts ? (evalString(ctx, propertyValue(opts, "baseURL")) ?? evalString(ctx, propertyValue(opts, "prefixUrl"))) : undefined;
        const params = opts ? resolveObject(ctx, propertyValue(opts, lib === "axios" ? "params" : "searchParams")) : undefined;
        ctx.http.set(key, { lib, baseURL: base, options: opts, params });
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

  for (const decl of descendantsOfKind(ctx.sf, SyntaxKind.VariableDeclaration)) {
    if (Node.isIdentifier(decl.getNameNode())) bind(decl.getName(), decl.getInitializer());
  }
  for (const prop of descendantsOfKind(ctx.sf, SyntaxKind.PropertyDeclaration)) {
    bind(`this.${prop.getName()}`, prop.getInitializer());
  }
  for (const bin of descendantsOfKind(ctx.sf, SyntaxKind.BinaryExpression)) {
    if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    const left = bin.getLeft();
    if (Node.isPropertyAccessExpression(left) && left.getExpression().getKind() === SyntaxKind.ThisKeyword) {
      bind(`this.${left.getName()}`, bin.getRight());
    } else if (Node.isIdentifier(left)) {
      bind(left.getText(), bin.getRight());
    }
  }
  // export default new Stripe(key), for files that import it ("default" is never a variable's name)
  for (const exp of ctx.sf.getExportAssignments()) {
    if (!exp.isExportEquals()) bind("default", exp.getExpression());
  }
}

/**
 * The SDK client a file imports from another file of the project: `import { openai } from "./lib/openai"`
 * where lib/openai.ts has `export const openai = new OpenAI()`, through re-exports and `export default`.
 */
function importedClient(ctx: FileContext, name: string, depth = 0): SdkClient | undefined {
  const ref = ctx.imports.get(name);
  if (!ref || !ref.module.startsWith(".") || ref.imported === "*" || depth > 4) return undefined;
  ctx.importedSdk ??= new Map();
  if (ctx.importedSdk.has(name)) return ctx.importedSdk.get(name);
  ctx.importedSdk.set(name, undefined); // an import cycle ends here
  const target = resolveModule(ctx.sf, ref.module);
  const targetCtx = target && importedContext(target);
  const client = targetCtx ? exportedClient(targetCtx, ref.imported, depth + 1) : undefined;
  ctx.importedSdk.set(name, client);
  return client;
}

function exportedClient(ctx: FileContext, exported: string, depth: number): SdkClient | undefined {
  if (depth > 4) return undefined;
  let local: string | undefined;
  if (exported === "default") {
    const exp = ctx.sf.getExportAssignments().find((e) => !e.isExportEquals());
    const expr = exp ? unwrap(exp.getExpression()) : undefined;
    local = expr && Node.isIdentifier(expr) ? expr.getText() : "default";
  } else if (ctx.sf.getVariableStatements().some((s) => s.isExported() && s.getDeclarations().some((d) => d.getName() === exported))) {
    local = exported;
  }
  for (const decl of ctx.sf.getExportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    const named = decl.getNamedExports().find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === exported);
    if (named && spec === undefined) local = named.getName();
    // export { openai as ai } from "./openai" / export * from "./openai"
    const from = named ? named.getName() : decl.isNamespaceExport() && !decl.getNamespaceExport() ? exported : undefined;
    if (from !== undefined && spec?.startsWith(".")) {
      const target = resolveModule(ctx.sf, spec);
      const targetCtx = target && importedContext(target);
      const client = targetCtx ? exportedClient(targetCtx, from, depth + 1) : undefined;
      if (client) return client;
    }
  }
  if (local === undefined) return undefined;
  const own = ctx.sdk.get(local);
  if (own) return { ...own, ctx };
  // import { openai } from "./client"; export { openai };
  return importedClient(ctx, local, depth);
}

const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** The project's source file a relative import names: "./lib/openai", "./lib/openai.js" (for openai.ts), "./lib". */
function resolveModule(from: SourceFile, specifier: string): SourceFile | undefined {
  const project = from.getProject();
  const base = posix.join(posix.dirname(from.getFilePath()), specifier);
  const stem = base.replace(/\.(c|m)?jsx?$/, "");
  const candidates = [base, ...MODULE_EXTENSIONS.map((ext) => stem + ext), ...MODULE_EXTENSIONS.map((ext) => `${base}/index${ext}`)];
  for (const candidate of candidates) {
    const sf = project.getSourceFile(candidate);
    if (sf) return sf;
  }
  return undefined;
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
    // undici has no default export, but `require("undici")` is the module object
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
  }

  // api(path) / this.http(path): an instance called directly
  const self = instanceOf(ctx, callee);
  if (self?.lib === "axios") return axiosStyle(ctx, call, undefined, self);
  if (self) return fetchStyle(ctx, call, self.lib, args[0], args[1], undefined, self);

  // axios.get(url) / got.post(url) / undici.request(url) / api.get(path) / this.http.get(path)
  if (Node.isPropertyAccessExpression(callee)) {
    const target = callee.getExpression();
    const member = callee.getName();
    const lib = httpLibOf(ctx, target);
    const inst = instanceOf(ctx, target);
    const effective = lib ?? inst?.lib;
    if (!effective) return undefined;
    if (effective === "undici") {
      return member === "fetch" || member === "request" ? fetchStyle(ctx, call, "undici", args[0], args[1]) : undefined;
    }
    if (effective === "axios") {
      if (member === "request") return axiosStyle(ctx, call, undefined, inst);
      if (VERBS.has(member)) return axiosStyle(ctx, call, member.toUpperCase() as HttpMethod, inst);
      return undefined;
    }
    if (VERBS.has(member)) {
      return fetchStyle(ctx, call, effective, args[0], args[1], member.toUpperCase() as HttpMethod, inst);
    }
  }
  return undefined;
}

/** The HTTP instance an expression names: `api`, or a class member `this.http`. */
function instanceOf(ctx: FileContext, node: Node): HttpInstance | undefined {
  const chain = chainOf(node);
  return chain && chain.names.length === 0 ? ctx.http.get(chain.root) : undefined;
}

function fetchStyle(
  ctx: FileContext,
  call: CallExpression,
  lib: HttpLib,
  urlArg: Node | undefined,
  optsArg: Node | undefined,
  verb?: HttpMethod,
  inst?: HttpInstance,
): FoundCall {
  const opts = resolveObject(ctx, optsArg);
  let method: HttpMethod | null = verb ?? "GET";
  if (!verb && optsArg) {
    if (opts) method = methodFrom(ctx, propertyValue(opts, "method")) ?? (propertyValue(opts, "method") ? null : "GET");
    else method = null;
  }
  // got and ky take query parameters as `searchParams: { … }`.
  const params = opts && (lib === "got" || lib === "ky") ? resolveObject(ctx, propertyValue(opts, "searchParams")) : undefined;
  // fetch-style bodies are `body: JSON.stringify({ … })`; got and ky also take `json: { … }`.
  const body = opts ? bodyEntries(ctx, (lib === "got" || lib === "ky" ? propertyValue(opts, "json") : undefined) ?? propertyValue(opts, "body")) : [];
  return httpSite(ctx, call, lib, joinUrl(inst?.baseURL, evalString(ctx, urlArg)), method, opts ? optsArg : undefined, params, body, inst);
}

/** axios(config) | axios(url, config) | axios.get(url, config) | axios.post(url, data, config) | axios.request(config) */
function axiosStyle(ctx: FileContext, call: CallExpression, verb: HttpMethod | undefined, inst: HttpInstance | undefined): FoundCall {
  const args = call.getArguments();
  const first = args[0];
  const firstObj = resolveObject(ctx, first);
  if (!verb && firstObj && !isStringish(first)) {
    // config object form
    const url = evalString(ctx, propertyValue(firstObj, "url"));
    const base = evalString(ctx, propertyValue(firstObj, "baseURL")) ?? inst?.baseURL;
    const method = methodFrom(ctx, propertyValue(firstObj, "method")) ?? (propertyValue(firstObj, "method") ? null : "GET");
    const params = resolveObject(ctx, propertyValue(firstObj, "params"));
    return httpSite(ctx, call, "axios", joinUrl(base, url), method, first, params, bodyEntries(ctx, propertyValue(firstObj, "data")), inst);
  }
  const hasBody = verb === "POST" || verb === "PUT" || verb === "PATCH";
  const config = hasBody ? args[2] : args[1];
  const cfg = resolveObject(ctx, config);
  let method: HttpMethod | null = verb ?? "GET";
  if (!verb && cfg) method = methodFrom(ctx, propertyValue(cfg, "method")) ?? "GET";
  const params = cfg ? resolveObject(ctx, propertyValue(cfg, "params")) : undefined;
  const body = bodyEntries(ctx, hasBody ? args[1] : cfg ? propertyValue(cfg, "data") : undefined);
  return httpSite(ctx, call, "axios", joinUrl(inst?.baseURL, evalString(ctx, first)), method, config, params, body, inst);
}

function httpSite(
  ctx: FileContext,
  call: CallExpression,
  lib: HttpLib,
  url: string | undefined,
  method: HttpMethod | null,
  options?: Node,
  params?: Node,
  body: NameValue[] = [],
  inst?: HttpInstance,
): FoundCall {
  const { host, path, query, runtimeHost } = parseUrl(url);
  const surface = emptySurface();
  // the instance's headers and default query apply unless the call sets the same name
  const headers = headersOf(ctx, options);
  const own = [...query, ...objectEntries(ctx, params)];
  surface.headers = [...headersOf(ctx, inst?.options).filter((h) => !headers.some((o) => o.name === h.name)), ...headers];
  surface.query = [...objectEntries(ctx, inst?.params).filter((q) => !own.some((o) => o.name === q.name)), ...own];
  if (body.length) surface.body = body;
  const provider = providerOf(host, path, runtimeHost);
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
      resolved: Boolean(provider && path && method) && !pathUnresolved(path),
      surface,
    },
  };
}

// ---------------------------------------------------------------------------
// SDK calls

function matchSdk(ctx: FileContext, call: CallExpression): FoundCall | undefined {
  const chain = chainOf(call.getExpression(), true);
  if (!chain || chain.names.length === 0) return undefined;
  const client = sdkClientOf(ctx, chain.root, call);
  if (!client) return undefined;

  const operation = chain.names.join(".");
  // stripe.toString(), stripe.customers.valueOf(): Object.prototype's members, not API methods
  if (chain.names[chain.names.length - 1]! in Object.prototype && !tableEndpoint(client, operation)) return undefined;
  // A Bolt App's own methods (app.command, app.event, app.start) register listeners or run the app; app.client is the Web API.
  if (client.pkg === "@slack/bolt" && !client.boltListener && !operation.startsWith("client.")) return undefined;
  // client.messages(sid).fetch() is a call of its own only when the table knows it; in
  // openai.responses.create({ … }).then(…) the API call is the inner one.
  if (operation.includes("()") && !tableEndpoint(client, operation)) return undefined;
  // client.messages(sid) itself, when .fetch() follows
  if (insideResourceCall(ctx, call)) return undefined;
  const args = call.getArguments();
  const options: Node | undefined = operation === "request" ? args[1] : args[0];

  // octokit.request("GET /repos/{owner}/{repo}"); another SDK's request(query) is its GraphQL client
  const route = operation === "request" ? routeOf(evalString(ctx, args[0]), client.provider.id === "github") : undefined;
  const ep = route ?? tableEndpoint(client, operation);
  const method = ep?.method ?? null;
  const endpoint = ep?.path ?? null;

  // A provider with per-tenant hosts (`*.myshopify.com`) serves its SDK's calls from a host only known at runtime.
  const host = client.provider.hosts.some((h) => h.startsWith("*.")) ? null : (client.provider.hosts[0] ?? null);
  const surface = emptySurface();
  const clientCtx = client.ctx ?? ctx;
  surface.headers = [...headersOf(clientCtx, client.options, "defaultHeaders"), ...headersOf(ctx, options)];
  const apiVersion = client.options ? propertyValue(client.options, "apiVersion") : undefined;
  if (apiVersion) surface.headers.push({ name: `${client.provider.id}-version`, value: evalString(clientCtx, apiVersion) ?? null });
  surface.headers.sort((a, b) => a.name.localeCompare(b.name));
  // An SDK method's parameters are the request body: openai.chat.completions.create({ model, … }).
  // Octokit's request(route, params) mixes path, query and body parameters, and a GraphQL client's
  // are variables, so they are left out.
  const body = operation !== "request" && operation !== "graphql" ? bodyEntries(ctx, options) : [];
  if (body.length) surface.body = body;
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

/** The SDK client an expression's root names, in the file or imported from another, or a functional SDK's import. */
function sdkClientOf(ctx: FileContext, root: string, at: Node): SdkClient | undefined {
  const client = boltListenerClient(ctx, root, at) ?? ctx.sdk.get(root) ?? importedClient(ctx, root);
  if (client) return client;
  const ref = ctx.imports.get(root);
  const provider = ref ? providerForPackage(ref.module) : undefined;
  // Functional SDKs used straight off the import (sgMail.send). Constructors and factories are not calls to the API.
  if (!ref || !provider || ref.imported !== "default") return undefined;
  return { provider, pkg: ref.module };
}

/** The endpoint an SDK method chain calls, from its provider's table. Bolt's `app.client` is a Web API client. */
function tableEndpoint(client: SdkClient, operation: string) {
  return sdkEndpoint(client.provider, client.pkg === "@slack/bolt" ? operation.replace(/^client\./, "") : operation);
}

/** Octokit's "GET /repos/{owner}/{repo}" (a bare "/path" is a GET); another SDK's request() only takes the first form as a route. */
function routeOf(route: string | undefined, octokit: boolean): { method: HttpMethod; path: string | null } | undefined {
  if (route === undefined) return undefined;
  const m = /^([A-Z]+)\s+(\S+)$/.exec(route.trim());
  if (m && (HTTP_METHODS as readonly string[]).includes(m[1]!)) return { method: m[1] as HttpMethod, path: parseUrl(m[2]).path };
  if (octokit && route.startsWith("/")) return { method: "GET", path: parseUrl(route).path };
  return undefined;
}

/** True for `client.messages(sid)` in `client.messages(sid).fetch()`, when the table knows the longer chain. */
function insideResourceCall(ctx: FileContext, call: CallExpression): boolean {
  let cur: Node = call;
  for (;;) {
    const p = cur.getParent();
    if (Node.isPropertyAccessExpression(p) && p.getExpression() === cur) cur = p;
    else if (Node.isCallExpression(p) && p.getExpression() === cur && cur !== call) {
      const chain = chainOf(cur, true);
      const client = chain ? sdkClientOf(ctx, chain.root, p) : undefined;
      if (client && tableEndpoint(client, chain!.names.join("."))) return true;
      cur = p;
    } else return false;
  }
}

/** Bolt listener methods whose callback receives `{ client }`, a Web API client. */
const BOLT_LISTENERS = new Set(["message", "event", "command", "action", "shortcut", "view", "options", "function", "use"]);

/** `app.command("/x", async ({ ack, client }) => client.chat.postMessage(…))`: the client a Bolt listener receives. */
function boltListenerClient(ctx: FileContext, name: string, at: Node): SdkClient | undefined {
  for (let fn = enclosingFunction(at); fn; fn = enclosingFunction(fn)) {
    const param = fn.getParameters()[0]?.getNameNode();
    if (param && Node.isIdentifier(param) && param.getText() === name) return undefined;
    const el = param && Node.isObjectBindingPattern(param) ? param.getElements().find((e) => e.getName() === name) : undefined;
    if (!el) continue;
    if ((el.getPropertyNameNode()?.getText() ?? el.getName()) !== "client") return undefined;
    const listen = fn.getParent();
    const chain = Node.isCallExpression(listen) && listen.getArguments().includes(fn) ? chainOf(listen.getExpression()) : undefined;
    if (!chain || chain.names.length !== 1 || !BOLT_LISTENERS.has(chain.names[0]!)) return undefined;
    const app = ctx.sdk.get(chain.root) ?? importedClient(ctx, chain.root);
    return app?.pkg === "@slack/bolt" ? { ...app, boltListener: true } : undefined;
  }
  return undefined;
}

function enclosingFunction(node: Node): ArrowFunction | FunctionExpression | undefined {
  return node.getFirstAncestor((a): a is ArrowFunction | FunctionExpression => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
}

/**
 * `a.b.c` → { root: "a", names: ["b", "c"] }; `this.a.b` → { root: "this.a", names: ["b"] }. With `calls`, a call
 * in the chain keeps empty parentheses: `client.messages(sid).fetch` → { root: "client", names: ["messages()", "fetch"] }.
 */
function chainOf(node: Node, calls = false): { root: string; names: string[] } | undefined {
  const names: string[] = [];
  let cur: Node = node;
  let called = false;
  for (;;) {
    if (Node.isPropertyAccessExpression(cur)) {
      names.unshift(cur.getName() + (called ? "()" : ""));
      called = false;
      const inner: Node = cur.getExpression();
      if (inner.getKind() === SyntaxKind.ThisKeyword) {
        const first = names.shift()!;
        return { root: `this.${first}`, names };
      }
      cur = inner;
    } else if (calls && !called && names.length > 0 && Node.isCallExpression(cur)) {
      called = true;
      cur = cur.getExpression();
    } else break;
  }
  if (!called && Node.isIdentifier(cur)) return { root: cur.getText(), names };
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

/** Top-level fields of a request body: an object literal (or a const holding one), or JSON.stringify of one. */
function bodyEntries(ctx: FileContext, node: Node | undefined): NameValue[] {
  if (!node) return [];
  const expr = unwrap(node);
  if (Node.isCallExpression(expr) && expr.getExpression().getText() === "JSON.stringify") return objectEntries(ctx, resolveObject(ctx, expr.getArguments()[0]));
  return objectEntries(ctx, resolveObject(ctx, node));
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
    return pathPart !== undefined && basePart !== undefined ? resolveUrl(basePart, pathPart) : (pathPart ?? undefined);
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

/**
 * The provider a URL belongs to: by its host; when the host is built at runtime, by its fixed suffix
 * (`{sub}.zendesk.com` is on `*.zendesk.com`) or by a path only one provider serves.
 */
export function providerOf(host: string | null, path: string | null, runtimeHost?: string): string | null {
  if (host) return providerForHost(host)?.id ?? null;
  const bySuffix = runtimeHost ? providerForRuntimeHost(runtimeHost) : undefined;
  if (bySuffix) return bySuffix;
  return path ? (providerForPathTemplate(path)?.id ?? null) : null;
}

/** `{sub}.zendesk.com`, `{dc}.api.mailchimp.com`: the labels after the last runtime part, on a provider's `*.` host. */
function providerForRuntimeHost(runtimeHost: string): string | undefined {
  const suffix = /\}([^{}]*)$/.exec(runtimeHost)?.[1];
  if (!suffix || !/^\.[a-z0-9-]+\.[a-z0-9.-]+$/.test(suffix)) return undefined;
  // "_" never appears in a provider's host list, so only a "*." pattern can match
  return providerForHost(`_${suffix}`)?.id;
}

/** A path signature whose version segment is a runtime value: `/admin/api/{version}/...` is Shopify's. */
function providerForPathTemplate(path: string) {
  return providerForPath(path) ?? (/\{[^}]*\}/.test(path) ? providerForPath(path.replace(/\/\{[^}]*\}(?=\/|$)/g, "/0000-00")) : undefined);
}

/** An absolute URL, or a path that names its provider on its own (`/admin/api/2026-01/...`, `crm-pipelines/v1/...`). */
export function urlParts(value: string): ReturnType<typeof parseUrl> | undefined {
  // {{shop}} (template engines) reads like {shop}
  const v = value.trim().replace(/\{\{\s*([^{}]*?)\s*\}\}/g, "{$1}");
  if (/^(?:https?:)?\/\//i.test(v)) return parseUrl(v);
  // "{HUB}/crm-pipelines/v1/...": a base from elsewhere, then a path that names its provider
  const asPath = "/" + v.replace(/^\{[^}]*\}(?=\/)/, "").replace(/^\/+/, "");
  if (providerForPathTemplate(asPath.split(/[?#]/)[0]!)) return parseUrl(asPath);
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
  const calls = new Set<unknown>(found.map((f) => f.call.compilerNode));
  const inFoundCall = (node: Node) => {
    for (let n = node.compilerNode.parent; n; n = n.parent) if (calls.has(n)) return true;
    return false;
  };
  const candidates: { node: Node; host: string | null; path: string; query: NameValue[]; provider: string }[] = [];
  for (const node of stringNodes(sf)) {
    if (!Node.isStringLiteral(node) && !Node.isNoSubstitutionTemplateLiteral(node) && !Node.isTemplateExpression(node) && !isConcat(node)) continue;
    const parent = node.getParent();
    if (parent && (Node.isTemplateSpan(parent) || isConcat(parent) || Node.isImportDeclaration(parent) || Node.isExportDeclaration(parent))) continue;
    if (parent && Node.isPropertyAssignment(parent) && parent.getNameNode() === node) continue;
    if (inFoundCall(node)) continue;
    const value = evalString(ctx, node);
    const parts = value === undefined ? undefined : urlParts(value);
    if (!parts?.path || parts.path === "/") continue;
    const provider = providerOf(parts.host, parts.path, parts.runtimeHost);
    if (provider) candidates.push({ node, host: parts.host, path: parts.path, query: parts.query, provider });
  }
  // every path in the file, by provider and sorted, to find bases without comparing each pair
  const paths = new Map<string, string[]>();
  const addPath = (provider: string | null, p: string | null) => {
    if (!provider || !p) return;
    const list = paths.get(provider);
    if (list) list.push(p);
    else paths.set(provider, [p]);
  };
  for (const c of candidates) addPath(c.provider, c.path);
  for (const f of found) addPath(f.site.provider, f.site.endpoint);
  for (const list of paths.values()) list.sort();
  const extended = (provider: string, base: string) => {
    const list = paths.get(provider) ?? [];
    const prefix = `${base}/`;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length && list[lo]!.startsWith(prefix);
  };
  const position = positionsOf(sf);
  const sites: CallSite[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.provider} ${c.path}`;
    if (covered.has(key) || seen.has(key)) continue;
    // a base: another URL in the file extends it
    if (extended(c.provider, c.path)) continue;
    seen.add(key);
    const { line, column } = position(c.node.getStart());
    const surface = emptySurface();
    surface.query = c.query;
    sites.push({ file, line, column, provider: c.provider, kind: "http", client: "url", method: null, host: c.host, endpoint: c.path, resolved: true, surface });
  }
  return sites;
}

/** The file's string literals, templates and binary expressions, in document order. */
function stringNodes(sf: SourceFile): Node[] {
  return descendantsOfKind(sf, SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateExpression, SyntaxKind.BinaryExpression);
}

function isConcat(node: Node): boolean {
  return Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken;
}

function joinUrl(base: string | undefined, url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (!base || /^[a-z]+:\/\//i.test(url)) return url;
  return base.replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
}

/**
 * `new URL(ref, base)`: an absolute path replaces the base's path, and a relative one replaces the base's
 * last segment, with "." and ".." resolved. Bases without a scheme and host are joined as before.
 */
function resolveUrl(base: string, ref: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref;
  const b = /^((?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*)([^?#]*)/i.exec(base);
  if (!b) return joinUrl(base, ref)!;
  const origin = b[1]!;
  const basePath = b[2]!;
  if (ref.startsWith("//")) return (/^[a-z][a-z0-9+.-]*:/i.exec(base)?.[0] ?? "") + ref;
  if (ref.startsWith("?") || ref.startsWith("#")) return origin + (basePath || "/") + ref;
  const at = ref.search(/[?#]/);
  const refPath = at < 0 ? ref : ref.slice(0, at);
  const tail = at < 0 ? "" : ref.slice(at);
  const joined = refPath.startsWith("/") ? refPath : basePath.slice(0, basePath.lastIndexOf("/") + 1) + refPath;
  const parts = ("/" + joined.replace(/^\/+/, "")).split("/");
  const out: string[] = [];
  parts.forEach((s, i) => {
    const last = i === parts.length - 1;
    if (s === "." || s === "..") {
      if (s === ".." && out.length > 1) out.pop();
      if (last) out.push("");
    } else out.push(s);
  });
  return origin + out.join("/") + tail;
}

/** Decode a query name or value; a malformed escape stays as written. */
function decodeQuery(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/**
 * Host, path and query of a URL. A host built at runtime (`{sub}.zendesk.com`) is null, and is kept as
 * `runtimeHost` so its fixed suffix can still name the provider. Userinfo and port are not part of the host.
 */
export function parseUrl(url: string | undefined): { host: string | null; path: string | null; query: NameValue[]; runtimeHost?: string } {
  if (url === undefined) return { host: null, path: null, query: [] };
  let host: string | null = null;
  let runtimeHost: string | undefined;
  let rest = url;
  const m = /^(?:[a-z]+:)?\/\/([^/?#]+)(.*)$/i.exec(url);
  if (m) {
    const authority = m[1]!.replace(/^.*@/, "").replace(/:(\d+|\{[^{}]*\})$/, "").toLowerCase();
    // `https://api.github.com${path}`: a known host with the runtime path written straight after it.
    const glued = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\{.*)$/.exec(authority);
    if (glued) {
      host = glued[1]!;
      rest = `/${glued[2]}${m[2] ?? ""}`;
    } else {
      if (authority.includes("{")) runtimeHost = authority;
      else host = authority;
      rest = m[2] || "/";
    }
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
      return { name: decodeQuery(name!), value: value.length ? decodeQuery(value.join("=")) : null };
    });
  return runtimeHost === undefined ? { host, path: path || "/", query } : { host, path: path || "/", query, runtimeHost };
}
