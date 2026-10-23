import Stripe from "stripe";
import { withService, withTenant, type Db } from "@shapi/db";
import { loadPlan, requiredQuantity } from "./plan";

export interface BillingConfig {
  secretKey: string;
  webhookSecret: string;
  /** The Stripe Price for one private repository per month. Created in the Stripe dashboard; no amount lives in SHAPI. */
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

/** Stripe Checkout for the private repositories beyond the free one. Returns the page to send the user to. */
export async function startCheckout(deps: BillingDeps, account: { id: string; login: string }): Promise<string> {
  const { repos } = await withTenant(deps.db, account.id, (tx) => loadPlan(tx, account.id));
  const quantity = Math.max(1, requiredQuantity(repos));
  const customer = await customerFor(deps, account.id, account.login);
  const session = await deps.stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: account.id,
    line_items: [{ price: deps.config.priceId, quantity }],
    subscription_data: { metadata: { shapi_account_id: account.id } },
    // Stripe fills in {CHECKOUT_SESSION_ID}; the return page reads the session so the plan updates even before the webhook arrives.
    success_url: `${deps.config.publicUrl}/a/${account.id}?billing=done&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${deps.config.publicUrl}/a/${account.id}?billing=cancelled`,
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
  const session = await deps.stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: `${deps.config.publicUrl}/a/${account.id}` });
  return session.url;
}

/**
 * Set the subscription to `quantity` paid repositories (prorated). Raising it happens only when a
 * user clicks to add repositories; lowering it happens automatically when private repositories go.
 */
export async function setQuantity(deps: BillingDeps, accountId: string, quantity: number): Promise<number | undefined> {
  const row = await withService(deps.db, (tx) => tx.selectFrom("billing").select(["stripe_subscription_id", "quantity", "status"]).where("account_id", "=", accountId).executeTakeFirst());
  if (!row?.stripe_subscription_id || row.status === "canceled") return undefined;
  const subscription = await deps.stripe.subscriptions.retrieve(row.stripe_subscription_id);
  const item = subscription.items.data[0];
  if (!item) return undefined;
  if (item.quantity === quantity) return quantity;
  const updated = await deps.stripe.subscriptions.update(subscription.id, { items: [{ id: item.id, quantity }], proration_behavior: "create_prorations" });
  await applySubscription(deps.db, updated);
  return quantity;
}

/** Lower the paid quantity when the account has fewer private repositories than it pays for (never raise it). */
export async function syncQuantity(deps: BillingDeps, accountId: string): Promise<{ from: number; to: number } | undefined> {
  const plan = await withService(deps.db, async (tx) => {
    const repos = await tx.selectFrom("repositories").select(["id", "private", "enabled", "created_at"]).where("account_id", "=", accountId).execute();
    const billing = await tx.selectFrom("billing").select(["quantity", "status", "stripe_subscription_id"]).where("account_id", "=", accountId).executeTakeFirst();
    return { repos, billing };
  });
  if (!plan.billing?.stripe_subscription_id || plan.billing.status === "canceled") return undefined;
  // Stripe keeps at least one unit; cancelling entirely is the customer's call in the billing portal.
  const target = Math.max(1, requiredQuantity(plan.repos));
  if (target >= plan.billing.quantity) return undefined;
  await setQuantity(deps, accountId, target);
  return { from: plan.billing.quantity, to: target };
}

function periodEnd(subscription: Stripe.Subscription): Date | null {
  const item = subscription.items.data[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
  const legacy = (subscription as unknown as { current_period_end?: number }).current_period_end;
  const end = item?.current_period_end ?? legacy;
  return end ? new Date(end * 1000) : null;
}

/** Store a subscription's state on the account it belongs to (from metadata, or the customer). */
export async function applySubscription(db: Db, subscription: Stripe.Subscription): Promise<string | undefined> {
  const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  return withService(db, async (tx) => {
    const byCustomer = await tx.selectFrom("billing").select("account_id").where("stripe_customer_id", "=", customer).executeTakeFirst();
    const accountId = subscription.metadata?.shapi_account_id ?? byCustomer?.account_id;
    if (!accountId || !/^\d+$/.test(accountId)) return undefined;
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
    return accountId;
  });
}

/**
 * Apply one verified Stripe webhook event, once (Stripe redelivers until it gets a 2xx). Returns
 * what changed, for the log.
 */
export async function handleStripeEvent(deps: BillingDeps, event: Stripe.Event): Promise<string> {
  const fresh = await withService(deps.db, (tx) =>
    tx.insertInto("stripe_events").values({ id: event.id, type: event.type }).onConflict((oc) => oc.column("id").doNothing()).returning("id").executeTakeFirst(),
  );
  if (!fresh) return "duplicate";
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (!subscriptionId) return "ignored: no subscription";
        const accountId = await applySubscription(deps.db, await deps.stripe.subscriptions.retrieve(subscriptionId));
        return accountId ? `subscription started for account ${accountId}` : "ignored: unknown account";
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const accountId = await applySubscription(deps.db, event.data.object);
        return accountId ? `subscription ${event.data.object.status} for account ${accountId}` : "ignored: unknown account";
      }
      default:
        return `ignored: ${event.type}`;
    }
  } catch (err) {
    // Let Stripe redeliver: forget the event so the retry is processed.
    await withService(deps.db, (tx) => tx.deleteFrom("stripe_events").where("id", "=", event.id).execute());
    throw err;
  }
}
