import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApiLock, getProvider, loadAdvisories, matchAdvisories, type Advisory, type CallSite } from "@shapi/core";
import { methodsTouched, parseShopifyFeed, shopifyCoverage, stripeCoverage, type ChangelogEntry } from "@shapi/bench";

// Execution plan C-05: every Stripe breaking entry that touches a mapped method has an advisory, or is exempt.
const sdkMethods = getProvider("stripe")!.sdkMethods!;
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));
const entry = (title: string, rest: ChangelogEntry["rest"], over: Partial<ChangelogEntry> = {}): ChangelogEntry => ({
  title,
  url: `https://docs.stripe.com/changelog/endive/2026-09-30/${title.toLowerCase().replace(/ /g, "-")}.md`,
  date: "2026-09-30",
  breaking: true,
  category: "api",
  rest,
  ...over,
});

describe("Stripe advisory coverage (C-05)", () => {
  it("maps a changelog resource to the SDK methods SHAPI knows", () => {
    expect(methodsTouched([{ field: "payment_method_types", change: "Removed", resources: ["PaymentIntent#create", "SetupIntent#create"] }], sdkMethods)).toEqual(["paymentIntents.create"]);
    expect(methodsTouched([{ field: "ui_mode", change: "Removed", resources: ["Checkout.Session#create"] }], sdkMethods)).toEqual(["checkout.sessions.create"]);
    // An object-level row touches every mapped method of the resource.
    expect(methodsTouched([{ field: "trial_settings.end_behavior", change: "Changed", resources: ["Subscription"] }], sdkMethods)).toEqual(["subscriptions.create", "subscriptions.update"]);
    expect(methodsTouched([{ field: "x", change: "Removed", resources: ["Issuing.Card#create"] }], sdkMethods)).toEqual([]);
  });

  it("counts an entry covered when an advisory cites it, exempt when it is preview-only, and a gap otherwise", () => {
    const cited = entry("Removes the payment method types parameter from Checkout Sessions", [{ field: "payment_method_types", change: "Removed", resources: ["Checkout.Session#create"] }], {
      url: "https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions.md",
    });
    const preview = entry("Preview only", [{ field: "x", change: "Removed", resources: ["Subscription#create"] }], { preview: true });
    const missing = entry("Not written up", [{ field: "y", change: "Removed", resources: ["Refund#create"] }]);
    const untouched = entry("Unmapped resource", [{ field: "z", change: "Removed", resources: ["Issuing.Card#create"] }]);
    const nonBreaking = entry("Additive", [{ field: "w", change: "Added", resources: ["Refund#create"] }], { breaking: false });
    const exempted = entry("Exempted by hand", [{ field: "v", change: "Removed", resources: ["Invoice#create"] }]);
    const { rows, gaps } = stripeCoverage({
      releases: [{ release: "endive", entries: [cited, preview, missing, untouched, nonBreaking, exempted] }],
      advisories,
      sdkMethods,
      exemptions: { [exempted.url.replace(/\.md$/, "")]: "explained elsewhere" },
    });
    expect(rows.map((r) => r.title)).toEqual(["Removes the payment method types parameter from Checkout Sessions", "Preview only", "Not written up", "Exempted by hand"]);
    expect(rows[0]!.advisories).toEqual(["stripe-endive-checkout-session-payment-method-types-removed"]);
    expect(rows[1]!.exempt).toMatch(/^a preview API/);
    expect(gaps.map((g) => g.title)).toEqual(["Not written up"]);
  });

  it("the new Stripe advisories are unverified, so they never open a PR until checked (C-03)", () => {
    const ids = ["stripe-endive-checkout-session-payment-method-types-removed", "stripe-endive-payment-intent-payment-method-types-removed", "stripe-endive-setup-intent-payment-method-types-removed", "stripe-endive-billing-cycle-anchor-object"];
    for (const id of ids) expect((advisories.find((a) => a.id === id) as Advisory).status, id).toBe("unverified");
  });
});

