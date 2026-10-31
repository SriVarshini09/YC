import Stripe from "stripe";
import { withService, withTenant, type Db, type Tx } from "@shapi/db";
import { loadPlan, requiredQuantity } from "./plan";

export interface BillingConfig {
  secretKey: string;
  webhookSecret: string;
  /** The Stripe Price for one active committer (seat) per month. Created in the Stripe dashboard; no amount lives in SHAPI. */
  priceId: string;
  publicUrl: string;
}

export function stripeClient(config: Pick<BillingConfig, "secretKey">, opts: { fetch?: typeof globalThis.fetch } = {}): Stripe {
  return new Stripe(config.secretKey, {
    httpClient: Stripe.createFetchHttpClient(opts.fetch ?? globalThis.fetch),
    maxNetworkRetries: 2,
    appInfo: { name: "SHAPI" },
  });
}

/** Billing statuses with nothing left to bill: no subscription yet, or one Stripe has ended. */
const ENDED = new Set(["none", "canceled", "incomplete_expired"]);

export interface BillingDeps {
  db: Db;
  stripe: Stripe;
  config: BillingConfig;
}

/** The account's Stripe customer, created on first use and remembered. */
async function customerFor(deps: BillingDeps, accountId: string, login: string): Promise<string> {
  const existing = await withTenant(deps.db, accountId, (tx) => tx.selectFrom("billing").select("stripe_customer_id").executeTakeFirst());
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;
  const customer = await deps.stripe.customers.create({ name: login, metadata: { shapi_account_id: accountId } }, { idempotencyKey: `shapi-customer-${accountId}` });
  await withTenant(deps.db, accountId, (tx) =>
    tx
      .insertInto("billing")
      .values({ account_id: accountId, stripe_customer_id: customer.id, updated_at: new Date() })
      .onConflict((oc) => oc.column("account_id").doUpdateSet({ stripe_customer_id: customer.id, updated_at: new Date() }))
      .execute(),
  );
  return customer.id;
}

/**
 * Stripe Checkout for the active committers beyond the free ones. Returns the page to send the user to:
 * the billing page instead when there is nothing to buy, or the account already has a subscription
 * (a stale tab or a double click would otherwise start a second one, billed alongside the first).
 */
export async function startCheckout(deps: BillingDeps, account: { id: string; login: string }): Promise<string> {
  const { repos, billing } = await withTenant(deps.db, account.id, (tx) => loadPlan(tx, account.id));
  const quantity = requiredQuantity(repos);
  if (quantity === 0 || (billing && !ENDED.has(billing.status))) return `/a/${account.id}/billing`;
  const customer = await customerFor(deps, account.id, account.login);
  const session = await deps.stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: account.id,
    line_items: [{ price: deps.config.priceId, quantity }],
    subscription_data: { metadata: { shapi_account_id: account.id } },
    // Stripe fills in {CHECKOUT_SESSION_ID}; the return page reads the session so the plan updates even before the webhook arrives.
    success_url: `${deps.config.publicUrl}/a/${account.id}/billing?billing=done&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${deps.config.publicUrl}/a/${account.id}/billing?billing=cancelled`,
  });
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  return session.url;
}

/**
 * On return from Checkout: read the session from Stripe and apply its subscription, if it belongs to
 * this account. Webhooks remain the source of truth; this only avoids showing a stale plan.
 */
export async function completeCheckout(deps: BillingDeps, accountId: string, sessionId: string): Promise<boolean> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return false;
  const session = await deps.stripe.checkout.sessions.retrieve(sessionId);
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (session.client_reference_id !== accountId || !subscriptionId) return false;
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  const ours = await withTenant(deps.db, accountId, (tx) => tx.selectFrom("billing").select("stripe_customer_id").executeTakeFirst());
  if (!customer || ours?.stripe_customer_id !== customer) return false;
  return (await applySubscription(deps.db, await deps.stripe.subscriptions.retrieve(subscriptionId))) === accountId;
}

/** Stripe's own page for invoices, payment method and cancelling. */
export async function portalUrl(deps: BillingDeps, account: { id: string }): Promise<string> {
  const row = await withTenant(deps.db, account.id, (tx) => tx.selectFrom("billing").select("stripe_customer_id").executeTakeFirst());
  if (!row?.stripe_customer_id) throw new Error("no Stripe customer yet");
  const session = await deps.stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: `${deps.config.publicUrl}/a/${account.id}/billing` });
  return session.url;
}

