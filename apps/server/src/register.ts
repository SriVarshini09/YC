import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { appManifest, convertManifestCode } from "@shapi/github-app";

/**
 * Register the SHAPI GitHub App through GitHub's manifest flow, once per environment:
 *
 *   pnpm --filter @shapi/server github:register [--webhook-url URL] [--callback-url URL] [--org ORG] [--name NAME] [--public] [--out DIR]
 *
 * Open the printed local page, confirm on GitHub, and GitHub sends the browser back here with a
 * one-time code. The app's private key and webhook secret are written to .shapi/github-app.env
 * (git-ignored) and never printed. Without --webhook-url a smee.io channel is created for local testing.
 */
const { values } = parseArgs({
  options: {
    "webhook-url": { type: "string" },
    /** The web app's sign-in callback, for example https://app.shapi.dev/auth/github/callback. */
    "callback-url": { type: "string" },
    org: { type: "string" },
    name: { type: "string", default: "SHAPI" },
    homepage: { type: "string", default: "https://shapi.dev" },
    public: { type: "boolean", default: false },
    port: { type: "string", default: "3999" },
    out: { type: "string", default: fileURLToPath(new URL("../../../.shapi", import.meta.url)) },
  },
});

const port = Number(values.port);
const state = randomBytes(16).toString("hex");

async function smeeChannel(): Promise<string> {
  const res = await fetch("https://smee.io/new", { method: "HEAD", redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) throw new Error("could not create a smee.io channel; pass --webhook-url");
  return location;
}

const webhookUrl = values["webhook-url"] ?? (await smeeChannel());
const manifest = appManifest({
  name: values.name,
  url: values.homepage,
  webhookUrl,
  redirectUrl: `http://localhost:${port}/callback`,
  public: values.public,
  callbackUrls: values["callback-url"] ? [values["callback-url"]] : undefined,
  // After installing, GitHub sends people to the web app, which signs them in and opens their dashboard.
  setupUrl: values["callback-url"] ? new URL("/setup", values["callback-url"]).toString() : undefined,
});
const target = values.org
  ? `https://github.com/organizations/${encodeURIComponent(values.org)}/settings/apps/new?state=${state}`
  : `https://github.com/settings/apps/new?state=${state}`;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const page = (body: string) => `<!doctype html><meta charset="utf-8"><title>SHAPI GitHub App</title><body style="font-family:sans-serif;max-width:40rem;margin:3rem auto">${body}</body>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      page(`<h1>Register the SHAPI GitHub App</h1>
<p>This sends the app settings to GitHub. You confirm the name there, and GitHub creates the app${values.org ? ` under <b>${escape(values.org)}</b>` : " under your account"}.</p>
<p>Webhook URL: <code>${escape(webhookUrl)}</code></p>
<form action="${escape(target)}" method="post"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form>`),
    );
    return;
  }
  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.get("state") !== state) {
      res.writeHead(400, { "content-type": "text/plain" }).end("Missing code or wrong state. Start again from the first page.");
      return;
    }
    try {
      const app = await convertManifestCode(code);
      mkdirSync(values.out, { recursive: true });
      const envFile = path.join(values.out, "github-app.env");
      const quote = (s: string) => JSON.stringify(s); // newlines become \n, which the server turns back into a PEM
      writeFileSync(
        envFile,
        [
          `# SHAPI GitHub App "${app.slug}" (${app.html_url}). Secrets: keep this file private.`,
          `SHAPI_GITHUB_APP_ID=${app.id}`,
          `SHAPI_GITHUB_APP_SLUG=${app.slug}`,
          `SHAPI_GITHUB_APP_PRIVATE_KEY=${quote(app.pem)}`,
          `SHAPI_GITHUB_WEBHOOK_SECRET=${quote(app.webhook_secret)}`,
          `SHAPI_GITHUB_CLIENT_ID=${app.client_id}`,
          `SHAPI_GITHUB_CLIENT_SECRET=${quote(app.client_secret)}`,
          `SHAPI_GITHUB_WEBHOOK_URL=${webhookUrl}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const install = `${app.html_url}/installations/new`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page(`<h1>App "${escape(app.slug)}" created</h1><p>Credentials saved on this computer. Next, <a href="${escape(install)}">install it on a repository</a>.</p>`));
      console.log(`Created GitHub App "${app.slug}" (id ${app.id}).`);
      console.log(`Credentials written to ${envFile} (not printed).`);
      console.log(`Install it: ${install}`);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" }).end(`GitHub refused the code: ${String(err)}`);
      console.error(`Registration failed: ${String(err)}`);
      process.exitCode = 1;
    }
    server.close();
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Open http://localhost:${port}/ in your browser to register the app.`);
  console.log(`Webhook URL: ${webhookUrl}`);
});
