import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { createDb, migrateToLatest, withService, type Db } from "@shapi/db";
import { fakeUserGitHub } from "../../../test-utils/fake-github";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";
import { buildApp, coverage, githubClients, handleStripeEvent, loadConfig, processDelivery, requiredQuantity, runScanJob, syncAllQuantities, syncQuantity, stripeClient, type BillingDeps } from "../src/index";

let pg: TestPostgres;
let db: Db;
let owner: Db;

beforeAll(async () => {
  pg = await startTestPostgres("shapi_billing");
  owner = createDb({ connectionString: pg.url, appRole: false });
  await migrateToLatest(owner);
  db = createDb({ connectionString: pg.url });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await owner?.destroy();
  await pg?.stop();
}, 60_000);

const WEBHOOK_SECRET = "whsec_test_secret";
const billingConfig = { secretKey: "sk_test_fake", webhookSecret: WEBHOOK_SECRET, priceId: "price_repo_monthly", publicUrl: "http://localhost:8787" };
const webApp = { clientId: "Iv1.test", clientSecret: "s", publicUrl: "http://localhost:8787", sessionSecret: "x".repeat(32), appSlug: "shapi-test" };
const config = { LOG_LEVEL: "info" as const, GIT_SHA: "t", NODE_ENV: "test" as const, webApp, billing: billingConfig };

/** Stripe's API as SHAPI uses it, in memory: customers, checkout and portal sessions, subscriptions. */
function fakeStripe() {
  const calls: { method: string; path: string; body: URLSearchParams }[] = [];
  const subs = new Map<
    string,
    { id: string; customer: string; status: string; metadata: Record<string, string>; items: { id: string; quantity: number; current_period_end: number }[]; cancel_at?: number; cancel_at_period_end?: boolean }
  >();
  /** Requests the fake answers with a Stripe error, by "METHOD /path". */
  const failing = new Set<string>();
  let n = 0;
  /** Checkout session id -> the account it was created for. */
  const sessionsFor = new Map<string, string>();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const subJson = (s: NonNullable<ReturnType<typeof subs.get>>) => ({
    id: s.id,
    object: "subscription",
    customer: s.customer,
    status: s.status,
    metadata: s.metadata,
    cancel_at: s.cancel_at ?? null,
    cancel_at_period_end: s.cancel_at_period_end ?? false,
    items: { object: "list", data: s.items.map((i) => ({ object: "subscription_item", ...i })) },
  });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    calls.push({ method, path: url.pathname, body });
    if (failing.has(`${method} ${url.pathname}`)) return json({ error: { type: "invalid_request_error", message: "fake Stripe refused" } }, 400);
    if (method === "POST" && url.pathname === "/v1/customers") return json({ id: `cus_${++n}`, object: "customer" });
    if (method === "POST" && url.pathname === "/v1/checkout/sessions") return json({ id: `cs_${++n}`, object: "checkout.session", url: `https://checkout.stripe.test/cs_${n}` });
    if (method === "GET" && url.pathname.startsWith("/v1/checkout/sessions/")) {
      const id = url.pathname.split("/").pop()!;
      return json({ id, object: "checkout.session", subscription: "sub_r", customer: "cus_r", client_reference_id: sessionsFor.get(id) });
    }
    if (method === "POST" && url.pathname === "/v1/billing_portal/sessions") return json({ id: `bps_${++n}`, object: "billing_portal.session", url: "https://billing.stripe.test/portal" });
    const m = /^\/v1\/subscriptions\/(.+)$/.exec(url.pathname);
    if (m) {
      const s = subs.get(m[1]!);
      if (!s) return json({ error: { message: "No such subscription" } }, 404);
      if (method === "POST") s.items[0]!.quantity = Number(body.get("items[0][quantity]"));
      if (method === "DELETE") s.status = "canceled";
      return json(subJson(s));
    }
    return json({ error: { message: `fake Stripe has no ${method} ${url.pathname}` } }, 404);
  }) as typeof globalThis.fetch;
  /** What Stripe would hold after a successful checkout. */
  const subscribe = (id: string, customer: string, accountId: string, quantity: number) =>
    subs.set(id, { id, customer, status: "active", metadata: { shapi_account_id: accountId }, items: [{ id: `si_${id}`, quantity, current_period_end: 1_900_000_000 }] });
  return { fetch, calls, subs, subscribe, subJson, sessionsFor, failing };
}