/**
 * Set the subscription to `quantity` paid seats (prorated). Raising it happens only when a
 * user clicks to add seats; lowering it happens automatically when committers go.
 */
export async function setQuantity(deps: BillingDeps, accountId: string, quantity: number): Promise<number | undefined> {
  const row = await withService(deps.db, (tx) => tx.selectFrom("billing").select(["stripe_subscription_id", "quantity", "status"]).where("account_id", "=", accountId).executeTakeFirst());
  if (!row?.stripe_subscription_id || ENDED.has(row.status)) return undefined;
  const subscription = await deps.stripe.subscriptions.retrieve(row.stripe_subscription_id);
  const item = subscription.items.data[0];
  if (!item) return undefined;
  if (item.quantity === quantity) return quantity;
  const updated = await deps.stripe.subscriptions.update(subscription.id, { items: [{ id: item.id, quantity }], proration_behavior: "create_prorations" });
  await applySubscription(deps.db, updated);
  return quantity;
}

/** Lower the paid quantity when the account has fewer active committers than it pays for (never raise it). */
export async function syncQuantity(deps: BillingDeps, accountId: string): Promise<{ from: number; to: number } | undefined> {
  const plan = await withService(deps.db, async (tx) => {
    const repos = await tx.selectFrom("repositories").select(["id", "private", "enabled", "created_at", "committers"]).where("account_id", "=", accountId).execute();
    const billing = await tx.selectFrom("billing").select(["quantity", "status", "stripe_subscription_id"]).where("account_id", "=", accountId).executeTakeFirst();
    return { repos, billing };
  });
  if (!plan.billing?.stripe_subscription_id || ENDED.has(plan.billing.status)) return undefined;
  // Stripe keeps at least one unit; cancelling entirely is the customer's call in the billing portal.
  const target = Math.max(1, requiredQuantity(plan.repos));
  if (target >= plan.billing.quantity) return undefined;
  await setQuantity(deps, accountId, target);
  return { from: plan.billing.quantity, to: target };
}

/** The daily sync: lower every plan that is larger than needed. A Stripe error on one account is logged, and the others still sync. */
export async function syncAllQuantities(deps: BillingDeps, log: { error(obj: object, msg?: string): void }) {
  const accounts = await withService(deps.db, (tx) => tx.selectFrom("billing").select("account_id").where("stripe_subscription_id", "is not", null).where("status", "not in", [...ENDED]).execute());
  const changes: { accountId: string; from: number; to: number }[] = [];
  const failed: string[] = [];
  for (const a of accounts) {
    try {
      const change = await syncQuantity(deps, a.account_id);
      if (change) changes.push({ accountId: a.account_id, ...change });
    } catch (err) {
      failed.push(a.account_id);
      log.error({ err, accountId: a.account_id }, "billing sync failed for an account");
    }
  }
  return { synced: accounts.length, changes, failed };
}

/**
 * Uninstalling deletes the account and its billing row, after which SHAPI can neither see nor change
 * the subscription: cancel it in Stripe first, at once (paid periods aren't refunded). Runs inside the
 * uninstall's transaction, so if Stripe fails the account stays and the delivery is retried. Returns
 * the cancelled subscription's id.
 */
export async function cancelOnUninstall(stripe: Stripe, tx: Tx, accountId: string): Promise<string | undefined> {
  const row = await tx.selectFrom("billing").select(["stripe_subscription_id", "status"]).where("account_id", "=", accountId).executeTakeFirst();
  if (!row?.stripe_subscription_id || ENDED.has(row.status)) return undefined;
  // The row can lag behind Stripe (a missed event): cancel only what Stripe still bills.
  const current = await stripe.subscriptions.retrieve(row.stripe_subscription_id).catch((err: unknown) => {
    if (err instanceof Stripe.errors.StripeError && err.statusCode === 404) return undefined;
    throw err;
  });
  if (!current || ENDED.has(current.status)) return undefined;
  await stripe.subscriptions.cancel(current.id, {}, { idempotencyKey: `shapi-uninstall-${current.id}` });
  return current.id;
}

