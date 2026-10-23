import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { withTenant, type Db } from "@shapi/db";
import { DEFAULT_PR_LIMITS, STOP_LABEL } from "@shapi/github-app";
import {
  SESSION_COOKIE,
  SESSION_HOURS,
  STATE_COOKIE,
  authorizeUrl,
  createSession,
  endSession,
  identify,
  loadSession,
  randomToken,
  sameToken,
  sessionAccounts,
  type OAuthConfig,
  type Session,
} from "./auth";
import { FREE_PRIVATE_REPOS, coverage, requiredQuantity } from "../billing/plan";
import { completeCheckout, portalUrl, setQuantity, startCheckout, type BillingDeps } from "../billing/stripe";
import { SLACK_WEBHOOK, postSlack, slackTestMessage } from "../notify/slack";
import { APPLE_TOUCH_ICON, FAVICON_ICO, FAVICON_SVG } from "./brand";
import { DOCS_URL, STYLES, html, page, shortSha, timeAgo, type Html } from "./html";

export interface WebConfig extends OAuthConfig {
  /** Signs the session cookie. */
  sessionSecret: string;
  /** GitHub App slug, for the install link. */
  appSlug?: string;
}

export interface WebDeps {
  db: Db;
  /** Unset: the pages explain that sign-in is not configured yet. */
  config?: WebConfig;
  fetch?: typeof globalThis.fetch;
  /** Unset: no billing, every repository is covered. */
  billing?: BillingDeps;
}

// form-action also governs where a submitted form may redirect: the billing buttons go on to Stripe.
const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; base-uri 'none'; frame-ancestors 'none'";

const SettingsSchema = z.object({
  csrf: z.string(),
  hourly: z.coerce.number().int().min(1).max(20),
  open: z.coerce.number().int().min(1).max(50),
  failOnAffected: z.literal("on").optional(),
  llmFixes: z.literal("on").optional(),
  /** A new Slack incoming webhook; empty keeps the current one. */
  slack: z.union([z.literal(""), z.string().trim().regex(SLACK_WEBHOOK)]).optional(),
  slackRemove: z.literal("on").optional(),
});

const SLACK_NOTICES: Record<string, string> = {
  sent: "Test message sent to Slack.",
  failed: "Slack did not accept the test message. Check the webhook link and try again.",
  none: "Add a Slack webhook first.",
};

const idParam = z.string().regex(/^\d+$/);

/**
 * The web app: sign in with GitHub, then see each account's repositories, findings, scans and fix
 * PRs, and change its settings. Server-rendered, no client JavaScript. Every data query runs inside
 * withTenant for an account the signed-in user can access on GitHub, so row-level security applies.
 */
