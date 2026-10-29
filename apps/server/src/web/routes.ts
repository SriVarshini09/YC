import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { withService, withTenant, type Db } from "@shapi/db";
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
import { requiredQuantity } from "../billing/plan";
import { completeCheckout, portalUrl, setQuantity, startCheckout, type BillingDeps } from "../billing/stripe";
import { SLACK_WEBHOOK, postSlack, slackTestMessage } from "../notify/slack";
import { APPLE_TOUCH_ICON, FAVICON_ICO, FAVICON_SVG } from "./brand";
import { STYLES, THEMES, page, type Theme } from "./html";
import {
  accountsPage,
  advisoriesPage,
  billingPage,
  findingPage,
  fixesPage,
  messagePage,
  problemsPage,
  repositoriesPage,
  repositoryPage,
  settingsPage,
  shellFor,
  type PageContext,
} from "./pages";
import { landingPage } from "./landing";
import { overviewPage } from "./overview";
import { firstScanPending, loadAccount, loadFinding, withCatchDetail } from "./queries";
import { latestScanId } from "../github/events";

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
  /** Queue a fix job; unset (tests, no queue), an unpaused repository waits for its next scan. */
  enqueueFix?: (scanId: string, repositoryId: string) => Promise<void>;
  /** The worker can ask Claude (ANTHROPIC_API_KEY is set): only then does Settings offer it. */
  llmAvailable?: boolean;
}

// form-action also governs where a submitted form may redirect: the billing buttons go on to Stripe.
export const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; base-uri 'none'; frame-ancestors 'none'";

const THEME_COOKIE = "shapi_theme";

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
/** A same-site path to return to after a form post. */
const backParam = z.string().regex(/^\/(?![/\\])[^\s]*$/);

/** Inter for text and Instrument Serif for headlines, served from this origin so the strict CSP needs no font host. */
const FONT_FILE = createRequire(import.meta.url).resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
const SERIF_FILE = createRequire(import.meta.url).resolve("@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2");
const SERIF_ITALIC_FILE = createRequire(import.meta.url).resolve("@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2");

/**
 * The web app: sign in with GitHub, then see each account's overview, problems, fixes, repositories,
 * API changes, settings and billing. Server-rendered, no client JavaScript. Every data query
 * runs inside withTenant for an account the signed-in user can access on GitHub, so row-level security applies.
 */