function periodEnd(subscription: Stripe.Subscription): Date | null {
  const item = subscription.items.data[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
  const legacy = (subscription as unknown as { current_period_end?: number }).current_period_end;
  const end = item?.current_period_end ?? legacy;
  return end ? new Date(end * 1000) : null;
}

/**
 * Store a subscription's state on the account it belongs to (from metadata, or the customer). Not for
 * an account that is gone (uninstalled), and never over a different subscription that is still live:
 * an account has one subscription, and an event for an old or extra one must not replace it.
 */
async function storeSubscription(tx: Tx, subscription: Stripe.Subscription): Promise<{ accountId: string } | { ignored: string }> {
  const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const byCustomer = await tx.selectFrom("billing").select("account_id").where("stripe_customer_id", "=", customer).executeTakeFirst();
  const accountId = subscription.metadata?.shapi_account_id ?? byCustomer?.account_id;
  if (!accountId || !/^\d+$/.test(accountId)) return { ignored: "unknown account" };
  const account = await tx.selectFrom("accounts").select("id").where("id", "=", accountId).executeTakeFirst();
  if (!account) return { ignored: "unknown account" };
  const stored = await tx.selectFrom("billing").select(["stripe_subscription_id", "status"]).where("account_id", "=", accountId).executeTakeFirst();
  if (stored?.stripe_subscription_id && stored.stripe_subscription_id !== subscription.id && !ENDED.has(stored.status)) {
    return { ignored: `account ${accountId} has another live subscription` };
  }
  const values = {
    stripe_customer_id: customer,
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    quantity: subscription.status === "canceled" ? 0 : (subscription.items.data[0]?.quantity ?? 0),
    current_period_end: periodEnd(subscription),
    cancel_at: subscription.status === "canceled" ? null : subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : subscription.cancel_at_period_end ? periodEnd(subscription) : null,
    updated_at: new Date(),
  };
  await tx
    .insertInto("billing")
    .values({ account_id: accountId, ...values })
    .onConflict((oc) => oc.column("account_id").doUpdateSet(values))
    .execute();
  return { accountId };
}

export async function applySubscription(db: Db, subscription: Stripe.Subscription): Promise<string | undefined> {
  const stored = await withService(db, (tx) => storeSubscription(tx, subscription));
  return "accountId" in stored ? stored.accountId : undefined;
}

/**
 * The subscription an event is about, read from Stripe rather than taken from the event: Stripe
 * doesn't deliver events in order, so the event's copy can be older than one already applied.
 * A string says why the event changes nothing.
 */
async function eventSubscription(deps: BillingDeps, event: Stripe.Event): Promise<{ subscription: Stripe.Subscription; started: boolean } | string> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      if (!subscriptionId) return "ignored: no subscription";
      return { subscription: await deps.stripe.subscriptions.retrieve(subscriptionId), started: true };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return { subscription: await deps.stripe.subscriptions.retrieve(event.data.object.id), started: false };
    default:
      return `ignored: ${event.type}`;
  }
}

/**
 * Apply one verified Stripe webhook event, once (Stripe redelivers until it gets a 2xx). Returns
 * what changed, for the log.
 */
export async function handleStripeEvent(deps: BillingDeps, event: Stripe.Event): Promise<string> {
  const seen = await withService(deps.db, (tx) => tx.selectFrom("stripe_events").select("id").where("id", "=", event.id).executeTakeFirst());
  if (seen) return "duplicate";
  const change = await eventSubscription(deps, event);
  // The event id commits together with its change: a failure or crash leaves neither, and Stripe's redelivery applies it.
  return withService(deps.db, async (tx) => {
    const fresh = await tx.insertInto("stripe_events").values({ id: event.id, type: event.type }).onConflict((oc) => oc.column("id").doNothing()).returning("id").executeTakeFirst();
    if (!fresh) return "duplicate";
    if (typeof change === "string") return change;
    const stored = await storeSubscription(tx, change.subscription);
    if ("ignored" in stored) return `ignored: ${stored.ignored}`;
    return change.started ? `subscription started for account ${stored.accountId}` : `subscription ${change.subscription.status} for account ${stored.accountId}`;
  });
}