export function webRoutes(app: FastifyInstance, deps: WebDeps): void {
  void app.register(async (scope) => {
    await scope.register(cookie, { secret: deps.config?.sessionSecret ?? randomToken() });
    await scope.register(formbody);
    scope.addHook("onSend", async (_req, reply, payload) => {
      if (String(reply.getHeader("content-type") ?? "").startsWith("text/html")) {
        reply.header("content-security-policy", CSP).header("x-frame-options", "DENY").header("referrer-policy", "same-origin").header("x-content-type-options", "nosniff");
      }
      return payload;
    });

    const secure = deps.config?.publicUrl.startsWith("https://") ?? false;
    const send = (reply: FastifyReply, body: string, status = 200) => reply.code(status).type("text/html; charset=utf-8").send(body);
    const sessionOf = async (req: FastifyRequest): Promise<{ session?: Session; token?: string }> => {
      const raw = req.cookies[SESSION_COOKIE];
      const unsigned = raw ? req.unsignCookie(raw) : undefined;
      const token = unsigned?.valid ? (unsigned.value ?? undefined) : undefined;
      return { session: await loadSession(deps.db, token), token };
    };
    /** The signed-in session and the account it may open, or a redirect/404 already sent. */
    const accountFor = async (req: FastifyRequest, reply: FastifyReply) => {
      const { session } = await sessionOf(req);
      if (!session) {
        reply.redirect("/login");
        return undefined;
      }
      const id = idParam.safeParse((req.params as { accountId?: string }).accountId);
      const accounts = await sessionAccounts(deps.db, session);
      const account = id.success ? accounts.find((a) => a.id === id.data) : undefined;
      if (!account) {
        send(reply, page("Not found", html`<h1>Not found</h1><p class="lead">This account does not exist, or your GitHub user cannot access it.</p>`, session), 404);
        return undefined;
      }
      return { session, account };
    };
    const csrfOk = (session: Session, body: unknown) => sameToken((body as { csrf?: string } | undefined)?.csrf, session.csrf);
    const installLink = deps.config?.appSlug ? `https://github.com/apps/${deps.config.appSlug}/installations/new` : undefined;

    scope.get("/static/app.css", async (_req, reply) => reply.type("text/css; charset=utf-8").header("cache-control", "public, max-age=3600").send(STYLES));
    const cached = "public, max-age=86400";
    scope.get("/favicon.svg", async (_req, reply) => reply.type("image/svg+xml").header("cache-control", cached).send(FAVICON_SVG));
    scope.get("/favicon.ico", async (_req, reply) => reply.type("image/x-icon").header("cache-control", cached).send(FAVICON_ICO));
    scope.get("/apple-touch-icon.png", async (_req, reply) => reply.type("image/png").header("cache-control", cached).send(APPLE_TOUCH_ICON));

    scope.get("/", async (req, reply) => {
      const { session } = await sessionOf(req);
      if (!session) {
        return send(
          reply,
          page(
            "Sign in",
            html`<h1>SHAPI</h1>
<p class="lead">Finds code that breaks when a third-party API changes, and opens verified fix pull requests.</p>
${deps.config ? html`<p><a class="button primary" href="/login">Sign in with GitHub</a></p>` : html`<div class="notice">Sign-in is not configured on this server yet.</div>`}
${installLink ? html`<p class="note">New here? <a href="${installLink}">Install the SHAPI GitHub App</a> on your repositories first.</p>` : ""}`,
          ),
        );
      }
      const accounts = await sessionAccounts(deps.db, session);
      const rows = accounts.map(
        (a) => html`<tr><td><a href="/a/${a.id}">${a.login}</a></td><td>${a.type}</td><td>${a.suspended_at ? html`<span class="tag warn">suspended</span>` : html`<span class="tag ok">active</span>`}</td></tr>`,
      );
      return send(
        reply,
        page(
          "Accounts",
          html`<h1>Accounts</h1>
<p class="lead">Where SHAPI is installed and you have access on GitHub.</p>
${accounts.length ? html`<table><thead><tr><th>Account</th><th>Type</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` : html`<div class="notice">SHAPI is not installed on any account you can access${installLink ? html`. <a href="${installLink}">Install it</a>, then sign in again.` : "."}</div>`}
${installLink && accounts.length ? html`<p class="note"><a href="${installLink}">Install on more accounts or repositories</a>, then sign in again to see them.</p>` : ""}`,
          session,
        ),
      );
    });

    scope.get("/login", async (_req, reply) => {
      if (!deps.config) return send(reply, page("Sign in", html`<h1>Sign-in is not configured</h1>`), 503);
      const state = randomToken();
      reply.setCookie(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure, path: "/auth", maxAge: 600, signed: true });
      return reply.redirect(authorizeUrl(deps.config, state));
    });

    scope.get("/auth/github/callback", async (req, reply) => {
      if (!deps.config) return send(reply, page("Sign in", html`<h1>Sign-in is not configured</h1>`), 503);
      const { code, state } = req.query as { code?: string; state?: string };
      const rawState = req.cookies[STATE_COOKIE];
      const expected = rawState ? req.unsignCookie(rawState) : undefined;
      reply.clearCookie(STATE_COOKIE, { path: "/auth" });
      if (!code || !expected?.valid || !sameToken(state, expected.value ?? undefined)) {
        return send(reply, page("Sign in", html`<h1>Sign-in expired</h1><p class="lead">Please <a href="/login">try again</a>.</p>`), 400);
      }
      let identity;
      try {
        identity = await identify(deps.config, code, { fetch: deps.fetch });
      } catch (err) {
        req.log.warn({ err }, "GitHub sign-in failed");
        return send(reply, page("Sign in", html`<h1>GitHub sign-in failed</h1><p class="lead">Please <a href="/login">try again</a>.</p>`), 502);
      }
      const { token } = await createSession(deps.db, identity);
      reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: SESSION_HOURS * 3600, signed: true });
      return reply.redirect("/");
    });

    scope.post("/logout", async (req, reply) => {
      const { session, token } = await sessionOf(req);
      if (session && csrfOk(session, req.body)) await endSession(deps.db, token);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.redirect("/");
    });

    scope.get("/a/:accountId", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      const { billing: returned, session: checkoutSession } = req.query as { billing?: string; session?: string };
      if (deps.billing && returned === "done" && checkoutSession) {
        await completeCheckout(deps.billing, ctx.account.id, checkoutSession).catch((err) => req.log.warn({ err }, "could not read the checkout session; waiting for the webhook"));
      }
      const data = await withTenant(deps.db, ctx.account.id, async (tx) => {
        const account = await tx.selectFrom("accounts").select(["login", "settings"]).executeTakeFirstOrThrow();
        const repos = await tx.selectFrom("repositories").selectAll().orderBy("full_name").execute();
        const latest = await tx
          .selectFrom("scans")
          .select(["id", "repository_id", "sha", "status", "finished_at", "created_at", "error"])
          .distinctOn("repository_id")
          .orderBy("repository_id")
          .orderBy("created_at", "desc")
          .execute();
        const affected = latest.length
          ? await tx
              .selectFrom("findings")
              .select(["scan_id", (eb) => eb.fn.countAll<string>().as("n")])
              .where("kind", "=", "affected")
              .where("scan_id", "in", latest.map((s) => s.id))
              .groupBy("scan_id")
              .execute()
          : [];
        const openPrs = await tx.selectFrom("fix_prs").select(["repository_id", (eb) => eb.fn.countAll<string>().as("n")]).where("state", "=", "open").groupBy("repository_id").execute();
        const billing = await tx.selectFrom("billing").selectAll().executeTakeFirst();
        return { account, repos, latest, affected, openPrs, billing };
      });
      const settings = data.account.settings as { prLimits?: { hourly?: number; open?: number }; failOnAffected?: boolean; llmFixes?: boolean; slackWebhookUrl?: string };
      const slackNotice = SLACK_NOTICES[(req.query as { slack?: string }).slack ?? ""];
      const limits = { ...DEFAULT_PR_LIMITS, ...(settings.prLimits ?? {}) };
      const covered = coverage(data.repos, data.billing, Boolean(deps.billing));
      const rows = data.repos.map((r) => {
        const scan = data.latest.find((s) => s.repository_id === r.id);
        const affected = Number(data.affected.find((a) => a.scan_id === scan?.id)?.n ?? 0);
        const prs = Number(data.openPrs.find((p) => p.repository_id === r.id)?.n ?? 0);
        const paused = (r.settings as { paused?: boolean; pausedFromWeb?: boolean }).paused || (r.settings as { pausedFromWeb?: boolean }).pausedFromWeb;
        return html`<tr>
<td><a href="/a/${ctx.account.id}/r/${r.id}">${r.full_name}</a>${paused ? html` <span class="tag warn">paused</span>` : ""}${r.enabled ? "" : html` <span class="tag">archived</span>`}${(() => {
          const c = covered.get(r.id);
          return c && !c.covered && r.enabled ? html` <span class="tag warn" title="${c.reason}">not covered by plan</span>` : "";
        })()}</td>
<td>${scan ? html`${statusTag(scan.status)} <span class="mono">${shortSha(scan.sha)}</span> <span class="muted">${timeAgo(scan.finished_at ?? scan.created_at)}</span>` : html`<span class="muted">not scanned yet</span>`}</td>
<td>${affected ? html`<span class="tag bad">${affected} affected</span>` : scan?.status === "succeeded" ? html`<span class="tag ok">none</span>` : ""}</td>
<td>${prs || ""}</td>
</tr>`;
      });
      return send(
        reply,
        page(
          data.account.login,
          html`<p class="note"><a href="/">Accounts</a></p>
<h1>${data.account.login}</h1>
<p class="lead">${data.repos.length} repositor${data.repos.length === 1 ? "y" : "ies"}. SHAPI scans each push to the default branch.</p>
<table><thead><tr><th>Repository</th><th>Last scan</th><th>Affected call sites</th><th>Open SHAPI PRs</th></tr></thead><tbody>${rows}</tbody></table>
${planSection(ctx.account.id, ctx.session.csrf, data.repos, data.billing, Boolean(deps.billing), (req.query as { billing?: string }).billing)}
<h2>Settings</h2>
<form class="settings card" method="post" action="/a/${ctx.account.id}/settings">
<input type="hidden" name="csrf" value="${ctx.session.csrf}">
<label>New fix PRs per hour, per repository <input type="number" name="hourly" min="1" max="20" value="${limits.hourly}"></label>
<label>Open SHAPI PRs at once, per repository <input type="number" name="open" min="1" max="50" value="${limits.open}"></label>
<label class="check"><input type="checkbox" name="failOnAffected" ${settings.failOnAffected ? "checked" : ""}> <span>Fail the SHAPI check when a call site is affected <span class="note">(it is neutral by default, so it never blocks a merge)</span></span></label>
<label class="check"><input type="checkbox" name="llmFixes" ${settings.llmFixes ? "checked" : ""}> <span>Use Claude when no deterministic recipe fits <span class="note">(sends the affected file and its contract test to Anthropic; the change is kept only if the test passes in the sandbox)</span></span></label>
<label>Slack alerts for new affected call sites <span class="note">${
            settings.slackWebhookUrl ? html`(connected: webhook ending in <span class="mono">${settings.slackWebhookUrl.slice(-6)}</span>; paste a new one to replace it)` : html`(paste an <a href="https://api.slack.com/messaging/webhooks">incoming webhook</a> link, https://hooks.slack.com/services/…)`
          }</span> <input type="url" name="slack" placeholder="https://hooks.slack.com/services/…" autocomplete="off"></label>
${settings.slackWebhookUrl ? html`<label class="check"><input type="checkbox" name="slackRemove"> <span>Stop Slack alerts</span></label>` : ""}
<p><button class="primary" type="submit">Save settings</button></p>
</form>
${slackNotice ? html`<p class="notice">${slackNotice}</p>` : ""}
${
  settings.slackWebhookUrl
    ? html`<form method="post" action="/a/${ctx.account.id}/slack/test" class="inline"><input type="hidden" name="csrf" value="${ctx.session.csrf}"><button type="submit">Send a test message to Slack</button></form>`
    : ""
}
<p class="note">Add the <span class="mono">${STOP_LABEL}</span> label to a SHAPI PR to stop updates to it.</p>`,
          ctx.session,
        ),
      );
    });

    scope.post("/a/:accountId/settings", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      if (!csrfOk(ctx.session, req.body)) return send(reply, page("Error", html`<h1>Form expired</h1><p class="lead">Go back and try again.</p>`, ctx.session), 403);
      const parsed = SettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return send(reply, page("Error", html`<h1>Invalid settings</h1><p class="lead">PRs per hour: 1 to 20. Open PRs: 1 to 50. A Slack webhook starts with https://hooks.slack.com/services/.</p>`, ctx.session), 400);
      }
      const s = parsed.data;
      await withTenant(deps.db, ctx.account.id, async (tx) => {
        const current = await tx.selectFrom("accounts").select("settings").where("id", "=", ctx.account.id).executeTakeFirstOrThrow();
        const next: Record<string, unknown> = { ...current.settings, prLimits: { hourly: s.hourly, open: s.open }, failOnAffected: s.failOnAffected === "on", llmFixes: s.llmFixes === "on" };
        if (s.slackRemove === "on") delete next.slackWebhookUrl;
        else if (s.slack) next.slackWebhookUrl = s.slack;
        await tx.updateTable("accounts").set({ settings: JSON.stringify(next) }).where("id", "=", ctx.account.id).execute();
      });
      return reply.redirect(`/a/${ctx.account.id}`, 303);
    });

    scope.post("/a/:accountId/slack/test", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      if (!csrfOk(ctx.session, req.body)) return send(reply, page("Error", html`<h1>Form expired</h1><p class="lead">Go back and try again.</p>`, ctx.session), 403);
      const account = await withTenant(deps.db, ctx.account.id, (tx) => tx.selectFrom("accounts").select(["login", "settings"]).where("id", "=", ctx.account.id).executeTakeFirstOrThrow());
      const webhook = (account.settings as { slackWebhookUrl?: string }).slackWebhookUrl;
      if (!webhook || !SLACK_WEBHOOK.test(webhook)) return reply.redirect(`/a/${ctx.account.id}?slack=none`, 303);
      const sent = await postSlack(deps.fetch ?? globalThis.fetch, webhook, slackTestMessage(account.login, deps.config?.publicUrl ?? ""))
        .then(() => true)
        .catch(() => false);
      return reply.redirect(`/a/${ctx.account.id}?slack=${sent ? "sent" : "failed"}`, 303);
    });

    const billingAction = (path: string, run: (billing: BillingDeps, account: { id: string; login: string }) => Promise<string>) =>
      scope.post(`/a/:accountId/billing/${path}`, async (req, reply) => {
        const ctx = await accountFor(req, reply);
        if (!ctx) return;
        if (!csrfOk(ctx.session, req.body)) return send(reply, page("Error", html`<h1>Form expired</h1><p class="lead">Go back and try again.</p>`, ctx.session), 403);
        if (!deps.billing) return send(reply, page("Billing", html`<h1>Billing is not configured</h1>`, ctx.session), 503);
        try {
          return reply.redirect(await run(deps.billing, ctx.account), 303);
        } catch (err) {
          req.log.error({ err }, "billing action failed");
          return send(reply, page("Billing", html`<h1>Billing is unavailable</h1><p class="lead">Stripe could not be reached. Nothing was charged. Please try again.</p>`, ctx.session), 502);
        }
      });
    billingAction("checkout", (billing, account) => startCheckout(billing, account));
    billingAction("portal", (billing, account) => portalUrl(billing, account));
    // Raising the paid quantity is always an explicit click; it is prorated by Stripe.
    billingAction("add-repos", async (billing, account) => {
      const repos = await withTenant(deps.db, account.id, (tx) => tx.selectFrom("repositories").select(["id", "private", "enabled", "created_at"]).execute());
      await setQuantity(billing, account.id, Math.max(1, requiredQuantity(repos)));
      return `/a/${account.id}?billing=updated`;
    });

    scope.get("/a/:accountId/r/:repoId", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      const repoId = idParam.safeParse((req.params as { repoId?: string }).repoId);
      const data = repoId.success
        ? await withTenant(deps.db, ctx.account.id, async (tx) => {
            const repo = await tx.selectFrom("repositories").selectAll().where("id", "=", repoId.data).executeTakeFirst();
            if (!repo) return undefined;
            const scans = await tx.selectFrom("scans").select(["id", "sha", "status", "error", "created_at", "finished_at"]).where("repository_id", "=", repo.id).orderBy("created_at", "desc").limit(10).execute();
            const lastGood = scans.find((s) => s.status === "succeeded");
            const findings = lastGood
              ? await tx
                  .selectFrom("findings")
                  .leftJoin("advisories", "advisories.id", "findings.advisory_id")
                  .select(["findings.kind", "findings.call_site", "findings.reasons", "findings.advisory_id", "advisories.data as advisory"])
                  .where("findings.scan_id", "=", lastGood.id)
                  .orderBy("findings.kind")
                  .execute()
              : [];
            const prs = await tx.selectFrom("fix_prs").selectAll().where("repository_id", "=", repo.id).orderBy("updated_at", "desc").execute();
            return { repo, scans, lastGood, findings, prs };
          })
        : undefined;
      if (!data) return send(reply, page("Not found", html`<h1>Not found</h1>`, ctx.session), 404);
      const { repo } = data;
      const repoSettings = repo.settings as { paused?: boolean; pausedFromWeb?: boolean };
      const findingRows = data.findings.map((f) => {
        const site = f.call_site as { file: string; line: number; method?: string; endpoint?: string };
        const adv = f.advisory as { title?: string; effectiveDate?: string; severity?: string } | null;
        return html`<tr><td>${f.kind === "affected" ? html`<span class="tag bad">affected</span>` : html`<span class="tag">exposed</span>`}</td>
<td>${adv?.title ?? f.advisory_id}<div class="note mono">${f.advisory_id}</div></td>
<td class="mono"><a href="https://github.com/${repo.full_name}/blob/${data.lastGood!.sha}/${site.file}#L${site.line}">${site.file}:${site.line}</a></td>
<td class="note">${(f.reasons as string[]).join("; ")}</td></tr>`;
      });
      const prRows = data.prs.map(
        (p) => html`<tr><td>${p.url ? html`<a href="${p.url}">#${p.number}</a>` : "—"}</td><td>${p.advisory_id}</td><td>${statusTag(p.state)}${p.stopped ? html` <span class="tag warn">stopped</span>` : ""}</td><td class="muted">${timeAgo(p.updated_at)}</td></tr>`,
      );
      const scanRows = data.scans.map(
        (s) => html`<tr><td class="mono"><a href="https://github.com/${repo.full_name}/commit/${s.sha}">${shortSha(s.sha)}</a></td><td>${statusTag(s.status)}</td><td class="muted">${timeAgo(s.finished_at ?? s.created_at)}</td><td class="note">${s.error ?? ""}</td></tr>`,
      );
      const body: Html = html`<p class="note"><a href="/">Accounts</a> / <a href="/a/${ctx.account.id}">${ctx.account.login}</a></p>
<h1>${repo.full_name}</h1>
<p class="lead">Default branch <span class="mono">${repo.default_branch}</span>${repo.dashboard_issue ? html` · <a href="https://github.com/${repo.full_name}/issues/${repo.dashboard_issue}">SHAPI Dashboard issue</a>` : ""}</p>
<form method="post" action="/a/${ctx.account.id}/r/${repo.id}/pause">
<input type="hidden" name="csrf" value="${ctx.session.csrf}">
${repoSettings.pausedFromWeb
  ? html`<span class="tag warn">paused here</span> <button type="submit">Resume SHAPI on this repository</button>`
  : html`<button type="submit">Pause SHAPI on this repository</button> <span class="note">Scans continue; no PRs are opened or updated while paused.</span>`}
${repoSettings.paused ? html` <span class="tag warn">paused from the dashboard issue</span>` : ""}
</form>
<h2>Findings ${data.lastGood ? html`<span class="muted">at <span class="mono">${shortSha(data.lastGood.sha)}</span></span>` : ""}</h2>
${findingRows.length ? html`<table><thead><tr><th>Kind</th><th>API change</th><th>Call site</th><th>Why</th></tr></thead><tbody>${findingRows}</tbody></table>` : html`<p class="muted">${data.lastGood ? "No call sites affected by known API changes." : "No completed scan yet."}</p>`}
<h2>Fix pull requests</h2>
${prRows.length ? html`<table><thead><tr><th>PR</th><th>Advisory</th><th>State</th><th>Updated</th></tr></thead><tbody>${prRows}</tbody></table>` : html`<p class="muted">None yet.</p>`}
<h2>Recent scans</h2>
${scanRows.length ? html`<table><thead><tr><th>Commit</th><th>Status</th><th>When</th><th>Error</th></tr></thead><tbody>${scanRows}</tbody></table>` : html`<p class="muted">None yet.</p>`}`;
      return send(reply, page(repo.full_name, body, ctx.session));
    });

    scope.post("/a/:accountId/r/:repoId/pause", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      if (!csrfOk(ctx.session, req.body)) return send(reply, page("Error", html`<h1>Form expired</h1>`, ctx.session), 403);
      const repoId = idParam.safeParse((req.params as { repoId?: string }).repoId);
      if (!repoId.success) return send(reply, page("Not found", html`<h1>Not found</h1>`, ctx.session), 404);
      const done = await withTenant(deps.db, ctx.account.id, async (tx) => {
        const repo = await tx.selectFrom("repositories").select(["id", "settings"]).where("id", "=", repoId.data).executeTakeFirst();
        if (!repo) return false;
        const current = repo.settings as { pausedFromWeb?: boolean };
        await tx.updateTable("repositories").set({ settings: JSON.stringify({ ...repo.settings, pausedFromWeb: !current.pausedFromWeb }) }).where("id", "=", repo.id).execute();
        return true;
      });
      if (!done) return send(reply, page("Not found", html`<h1>Not found</h1>`, ctx.session), 404);
      return reply.redirect(`/a/${ctx.account.id}/r/${repoId.data}`, 303);
    });
  });
}