/** A signed webhook exactly as Stripe sends it. */
function signed(event: object) {
  const payload = JSON.stringify(event);
  return { payload, headers: { "content-type": "application/json", "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) } };
}

let accountId: string;
let repoIds: Record<string, string>;

beforeEach(async () => {
  await owner.deleteFrom("accounts").execute();
  await owner.deleteFrom("sessions").execute();
  await owner.deleteFrom("stripe_events").execute();
  const a = await owner.insertInto("accounts").values({ github_installation_id: 4242, login: "acme", type: "Organization", settings: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow();
  accountId = a.id;
  repoIds = {};
  const repos: [string, boolean, string][] = [
    ["acme/site", false, "2026-01-01"],
    ["acme/api", true, "2026-01-02"],
    ["acme/billing", true, "2026-01-03"],
    ["acme/crm", true, "2026-01-04"],
  ];
  for (const [i, [name, priv, created]] of repos.entries()) {
    const r = await owner
      .insertInto("repositories")
      .values({ account_id: accountId, github_repo_id: 100 + i, full_name: name, default_branch: "main", private: priv, created_at: new Date(created) })
      .returning("id")
      .executeTakeFirstOrThrow();
    repoIds[name] = r.id;
  }
});

/** Sign in through the web app with a fake GitHub that grants installation 4242. */
async function signIn(app: ReturnType<typeof buildApp>) {
  const login = await app.inject("/login");
  const state = new URL(String(login.headers.location)).searchParams.get("state")!;
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const callback = await app.inject({ url: `/auth/github/callback?code=c&state=${state}`, headers: { cookie } });
  return `shapi_session=${callback.cookies.find((c) => c.name === "shapi_session")!.value}`;
}

function appWith(stripe: ReturnType<typeof fakeStripe>) {
  // Billing is for account admins: the user is admin on every repository of acme.
  const repositories = [100, 101, 102, 103, 200].map((id) => ({ id, permissions: { admin: true, push: true } }));
  const github = fakeUserGitHub({ user: { id: 1, login: "octo" }, installations: [{ id: 4242, account: { id: 500, login: "acme", type: "Organization" }, repositories }] });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).host === "api.stripe.com") return stripe.fetch(input, init);
    return github.fetch(input, init);
  }) as typeof globalThis.fetch;
  return buildApp({ db, config, fetch });
}

const csrfFrom = (body: string) => /name="csrf" value="([^"]+)"/.exec(body)![1]!;

describe("plan rules", () => {
  const repos = [
    { id: "1", private: false, enabled: true, created_at: new Date("2026-01-01") },
    { id: "2", private: true, enabled: true, created_at: new Date("2026-01-02") },
    { id: "3", private: true, enabled: true, created_at: new Date("2026-01-03") },
    { id: "4", private: true, enabled: false, created_at: new Date("2026-01-04") },
  ];
  it("covers public repositories and the oldest private one free; more private ones need a paid plan", () => {
    expect(requiredQuantity(repos)).toBe(1);
    const free = coverage(repos, undefined, true);
    expect([...free.values()].map((c) => (c.covered ? c.by : "no"))).toEqual(["public", "free", "no", "no"]);
    const paid = coverage(repos, { status: "active", quantity: 1 }, true);
    expect(paid.get("3")).toEqual({ covered: true, by: "paid" });
    expect(coverage(repos, { status: "canceled", quantity: 1 }, true).get("3")!.covered).toBe(false);
    expect(coverage(repos, { status: "past_due", quantity: 1 }, true).get("3")!.covered).toBe(true);
    expect([...coverage(repos, undefined, false).values()].every((c) => c.covered)).toBe(true);
  });

  it("config takes all three Stripe settings or none, and refuses a live key outside production", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x" }).billing).toBeUndefined();
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", STRIPE_SECRET_KEY: "sk_test_1" })).toThrow(/or none/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", STRIPE_SECRET_KEY: "sk_live_1", STRIPE_WEBHOOK_SECRET: "w", STRIPE_PRICE_ID: "p" })).toThrow(/test key/);
    expect(loadConfig({ DATABASE_URL: "postgres://x", STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "w", STRIPE_PRICE_ID: "price_1" }).billing).toMatchObject({ priceId: "price_1" });
  });
});

