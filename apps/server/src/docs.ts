import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface DocsSite {
  /** Public URL of the docs, for example https://shapi.dev. Its host and www. on it are the docs hosts. */
  url: string;
  /** The VitePress build (site/.vitepress/dist). */
  dir: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

// VitePress pages carry two small inline scripts (theme and platform checks) and inline styles; nothing loads
// from another origin. The site has no cookies or forms, so 'unsafe-inline' here costs little.
export const DOCS_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Serve the docs site on its own hostname from this process: requests for the docs host never reach the
 * app's routes, and www. redirects to it. Everything else (the app's host, health checks, webhooks) passes on.
 */
export function docsSite(app: FastifyInstance, docs: DocsSite): void {
  const canonical = new URL(docs.url).hostname.toLowerCase();
  const root = path.resolve(docs.dir);
  app.addHook("onRequest", async (req, reply) => {
    const host = req.hostname.toLowerCase();
    if (host === `www.${canonical}`) return reply.redirect(`https://${canonical}${req.url}`, 301);
    if (host !== canonical) return;
    if (req.method !== "GET" && req.method !== "HEAD") return reply.code(405).header("allow", "GET, HEAD").send();
    return serve(req, reply, root);
  });
}

async function serve(req: FastifyRequest, reply: FastifyReply, root: string): Promise<FastifyReply> {
  const file = await resolveFile(root, req.url);
  const found = file ?? (await existing(path.join(root, "404.html")));
  if (!found) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  const ext = path.extname(found);
  // Hashed build assets never change; pages do with every deploy.
  const immutable = found.startsWith(path.join(root, "assets") + path.sep);
  reply
    .code(file ? 200 : 404)
    .type(TYPES[ext] ?? "application/octet-stream")
    .header("cache-control", immutable ? "public, max-age=31536000, immutable" : "public, max-age=300")
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "strict-origin-when-cross-origin");
  if (ext === ".html") reply.header("content-security-policy", DOCS_CSP).header("x-frame-options", "DENY");
  // Published JSON Schemas (/schema/advisory.json), OSV records (/osv/<id>.json), overlays and Arazzo workflows:
  // editors, validators and vulnerability and API tools load them from any origin.
  if (["schema", "osv", "overlays", "arazzo"].some((d) => found.startsWith(path.join(root, d) + path.sep))) reply.header("access-control-allow-origin", "*");
  return reply.send(await readFile(found));
}

/** The file for a URL path, with VitePress clean URLs (/guide/cli is guide/cli.html), or undefined. Never leaves `root`. */
export async function resolveFile(root: string, url: string): Promise<string | undefined> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url, "http://docs.invalid").pathname);
  } catch {
    return undefined;
  }
  // Split on backslashes too: Windows reads them as separators, so "/a%5c.env" would reach a dot file.
  if (pathname.includes("\0") || pathname.split(/[/\\]/).some((s) => s === ".." || s.startsWith("."))) return undefined;
  const rel = pathname.replace(/^\/+/, "");
  const candidates = rel === "" || rel.endsWith("/") ? [`${rel}index.html`] : [rel, `${rel}.html`, `${rel}/index.html`];
  for (const c of candidates) {
    const full = path.resolve(root, c);
    if (full !== root && !full.startsWith(root + path.sep)) continue;
    const hit = await existing(full);
    if (hit) return hit;
  }
  return undefined;
}

async function existing(file: string): Promise<string | undefined> {
  try {
    return (await stat(file)).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}
