/**
 * Advisory coverage of Stripe's breaking changes (execution plan C-05): every GA "Breaking" row of a release that
 * touches a Stripe method SHAPI maps (providers.json `sdkMethods`) must have an advisory that cites it, or an
 * exemption that says why not. Entries about preview APIs only (every link is to the `.preview` API version) are exempt:
 * the GA API doesn't change, as in the spec replay (P-08).
 */
import type { Advisory } from "@shapi/core";
import type { ChangelogEntry, ChangelogRow } from "./spec-replay";

/** `paymentIntents.create` → `payment_intent`; `checkout.sessions.create` → `checkout.session`. */
const namespaceKey = (method: string) =>
  method
    .split(".")
    .slice(0, -1)
    .map((p) => p.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/s$/, ""))
    .join(".");

/** `PaymentIntent#create` → `payment_intent`, `create`; `Checkout.Session` → `checkout.session`. */
const resourceParts = (resource: string) => {
  const [object, verb] = resource.split("#") as [string, string | undefined];
  return { key: object.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(), verb: verb?.split(".")[0] };
};

/**
 * The mapped methods a changelog entry touches: a row on `Resource#method` touches that method; a row on the object
 * (`Subscription.trial_settings…`) touches every mapped method of the resource, since they all return it.
 */
export function methodsTouched(rows: ChangelogRow[], sdkMethods: Record<string, string>): string[] {
  const touched = new Set<string>();
  for (const row of rows) {
    for (const resource of row.resources) {
      const { key, verb } = resourceParts(resource);
      for (const method of Object.keys(sdkMethods)) {
        if (namespaceKey(method) === key && (!verb || method.endsWith(`.${verb}`))) touched.add(method);
      }
    }
  }
  return [...touched].sort();
}

const pageUrl = (url: string) => url.replace(/\.md$/, "").replace(/\/$/, "");

export interface CoverageRow {
  release: string;
  title: string;
  url: string;
  methods: string[];
  /** Advisories whose sources cite the entry. */
  advisories: string[];
  /** Why the entry needs no advisory, when it doesn't have one. */
  exempt?: string;
}

export function stripeCoverage(input: {
  releases: { release: string; entries: ChangelogEntry[] }[];
  advisories: Advisory[];
  sdkMethods: Record<string, string>;
  exemptions: Record<string, string>;
}): { rows: CoverageRow[]; gaps: CoverageRow[] } {
  const rows: CoverageRow[] = [];
  for (const { release, entries } of input.releases) {
    for (const e of entries.filter((x) => x.breaking && x.category === "api")) {
      const methods = methodsTouched(e.rest, input.sdkMethods);
      if (!methods.length) continue;
      const url = pageUrl(e.url);
      const advisories = input.advisories.filter((a) => a.provider === "stripe" && a.sources.some((s) => pageUrl(s) === url)).map((a) => a.id);
      const exempt = advisories.length ? undefined : e.preview ? "a preview API: every link is to the preview API version, so the GA API doesn't change" : input.exemptions[url];
      rows.push({ release, title: e.title, url, methods, advisories, ...(exempt ? { exempt } : {}) });
    }
  }
  return { rows, gaps: rows.filter((r) => !r.advisories.length && !r.exempt) };
}

/* ---------- Shopify (C-06) ---------- */

export interface ShopifyFeedEntry {
  title: string;
  url: string;
  date: string;
  categories: string[];
}

const xmlText = (s: string) =>
  s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

/** The items of shopify.dev's changelog RSS feed: title, link, day and categories. */
export function parseShopifyFeed(xml: string): ShopifyFeedEntry[] {
  return xml
    .split("<item>")
    .slice(1)
    .map((item) => ({
      title: xmlText(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1] ?? ""),
      url: xmlText(/<link>([\s\S]*?)<\/link>/.exec(item)?.[1] ?? ""),
      date: new Date(/<pubDate>([^<]*)<\/pubDate>/.exec(item)?.[1] ?? "").toISOString().slice(0, 10),
      categories: [...item.matchAll(/<category>([\s\S]*?)<\/category>/g)].map((m) => xmlText(m[1]!)),
    }));
}

/** The Admin API surfaces C-06 covers. */
const ADMIN_APIS = ["GraphQL Admin API", "Admin REST API"];

/**
 * Every Shopify changelog entry tagged "Breaking API Change" since `since` that touches the Admin GraphQL or REST API
 * needs a Shopify advisory citing it (in its sources or published notice), or an exemption with a reason.
 */
export function shopifyCoverage(input: { entries: ShopifyFeedEntry[]; since: string; advisories: Advisory[]; exemptions: Record<string, string> }): { rows: CoverageRow[]; gaps: CoverageRow[] } {
  // shopify.dev serves each post at /changelog/<slug> and /changelog/posts/<slug>.
  const shopifyPage = (u: string) => pageUrl(u).replace("/changelog/posts/", "/changelog/");
  const cites = (a: Advisory) => [...a.sources, a.publishedNotice?.url ?? ""].map(shopifyPage);
  const rows = input.entries
    .filter((e) => e.categories.includes("Breaking API Change") && e.date >= input.since && e.categories.some((c) => ADMIN_APIS.includes(c)))
    .map((e): CoverageRow => {
      const url = shopifyPage(e.url);
      const advisories = input.advisories.filter((a) => a.provider === "shopify" && cites(a).includes(url)).map((a) => a.id);
      const exempt = advisories.length ? undefined : input.exemptions[url];
      return { release: e.date, title: e.title, url, methods: e.categories.filter((c) => ADMIN_APIS.includes(c)), advisories, ...(exempt ? { exempt } : {}) };
    });
  return { rows, gaps: rows.filter((r) => !r.advisories.length && !r.exempt) };
}