/** The account's plan: what is covered, and the one action that fits (upgrade, add repositories, manage). */
function planSection(
  accountId: string,
  csrf: string,
  repos: { id: string; private: boolean; enabled: boolean; created_at: Date }[],
  billing: { status: string; quantity: number; stripe_customer_id: string | null; current_period_end: Date | null; cancel_at: Date | null } | undefined,
  enabled: boolean,
  notice: string | undefined,
): Html {
  if (!enabled) return html``;
  const privates = repos.filter((r) => r.private && r.enabled).length;
  const needed = requiredQuantity(repos);
  const paying = billing && ["active", "trialing", "past_due"].includes(billing.status);
  const paid = paying ? billing.quantity : 0;
  const form = (action: string, label: string, primary = false) =>
    html`<form method="post" action="/a/${accountId}/billing/${action}" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button type="submit" class="${primary ? "primary" : ""}">${label}</button></form>`;
  const notices: Record<string, string> = {
    done: "Thanks. Your plan updates as soon as Stripe confirms the payment.",
    updated: "Your plan now covers every private repository.",
    cancelled: "Checkout was cancelled. Nothing was charged.",
  };
  return html`<h2>Plan</h2>
<div class="card">
${notice && notices[notice] ? html`<p class="notice">${notices[notice]}</p>` : ""}
<p>${paying ? html`<b>Paid plan</b>: ${paid} private repositor${paid === 1 ? "y" : "ies"} plus ${FREE_PRIVATE_REPOS} free` : html`<b>Free plan</b>: public repositories and ${FREE_PRIVATE_REPOS} private repository`}${billing?.status === "past_due" ? html` <span class="tag warn">payment past due</span>` : ""}</p>
<p class="muted">${privates} private repositor${privates === 1 ? "y" : "ies"} installed.${
    paying && billing?.cancel_at
      ? html` <span class="tag warn">Cancels on ${billing.cancel_at.toISOString().slice(0, 10)}</span> After that, only public repositories and ${FREE_PRIVATE_REPOS} private repository are scanned.`
      : paying && billing?.current_period_end
        ? html` Renews ${billing.current_period_end.toISOString().slice(0, 10)}.`
        : ""
  }</p>
<p>
${!paying && needed > 0 ? form("checkout", `Upgrade to cover ${needed} more private repositor${needed === 1 ? "y" : "ies"}`, true) : ""}
${paying && needed > paid ? form("add-repos", `Add ${needed - paid} repositor${needed - paid === 1 ? "y" : "ies"} to the plan`, true) : ""}
${billing?.stripe_customer_id ? form("portal", "Manage billing and invoices") : ""}
</p>
<p class="note">Prices and invoices come from Stripe. Removing private repositories lowers the plan automatically; adding them never raises it without this button.${!paying && needed > 0 ? html` Upgrading means you accept the <a href="${DOCS_URL}/legal/terms">terms of service</a>.` : ""}</p>
</div>`;
}

function statusTag(status: string): Html {
  const cls = status === "succeeded" || status === "merged" ? "ok" : status === "failed" || status === "closed" ? "bad" : status === "open" ? "" : "warn";
  return html`<span class="tag ${cls}">${status}</span>`;
}