export function webRoutes(app: FastifyInstance, deps: WebDeps): void {
  void app.register(async (scope) => {
    await scope.register(cookie, { secret: deps.config?.sessionSecret ?? randomToken() });
    await scope.register(formbody);
    scope.addHook("onSend", async (_req, reply, payload) => {
      // The docs site (docs.ts) sets its own policy on its pages.
      if (String(reply.getHeader("content-type") ?? "").startsWith("text/html") && !reply.hasHeader("content-security-policy")) {
        reply.header("content-security-policy", CSP).header("x-frame-options", "DENY").header("referrer-policy", "same-origin").header("x-content-type-options", "nosniff");
      }
      return payload;
    });

    // Fly's default hostname still reaches the app; send pages to the public URL so the sign-in cookies and GitHub's callback share one host.
    const publicHost = deps.config ? new URL(deps.config.publicUrl).host : undefined;
    scope.addHook("onRequest", async (req, reply) => {
      if (publicHost && req.hostname.endsWith(".fly.dev") && req.host !== publicHost && (req.method === "GET" || req.method === "HEAD")) {
        return reply.redirect(`${deps.config!.publicUrl}${req.url}`, 301);
      }
    });

    const secure = deps.config?.publicUrl.startsWith("https://") ?? false;
    const send = (reply: FastifyReply, body: string, status = 200) => reply.code(status).type("text/html; charset=utf-8").send(body);
    const themeOf = (req: FastifyRequest): Theme => {
      const t = req.cookies[THEME_COOKIE];
      return THEMES.includes(t as Theme) ? (t as Theme) : "auto";
    };
    const sessionOf = async (req: FastifyRequest): Promise<{ session?: Session; token?: string }> => {
      const raw = req.cookies[SESSION_COOKIE];
      const unsigned = raw ? req.unsignCookie(raw) : undefined;
      const token = unsigned?.valid ? (unsigned.value ?? undefined) : undefined;
      return { session: await loadSession(deps.db, token), token };
    };
    const bare = (req: FastifyRequest, session?: Session) => ({ user: session, theme: themeOf(req), bare: true });
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
        send(reply, page("Not found", messagePage("Not found", "This account does not exist, or your GitHub user cannot access it.", { href: "/", label: "Your accounts" }), bare(req, session)), 404);
        return undefined;
      }
      const ctx: PageContext = { user: session, theme: themeOf(req) };
      return { session, account, ctx };
    };
    const csrfOk = (session: Session, body: unknown) => sameToken((body as { csrf?: string } | undefined)?.csrf, session.csrf);
    const installLink = deps.config?.appSlug ? `https://github.com/apps/${deps.config.appSlug}/installations/new` : undefined;
    const notFound = (req: FastifyRequest, reply: FastifyReply, session: Session) => send(reply, page("Not found", messagePage("Not found", "Nothing here."), bare(req, session)), 404);
    const expired = (req: FastifyRequest, reply: FastifyReply, session: Session) => send(reply, page("Error", messagePage("Form expired", "Go back and try again."), bare(req, session)), 403);

    scope.get("/static/app.css", async (_req, reply) => reply.type("text/css; charset=utf-8").header("cache-control", "public, max-age=3600").send(STYLES));
    const cached = "public, max-age=86400";
    scope.get("/favicon.svg", async (_req, reply) => reply.type("image/svg+xml").header("cache-control", cached).send(FAVICON_SVG));
    scope.get("/favicon.ico", async (_req, reply) => reply.type("image/x-icon").header("cache-control", cached).send(FAVICON_ICO));
    scope.get("/apple-touch-icon.png", async (_req, reply) => reply.type("image/png").header("cache-control", cached).send(APPLE_TOUCH_ICON));
    scope.get("/static/inter.woff2", async (_req, reply) => reply.type("font/woff2").header("cache-control", "public, max-age=604800, immutable").send(await readFile(FONT_FILE)));
    scope.get("/static/serif.woff2", async (_req, reply) => reply.type("font/woff2").header("cache-control", "public, max-age=604800, immutable").send(await readFile(SERIF_FILE)));
    scope.get("/static/serif-italic.woff2", async (_req, reply) => reply.type("font/woff2").header("cache-control", "public, max-age=604800, immutable").send(await readFile(SERIF_ITALIC_FILE)));

    scope.get("/", async (req, reply) => {
      const { session } = await sessionOf(req);
      if (!session) {
        const counts = await withService(deps.db, (tx) =>
          tx
            .selectFrom("advisories")
            .select((eb) => [eb.fn.countAll<string>().as("n"), sql<string>`count(*) filter (where data ? 'recipeId' or data ? 'fix')`.as("fixable")])
            .where("reviewed", "=", true)
            .executeTakeFirst(),
        ).catch(() => undefined);
        const advisories = Number(counts?.n ?? 0) || undefined;
        const withFix = Number(counts?.fixable ?? 0) || undefined;
        return send(reply, page("Third-party API changes, caught and fixed", landingPage({ configured: Boolean(deps.config), installLink, advisories, withFix, billingEnabled: Boolean(deps.billing) }), { theme: themeOf(req), landing: true }));
      }
      const accounts = await sessionAccounts(deps.db, session);
      if (accounts.length === 1 && !("all" in (req.query as object))) return reply.redirect(`/a/${accounts[0]!.id}`);
      return send(reply, page("Accounts", accountsPage(accounts, installLink, session), bare(req, session)));
    });

    scope.get("/login", async (req, reply) => {
      if (!deps.config) return send(reply, page("Sign in", messagePage("Sign-in is not configured", "This server has no GitHub OAuth client yet."), bare(req)), 503);
      const state = randomToken();
      reply.setCookie(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure, path: "/auth", maxAge: 600, signed: true });
      return reply.redirect(authorizeUrl(deps.config, state));
    });

    scope.get("/auth/github/callback", async (req, reply) => {
      if (!deps.config) return send(reply, page("Sign in", messagePage("Sign-in is not configured", "This server has no GitHub OAuth client yet."), bare(req)), 503);
      const { code, state } = req.query as { code?: string; state?: string };
      const rawState = req.cookies[STATE_COOKIE];
      const expected = rawState ? req.unsignCookie(rawState) : undefined;
      reply.clearCookie(STATE_COOKIE, { path: "/auth" });
      if (!code || !expected?.valid || !sameToken(state, expected.value ?? undefined)) {
        return send(reply, page("Sign in", messagePage("Sign-in expired", "Please try again.", { href: "/login", label: "Sign in with GitHub" }), bare(req)), 400);
      }
      let identity;
      try {
        identity = await identify(deps.config, code, { fetch: deps.fetch });
      } catch (err) {
        req.log.warn({ err }, "GitHub sign-in failed");
        return send(reply, page("Sign in", messagePage("GitHub sign-in failed", "Please try again.", { href: "/login", label: "Sign in with GitHub" }), bare(req)), 502);
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

    // Light, dark or auto: a cookie the shell reads, so no script is needed to apply it.
    scope.post("/theme", async (req, reply) => {
      const { session } = await sessionOf(req);
      if (!session) return reply.redirect("/login");
      if (!csrfOk(session, req.body)) return expired(req, reply, session);
      const body = req.body as { theme?: string; back?: string };
      const theme = THEMES.includes(body.theme as Theme) ? (body.theme as Theme) : "auto";
      reply.setCookie(THEME_COOKIE, theme, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 365 * 86_400 });
      const back = backParam.safeParse(body.back ?? req.headers.referer?.replace(/^https?:\/\/[^/]+/, ""));
      return reply.redirect(back.success ? back.data : "/", 303);
    });

    const billingEnabled = Boolean(deps.billing);

    scope.get("/a/:accountId", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      // Stripe Checkout sessions started before the billing page moved still return here.
      const { billing: returned, session: checkoutSession } = req.query as { billing?: string; session?: string };
      if (returned) {
        const query = new URLSearchParams({ billing: returned, ...(checkoutSession ? { session: checkoutSession } : {}) });
        return reply.redirect(`/a/${ctx.account.id}/billing?${query}`, 303);
      }
      const data = await withCatchDetail(deps.db, await loadAccount(deps.db, ctx.account.id));
      // While the first scan runs, the page reloads itself to show progress.
      return send(reply, page(`${data.account.login} · Overview`, overviewPage(data, { installLink }), { ...shellFor(data, ctx.ctx, "overview"), ...(firstScanPending(data) ? { refresh: 10 } : {}) }));
    });

    scope.get("/a/:accountId/repositories", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      const data = await loadAccount(deps.db, ctx.account.id);
      return send(reply, page("Repositories", repositoriesPage(data, billingEnabled), shellFor(data, ctx.ctx, "repositories")));
    });

    scope.get("/a/:accountId/findings", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      const data = await loadAccount(deps.db, ctx.account.id);
      const q = req.query as { kind?: string; advisory?: string };
      return send(reply, page("Problems", problemsPage(data, q), shellFor(data, ctx.ctx, "findings")));
    });

    scope.get("/a/:accountId/fixes", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      const data = await loadAccount(deps.db, ctx.account.id);
      return send(reply, page("Fixes", fixesPage(data, req.query as { state?: string }), shellFor(data, ctx.ctx, "fixes")));
    });

    scope.get("/a/:accountId/deadlines", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      // Deadlines live on the API changes page now; old links land on its timeline.
      return reply.redirect(`/a/${ctx.account.id}/advisories#timeline`);
    });

    scope.get("/a/:accountId/advisories", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      const data = await loadAccount(deps.db, ctx.account.id);
      return send(reply, page("API changes", advisoriesPage(data, req.query as { provider?: string; advisory?: string }), shellFor(data, ctx.ctx, "advisories")));
    });

    scope.get("/a/:accountId/settings", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      const data = await loadAccount(deps.db, ctx.account.id);
      const notice = SLACK_NOTICES[(req.query as { slack?: string }).slack ?? ""];
      return send(reply, page("Settings", settingsPage(data, notice, ctx.session.csrf, { llm: deps.llmAvailable === true }), shellFor(data, ctx.ctx, "settings")));
    });

    scope.post("/a/:accountId/settings", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      if (!csrfOk(ctx.session, req.body)) return expired(req, reply, ctx.session);
      const parsed = SettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return send(reply, page("Error", messagePage("Invalid settings", "PRs per hour: 1 to 20. Open PRs: 1 to 50. A Slack webhook starts with https://hooks.slack.com/services/.", { href: `/a/${ctx.account.id}/settings`, label: "Back to settings" }), bare(req, ctx.session)), 400);
      }
      const s = parsed.data;
      await withTenant(deps.db, ctx.account.id, async (tx) => {
        const current = await tx.selectFrom("accounts").select("settings").where("id", "=", ctx.account.id).executeTakeFirstOrThrow();
        // Without a key the option is not on the form: keep what was saved rather than reading it as unticked.
        const llmFixes = deps.llmAvailable ? s.llmFixes === "on" : (current.settings as { llmFixes?: boolean }).llmFixes === true;
        const next: Record<string, unknown> = { ...current.settings, prLimits: { hourly: s.hourly, open: s.open }, failOnAffected: s.failOnAffected === "on", llmFixes };
        if (s.slackRemove === "on") delete next.slackWebhookUrl;
        else if (s.slack) next.slackWebhookUrl = s.slack;
        await tx.updateTable("accounts").set({ settings: JSON.stringify(next) }).where("id", "=", ctx.account.id).execute();
      });
      return reply.redirect(`/a/${ctx.account.id}/settings`, 303);
    });

    scope.post("/a/:accountId/slack/test", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      if (!csrfOk(ctx.session, req.body)) return expired(req, reply, ctx.session);
      const account = await withTenant(deps.db, ctx.account.id, (tx) => tx.selectFrom("accounts").select(["login", "settings"]).where("id", "=", ctx.account.id).executeTakeFirstOrThrow());
      const webhook = (account.settings as { slackWebhookUrl?: string }).slackWebhookUrl;
      if (!webhook || !SLACK_WEBHOOK.test(webhook)) return reply.redirect(`/a/${ctx.account.id}/settings?slack=none`, 303);
      const sent = await postSlack(deps.fetch ?? globalThis.fetch, webhook, slackTestMessage(account.login, deps.config?.publicUrl ?? ""))
        .then(() => true)
        .catch(() => false);
      return reply.redirect(`/a/${ctx.account.id}/settings?slack=${sent ? "sent" : "failed"}`, 303);
    });

    scope.get("/a/:accountId/billing", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      const { billing: returned, session: checkoutSession } = req.query as { billing?: string; session?: string };
      if (deps.billing && returned === "done" && checkoutSession) {
        await completeCheckout(deps.billing, ctx.account.id, checkoutSession).catch((err) => req.log.warn({ err }, "could not read the checkout session; waiting for the webhook"));
      }
      const data = await loadAccount(deps.db, ctx.account.id);
      return send(reply, page("Billing", billingPage(data, billingEnabled, returned, ctx.session.csrf), shellFor(data, ctx.ctx, "billing")));
    });

    const billingAction = (path: string, run: (billing: BillingDeps, account: { id: string; login: string }) => Promise<string>) =>
      scope.post(`/a/:accountId/billing/${path}`, async (req, reply) => {
        const ctx = await accountFor(req, reply);
        if (!ctx) return;
        if (!csrfOk(ctx.session, req.body)) return expired(req, reply, ctx.session);
        if (!deps.billing) return send(reply, page("Billing", messagePage("Billing is not configured", "Every repository is covered on this server."), bare(req, ctx.session)), 503);
        try {
          return reply.redirect(await run(deps.billing, ctx.account), 303);
        } catch (err) {
          req.log.error({ err }, "billing action failed");
          return send(reply, page("Billing", messagePage("Billing is unavailable", "Stripe could not be reached. Nothing was charged. Please try again.", { href: `/a/${ctx.account.id}/billing`, label: "Back to billing" }), bare(req, ctx.session)), 502);
        }
      });
    billingAction("checkout", (billing, account) => startCheckout(billing, account));
    billingAction("portal", (billing, account) => portalUrl(billing, account));
    // Raising the paid quantity is always an explicit click; it is prorated by Stripe.
    billingAction("add-repos", async (billing, account) => {
      const repos = await withTenant(deps.db, account.id, (tx) => tx.selectFrom("repositories").select(["id", "private", "enabled", "created_at"]).execute());
      await setQuantity(billing, account.id, Math.max(1, requiredQuantity(repos)));
      return `/a/${account.id}/billing?billing=updated`;
    });

    scope.get("/a/:accountId/r/:repoId", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      const repoId = idParam.safeParse((req.params as { repoId?: string }).repoId);
      if (!repoId.success) return notFound(req, reply, ctx.session);
      const data = await loadAccount(deps.db, ctx.account.id, { lockRepo: repoId.data });
      const repo = data.repos.find((r) => r.id === repoId.data);
      if (!repo) return notFound(req, reply, ctx.session);
      const scans = await withTenant(deps.db, ctx.account.id, (tx) =>
        tx.selectFrom("scans").select(["id", "repository_id", "sha", "status", "error", "created_at", "finished_at"]).where("repository_id", "=", repo.id).orderBy("created_at", "desc").limit(10).execute(),
      );
      return send(reply, page(repo.full_name, repositoryPage(data, repo, { scans }, ctx.session.csrf), shellFor(data, ctx.ctx, "repositories")));
    });

    scope.post("/a/:accountId/r/:repoId/pause", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      if (!csrfOk(ctx.session, req.body)) return expired(req, reply, ctx.session);
      const repoId = idParam.safeParse((req.params as { repoId?: string }).repoId);
      if (!repoId.success) return notFound(req, reply, ctx.session);
      const done = await withTenant(deps.db, ctx.account.id, async (tx) => {
        const repo = await tx.selectFrom("repositories").select(["id", "settings"]).where("id", "=", repoId.data).executeTakeFirst();
        if (!repo) return false;
        const current = repo.settings as { pausedFromWeb?: boolean };
        await tx.updateTable("repositories").set({ settings: JSON.stringify({ ...repo.settings, pausedFromWeb: !current.pausedFromWeb }) }).where("id", "=", repo.id).execute();
        // Resumed: deliver the fixes that waited now, from the latest scan, instead of at the next push.
        return { resumedScan: current.pausedFromWeb ? await latestScanId(tx, repo.id) : undefined };
      });
      if (!done) return notFound(req, reply, ctx.session);
      if (done.resumedScan && deps.enqueueFix) {
        // The pause is saved either way; if the queue is down, the next scan delivers them.
        await deps.enqueueFix(done.resumedScan, repoId.data).catch((err: unknown) => req.log.error({ err }, "could not queue the fix job after resuming"));
      }
      return reply.redirect(`/a/${ctx.account.id}/r/${repoId.data}`, 303);
    });

    scope.get("/a/:accountId/f/:findingId", async (req, reply) => {
      const ctx = await accountFor(req, reply);
      if (!ctx) return;
      const findingId = idParam.safeParse((req.params as { findingId?: string }).findingId);
      if (!findingId.success) return notFound(req, reply, ctx.session);
      const [data, finding] = await Promise.all([loadAccount(deps.db, ctx.account.id), loadFinding(deps.db, ctx.account.id, findingId.data)]);
      if (!finding) return notFound(req, reply, ctx.session);
      return send(reply, page(finding.advisory?.title ?? finding.advisory_id, findingPage(ctx.account, finding, data.now), shellFor(data, ctx.ctx, "findings")));
    });
  });
}