describe("Shopify advisory coverage (C-06)", () => {
  const feed = `<rss><channel>
  <item><title>The &lt;code&gt;automaticDiscounts&lt;/code&gt; query is removed</title><link>https://shopify.dev/changelog/automaticdiscounts-query-is-removed-in-api-version-2027-01</link><pubDate>Fri, 18 Sep 2026 14:00:00 +0000</pubDate><category>API</category><category>Breaking API Change</category><category>GraphQL Admin API</category></item>
  <item><title>Expiring tokens</title><link>https://shopify.dev/changelog/expiring-offline-access-tokens-required-for-all-public-apps-as-of-january-1-2027</link><pubDate>Wed, 20 May 2026 14:00:00 +0000</pubDate><category>Breaking API Change</category><category>Admin REST API</category></item>
  <item><title>Storefront only</title><link>https://shopify.dev/changelog/storefront-thing</link><pubDate>Wed, 20 May 2026 14:00:00 +0000</pubDate><category>Breaking API Change</category><category>Storefront API</category></item>
  <item><title>Too old</title><link>https://shopify.dev/changelog/old</link><pubDate>Wed, 20 Nov 2025 14:00:00 +0000</pubDate><category>Breaking API Change</category><category>GraphQL Admin API</category></item>
  <item><title>Not breaking</title><link>https://shopify.dev/changelog/new</link><pubDate>Wed, 20 May 2026 14:00:00 +0000</pubDate><category>New</category><category>GraphQL Admin API</category></item>
  <item><title>Uncovered</title><link>https://shopify.dev/changelog/uncovered</link><pubDate>Wed, 20 May 2026 14:00:00 +0000</pubDate><category>Breaking API Change</category><category>GraphQL Admin API</category></item>
  <item><title>Exempted</title><link>https://shopify.dev/changelog/exempted</link><pubDate>Wed, 20 May 2026 14:00:00 +0000</pubDate><category>Breaking API Change</category><category>GraphQL Admin API</category></item>
  </channel></rss>`;

  it("reads the feed's titles, links, days and categories", () => {
    const entries = parseShopifyFeed(feed);
    expect(entries).toHaveLength(7);
    expect(entries[0]).toEqual({ title: "The <code>automaticDiscounts</code> query is removed", url: "https://shopify.dev/changelog/automaticdiscounts-query-is-removed-in-api-version-2027-01", date: "2026-09-18", categories: ["API", "Breaking API Change", "GraphQL Admin API"] });
  });

  it("counts breaking Admin API entries since the cutoff: covered (either changelog URL form), exempt, or a gap", () => {
    const { rows, gaps } = shopifyCoverage({ entries: parseShopifyFeed(feed), since: "2026-01-01", advisories, exemptions: { "https://shopify.dev/changelog/exempted": "explained" } });
    expect(rows.map((r) => r.title)).toEqual(["The <code>automaticDiscounts</code> query is removed", "Expiring tokens", "Uncovered", "Exempted"]);
    expect(rows[0]!.advisories).toEqual(["shopify-automatic-discounts-query-removed"]);
    // That advisory cites /changelog/posts/<slug>; the feed links /changelog/<slug>.
    expect(rows[1]!.advisories).toEqual(["shopify-non-expiring-offline-tokens-rejected"]);
    expect(gaps.map((g) => g.title)).toEqual(["Uncovered"]);
  });

  it("the new Shopify GraphQL advisories flag the calls that use what changed, and only those", () => {
    const empty = { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] };
    const site = (line: number, query: string): CallSite => ({ file: "app/routes/app._index.tsx", line, column: 1, provider: "shopify", kind: "sdk", client: "admin.graphql", method: "POST", host: null, endpoint: "/admin/api/{version}/graphql.json", resolved: true, surface: { ...empty, body: [{ name: "query", value: query }] } });
    const lock = createApiLock(
      {
        callSites: [
          site(1, "query { automaticDiscounts(first: 5) { nodes { id } } }"),
          site(2, "mutation { draftOrderCalculate(input: $i) { calculatedDraftOrder { warnings { ... on DraftOrderDiscountNotAppliedWarning { priceRule { title } } } } } }"),
          site(3, "mutation { collectionCreate(input: { ruleSet: { rules: [{ metafieldInteger: { value: 5 } }] } }) { collection { id } } }"),
          site(4, "query { shop { name } }"),
        ],
        declared: [],
      },
      "t",
    );
    const shopify = advisories.filter((a) => a.provider === "shopify" && a.trigger.graphql);
    const { affected } = matchAdvisories(lock, shopify, { now: new Date("2026-10-30") });
    expect(affected.map((f) => `${f.callSite.line} ${f.advisory.id}`).sort()).toEqual([
      "1 shopify-automatic-discounts-query-removed",
      "2 shopify-draft-order-warning-price-rule-removed",
      "3 shopify-collection-metafield-integer-condition-removed",
    ]);
  });
});