describe("billing in the web app", () => {
  it("free plan: shows what is not covered and starts Stripe Checkout for exactly the extra private repositories", async () => {
    const stripe = fakeStripe();
    const app = appWith(stripe);
    const cookie = await signIn(app);
    const repos = await app.inject({ url: `/a/${accountId}/repositories`, headers: { cookie } });
    expect(repos.body.match(/not covered by plan/g)).toHaveLength(2);
    const page = await app.inject({ url: `/a/${accountId}/billing`, headers: { cookie } });
    expect(page.body).toContain("Free plan");
    expect(page.body).toContain("Upgrade to cover 2 more private repositories");
    expect(page.body).toContain('Upgrading means you accept the <a href="https://shapi.dev/legal/terms">terms of service</a>');

    // The browser follows the 303 to Stripe only if the page's CSP allows it as a form target.
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toMatch(/form-action 'self' https:\/\/checkout\.stripe\.com https:\/\/billing\.stripe\.com;/);
    const res = await app.inject({ method: "POST", url: `/a/${accountId}/billing/checkout`, headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `csrf=${csrfFrom(page.body)}` });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const checkout = stripe.calls.find((c) => c.path === "/v1/checkout/sessions")!;
    expect(checkout.body.get("mode")).toBe("subscription");
    expect(checkout.body.get("line_items[0][price]")).toBe("price_repo_monthly");
    expect(checkout.body.get("line_items[0][quantity]")).toBe("2");
    expect(checkout.body.get("client_reference_id")).toBe(accountId);
    expect(stripe.calls.find((c) => c.path === "/v1/customers")!.body.get("metadata[shapi_account_id]")).toBe(accountId);
    const billing = await withService(db, (tx) => tx.selectFrom("billing").selectAll().executeTakeFirstOrThrow());
    expect(billing).toMatchObject({ stripe_customer_id: "cus_1", status: "none", quantity: 0 });

    const forged = await app.inject({ method: "POST", url: `/a/${accountId}/billing/checkout`, headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `csrf=${"wrong"}` });
    expect(forged.statusCode).toBe(403);
    await app.close();
  });

  it("applies signed Stripe events once; paid repositories become covered; a cancellation takes them back", async () => {
    const stripe = fakeStripe();
    const app = appWith(stripe);
    await withService(db, (tx) => tx.insertInto("billing").values({ account_id: accountId, stripe_customer_id: "cus_9", updated_at: new Date() }).execute());
    stripe.subscribe("sub_1", "cus_9", accountId, 2);

    const event = { id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_1", object: "checkout.session", subscription: "sub_1", customer: "cus_9", client_reference_id: accountId } } };
    const bad = await app.inject({ method: "POST", url: "/stripe/webhook", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=bad" }, payload: JSON.stringify(event) });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/stripe/webhook", ...signed(event) });
    expect(ok.json()).toEqual({ ok: true, outcome: `subscription started for account ${accountId}` });
    expect((await app.inject({ method: "POST", url: "/stripe/webhook", ...signed(event) })).json().outcome).toBe("duplicate");

    const billing = await withService(db, (tx) => tx.selectFrom("billing").selectAll().executeTakeFirstOrThrow());
    expect(billing).toMatchObject({ stripe_subscription_id: "sub_1", status: "active", quantity: 2 });
    const repos = await withService(db, (tx) => tx.selectFrom("repositories").select(["id", "private", "enabled", "created_at"]).execute());
    expect([...coverage(repos, billing, true).values()].every((c) => c.covered)).toBe(true);

    const cookie = await signIn(app);
    const page = await app.inject({ url: `/a/${accountId}/billing`, headers: { cookie } });
    expect(page.body).toContain("Paid plan");
    expect((await app.inject({ url: `/a/${accountId}/repositories`, headers: { cookie } })).body).not.toContain("not covered by plan");
    expect(page.body).toContain("Manage billing and invoices");
    const portal = await app.inject({ method: "POST", url: `/a/${accountId}/billing/portal`, headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `csrf=${csrfFrom(page.body)}` });
    expect(portal.headers.location).toBe("https://billing.stripe.test/portal");

    // cancelled in the portal: still active until the period ends, and the plan card says so
    Object.assign(stripe.subs.get("sub_1")!, { cancel_at_period_end: true, cancel_at: 1798761600 });
    const scheduled = { id: "evt_1b", object: "event", type: "customer.subscription.updated", data: { object: { ...stripe.subJson(stripe.subs.get("sub_1")!), cancel_at_period_end: true, cancel_at: 1798761600 } } };
    expect((await app.inject({ method: "POST", url: "/stripe/webhook", ...signed(scheduled) })).json().outcome).toBe(`subscription active for account ${accountId}`);
    const cancelling = await app.inject({ url: `/a/${accountId}/billing`, headers: { cookie } });
    expect(cancelling.body).toContain("Cancels on 2027-01-01");
    expect(cancelling.body).not.toContain("Renews");

    stripe.subs.get("sub_1")!.status = "canceled";
    const cancelled = { id: "evt_2", object: "event", type: "customer.subscription.deleted", data: { object: stripe.subJson(stripe.subs.get("sub_1")!) } };
    expect((await app.inject({ method: "POST", url: "/stripe/webhook", ...signed(cancelled) })).json().outcome).toBe(`subscription canceled for account ${accountId}`);
    const after = await withService(db, (tx) => tx.selectFrom("billing").select(["status", "quantity", "cancel_at"]).executeTakeFirstOrThrow());
    expect(after).toEqual({ status: "canceled", quantity: 0, cancel_at: null });
    await app.close();
  });

  it("raises the plan only on an explicit click, and lowers it automatically when private repositories go", async () => {
    const stripe = fakeStripe();
    const app = appWith(stripe);
    stripe.subscribe("sub_2", "cus_2", accountId, 2);
    await withService(db, (tx) => tx.insertInto("billing").values({ account_id: accountId, stripe_customer_id: "cus_2", stripe_subscription_id: "sub_2", status: "active", quantity: 2, updated_at: new Date() }).execute());
    await owner.insertInto("repositories").values({ account_id: accountId, github_repo_id: 200, full_name: "acme/new", default_branch: "main", private: true, created_at: new Date("2026-02-01") }).execute();

    const cookie = await signIn(app);
    const page = await app.inject({ url: `/a/${accountId}/billing`, headers: { cookie } });
    expect(page.body).toContain("Add 1 repository to the plan");
    expect((await app.inject({ url: `/a/${accountId}/repositories`, headers: { cookie } })).body.match(/not covered by plan/g)).toHaveLength(1);
    expect(stripe.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/subscriptions"))).toEqual([]);

    const add = await app.inject({ method: "POST", url: `/a/${accountId}/billing/add-repos`, headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `csrf=${csrfFrom(page.body)}` });
    expect(add.headers.location).toBe(`/a/${accountId}/billing?billing=updated`);
    const update = stripe.calls.find((c) => c.method === "POST" && c.path === "/v1/subscriptions/sub_2")!;
    expect(update.body.get("items[0][quantity]")).toBe("3");
    expect(update.body.get("proration_behavior")).toBe("create_prorations");

    // two private repositories leave: the plan drops to what is used (never below one unit)
    await owner.deleteFrom("repositories").where("full_name", "in", ["acme/billing", "acme/crm", "acme/new"]).execute();
    const deps: BillingDeps = { db, stripe: stripeClient(billingConfig, { fetch: stripe.fetch }), config: billingConfig };
    expect(await syncQuantity(deps, accountId)).toEqual({ from: 3, to: 1 });
    expect(await syncQuantity(deps, accountId)).toBeUndefined();
    await app.close();
  });
});

const billingDeps = (stripe: ReturnType<typeof fakeStripe>): BillingDeps => ({ db, stripe: stripeClient(billingConfig, { fetch: stripe.fetch }), config: billingConfig });
const paying = (subscription: string, customer: string, quantity = 2, account = accountId) =>
  withService(db, (tx) => tx.insertInto("billing").values({ account_id: account, stripe_customer_id: customer, stripe_subscription_id: subscription, status: "active", quantity, updated_at: new Date() }).execute());
const billingRow = () => withService(db, (tx) => tx.selectFrom("billing").select(["stripe_subscription_id", "status", "quantity"]).where("account_id", "=", accountId).executeTakeFirst());
const subscriptionEvent = (id: string, type: string, object: object) => ({ id, object: "event", type, data: { object } }) as unknown as Stripe.Event;

describe("one subscription per account", () => {
  it("refuses a second Checkout while the account pays, and a Checkout with nothing to pay for", async () => {
    const stripe = fakeStripe();
    const app = appWith(stripe);
    const cookie = await signIn(app);
    // A tab opened before paying still shows the Upgrade button and a valid CSRF token.
    const stale = await app.inject({ url: `/a/${accountId}/billing`, headers: { cookie } });
    await paying("sub_live", "cus_live");
    stripe.subscribe("sub_live", "cus_live", accountId, 2);
    const again = await app.inject({ method: "POST", url: `/a/${accountId}/billing/checkout`, headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `csrf=${csrfFrom(stale.body)}` });
    expect(again.statusCode).toBe(303);
    expect(again.headers.location).toBe(`/a/${accountId}/billing`);
    expect(stripe.calls.filter((c) => c.path === "/v1/checkout/sessions")).toEqual([]);

    // Free again, with one private repository: the free plan covers it, so there is nothing to buy.
    await withService(db, (tx) => tx.updateTable("billing").set({ status: "canceled", quantity: 0 }).execute());
    await owner.deleteFrom("repositories").where("full_name", "in", ["acme/billing", "acme/crm"]).execute();
    const none = await app.inject({ method: "POST", url: `/a/${accountId}/billing/checkout`, headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `csrf=${csrfFrom(stale.body)}` });
    expect(none.headers.location).toBe(`/a/${accountId}/billing`);
    expect(stripe.calls.filter((c) => c.path === "/v1/checkout/sessions")).toEqual([]);
    await app.close();
  });

  it("applies each subscription event as Stripe has it now, and never lets another subscription replace the live one", async () => {
    const stripe = fakeStripe();
    const deps = billingDeps(stripe);
    await paying("sub_1", "cus_1");
    stripe.subscribe("sub_1", "cus_1", accountId, 2);
    stripe.subs.get("sub_1")!.status = "canceled";
    const deleted = stripe.subJson(stripe.subs.get("sub_1")!);
    expect(await handleStripeEvent(deps, subscriptionEvent("evt_del", "customer.subscription.deleted", deleted))).toBe(`subscription canceled for account ${accountId}`);
    // An update sent before the cancellation arrives late: its snapshot says active, Stripe says canceled.
    const late = subscriptionEvent("evt_late", "customer.subscription.updated", { ...deleted, status: "active" });
    expect(await handleStripeEvent(deps, late)).toBe(`subscription canceled for account ${accountId}`);
    expect(await billingRow()).toEqual({ stripe_subscription_id: "sub_1", status: "canceled", quantity: 0 });

    // A new subscription replaces the ended one; events for the old one no longer touch it.
    stripe.subscribe("sub_2", "cus_1", accountId, 3);
    expect(await handleStripeEvent(deps, subscriptionEvent("evt_new", "customer.subscription.created", stripe.subJson(stripe.subs.get("sub_2")!)))).toBe(`subscription active for account ${accountId}`);
    expect(await handleStripeEvent(deps, subscriptionEvent("evt_old", "customer.subscription.updated", deleted))).toBe(`ignored: account ${accountId} has another live subscription`);
    // A second live subscription (two Checkout pages paid) does not take over the tracked one either.
    stripe.subscribe("sub_3", "cus_1", accountId, 1);
    expect(await handleStripeEvent(deps, subscriptionEvent("evt_dup", "customer.subscription.created", stripe.subJson(stripe.subs.get("sub_3")!)))).toBe(`ignored: account ${accountId} has another live subscription`);
    expect(await billingRow()).toEqual({ stripe_subscription_id: "sub_2", status: "active", quantity: 3 });
  });

  it("records a Stripe event only together with its change, so a failed one is applied on redelivery", async () => {
    const stripe = fakeStripe();
    const deps = billingDeps(stripe);
    await paying("sub_1", "cus_1");
    stripe.subscribe("sub_1", "cus_1", accountId, 4);
    stripe.failing.add("GET /v1/subscriptions/sub_1");
    const event = subscriptionEvent("evt_1", "customer.subscription.updated", stripe.subJson(stripe.subs.get("sub_1")!));
    await expect(handleStripeEvent(deps, event)).rejects.toThrow(/refused/);
    expect(await owner.selectFrom("stripe_events").selectAll().execute()).toEqual([]);
    stripe.failing.clear();
    expect(await handleStripeEvent(deps, event)).toBe(`subscription active for account ${accountId}`);
    expect(await billingRow()).toMatchObject({ quantity: 4 });
    expect(await handleStripeEvent(deps, event)).toBe("duplicate");
  });
});

describe("uninstalling", () => {
  const github = () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    return githubClients({ appId: "1", privateKey }, { fetch: (async () => new Response("{}", { status: 500 })) as typeof globalThis.fetch, resilient: false });
  };
  const uninstall = async () => {
    const id = randomUUID();
    const payload = { action: "deleted", installation: { id: 4242, account: { login: "acme", type: "Organization" } } };
    await db.insertInto("webhook_deliveries").values({ delivery_id: id, event: "installation", action: "deleted", installation_id: null, payload: JSON.stringify(payload) }).execute();
    return id;
  };

  it("cancels the subscription in Stripe; its later events are ignored with a 200", async () => {
    const stripe = fakeStripe();
    const app = appWith(stripe);
    await paying("sub_u", "cus_u");
    stripe.subscribe("sub_u", "cus_u", accountId, 2);
    const result = await processDelivery({ db, github: github(), billing: billingDeps(stripe) }, await uninstall());
    expect(result.outcome).toBe("account removed (1), subscription sub_u cancelled");
    expect(stripe.calls.filter((c) => c.method === "DELETE")).toMatchObject([{ path: "/v1/subscriptions/sub_u" }]);
    expect(await owner.selectFrom("billing").selectAll().execute()).toEqual([]);

    // Stripe then reports the cancellation, and later anything else about the subscription: nothing to store.
    for (const [id, type] of [
      ["evt_u1", "customer.subscription.deleted"],
      ["evt_u2", "customer.subscription.updated"],
    ] as const) {
      const res = await app.inject({ method: "POST", url: "/stripe/webhook", ...signed(subscriptionEvent(id, type, stripe.subJson(stripe.subs.get("sub_u")!))) });
      expect(res.statusCode).toBe(200);
      expect(res.json().outcome).toBe("ignored: unknown account");
    }
    await app.close();
  });

  it("keeps the account when Stripe refuses the cancellation, so the delivery is retried", async () => {
    const stripe = fakeStripe();
    await paying("sub_u", "cus_u");
    stripe.subscribe("sub_u", "cus_u", accountId, 2);
    stripe.failing.add("DELETE /v1/subscriptions/sub_u");
    const id = await uninstall();
    await expect(processDelivery({ db, github: github(), billing: billingDeps(stripe) }, id)).rejects.toThrow(/refused/);
    expect(await billingRow()).toMatchObject({ stripe_subscription_id: "sub_u", status: "active" });
    stripe.failing.clear();
    expect((await processDelivery({ db, github: github(), billing: billingDeps(stripe) }, id)).outcome).toBe("account removed (1), subscription sub_u cancelled");
  });

  it("does not cancel a subscription that already ended, or that Stripe does not know", async () => {
    const stripe = fakeStripe();
    await withService(db, (tx) => tx.insertInto("billing").values({ account_id: accountId, stripe_customer_id: "cus_e", stripe_subscription_id: "sub_e", status: "canceled", updated_at: new Date() }).execute());
    expect((await processDelivery({ db, github: github(), billing: billingDeps(stripe) }, await uninstall())).outcome).toBe("account removed (1)");
    expect(stripe.calls).toEqual([]);

    // The row says active, but Stripe ended it (a missed event), or never had it: nothing to cancel, and the account still goes.
    for (const [subscription, inStripe] of [
      ["sub_ended", true],
      ["sub_unknown", false],
    ] as const) {
      await owner.insertInto("accounts").values({ id: accountId, github_installation_id: 4242, login: "acme", type: "Organization", settings: JSON.stringify({}) }).execute();
      await paying(subscription, `cus_${subscription}`);
      if (inStripe) {
        stripe.subscribe(subscription, `cus_${subscription}`, accountId, 2);
        stripe.subs.get(subscription)!.status = "canceled";
      }
      expect((await processDelivery({ db, github: github(), billing: billingDeps(stripe) }, await uninstall())).outcome).toBe("account removed (1)");
    }
    expect(stripe.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });
});

describe("daily billing sync", () => {
  it("lowers every account it can, even when Stripe fails for one of them", async () => {
    const stripe = fakeStripe();
    const second = await owner.insertInto("accounts").values({ github_installation_id: 4343, login: "beta", type: "Organization", settings: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow();
    const third = await owner.insertInto("accounts").values({ github_installation_id: 4444, login: "gamma", type: "Organization", settings: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow();
    // acme needs 2 and pays 5, but Stripe fails for it; beta has no private repositories and pays 3.
    await paying("sub_a", "cus_a", 5);
    stripe.subscribe("sub_a", "cus_a", accountId, 5);
    stripe.failing.add("GET /v1/subscriptions/sub_a");
    await paying("sub_b", "cus_b", 3, second.id);
    stripe.subscribe("sub_b", "cus_b", second.id, 3);
    // gamma's first payment never went through: Stripe does not update an expired subscription.
    await withService(db, (tx) => tx.insertInto("billing").values({ account_id: third.id, stripe_customer_id: "cus_c", stripe_subscription_id: "sub_c", status: "incomplete_expired", quantity: 2, updated_at: new Date() }).execute());
    const errors: object[] = [];
    const result = await syncAllQuantities(billingDeps(stripe), { error: (obj) => errors.push(obj) });
    expect(result).toEqual({ synced: 2, changes: [{ accountId: second.id, from: 3, to: 1 }], failed: [accountId] });
    expect(errors).toMatchObject([{ accountId }]);
    expect(stripe.calls.some((c) => c.path === "/v1/subscriptions/sub_c")).toBe(false);
  });
});

describe("return from Checkout", () => {
  it("applies the subscription from the checkout session, only when it belongs to this account", async () => {
    const stripe = fakeStripe();
    const app = appWith(stripe);
    await withService(db, (tx) => tx.insertInto("billing").values({ account_id: accountId, stripe_customer_id: "cus_r", updated_at: new Date() }).execute());
    stripe.subscribe("sub_r", "cus_r", accountId, 2);
    stripe.sessionsFor.set("cs_other", "999");
    stripe.sessionsFor.set("cs_mine", accountId);
    const cookie = await signIn(app);

    const other = await app.inject({ url: `/a/${accountId}/billing?billing=done&session=cs_other`, headers: { cookie } });
    expect(other.body).toContain("Free plan");
    const mine = await app.inject({ url: `/a/${accountId}/billing?billing=done&session=cs_mine`, headers: { cookie } });
    expect(mine.body).toContain("Paid plan");
    expect(mine.body).toContain("Your plan updates as soon as Stripe confirms the payment.");
    const billing = await withService(db, (tx) => tx.selectFrom("billing").select(["status", "quantity", "stripe_subscription_id"]).executeTakeFirstOrThrow());
    expect(billing).toEqual({ status: "active", quantity: 2, stripe_subscription_id: "sub_r" });
    await app.close();
  });
});

describe("plan enforcement in jobs", () => {
  it("does not scan a private repository the plan does not cover", async () => {
    const scan = await withService(db, (tx) =>
      tx.insertInto("scans").values({ account_id: accountId, repository_id: repoIds["acme/crm"]!, sha: "a".repeat(40), status: "queued" }).returning("id").executeTakeFirstOrThrow(),
    );
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const github = githubClients({ appId: "1", privateKey }, { fetch: (async () => new Response("{}", { status: 500 })) as typeof globalThis.fetch, resilient: false });
    const report = await runScanJob({ db, github, billingEnforced: true }, { scanId: scan.id });
    expect(report).toMatchObject({ status: "skipped", reason: "not covered by the plan: the free plan covers one private repository" });
    const row = await withService(db, (tx) => tx.selectFrom("scans").select(["status", "error"]).where("id", "=", scan.id).executeTakeFirstOrThrow());
    expect(row).toEqual({ status: "failed", error: "not covered by the plan: the free plan covers one private repository" });
  });
});
