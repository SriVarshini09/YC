import { readFileSync } from "node:fs";
import path from "node:path";
import { defineLoader } from "vitepress";

// Build-time data from the advisories bundled in this repository (the same set the CLI ships and
// the public shapi-advisories repository holds), so the pages never quote stale numbers.

export interface AdvisoryRow {
  id: string;
  provider: string;
  title: string;
  effectiveDate: string;
  severity: string;
  /** What changed: status-code, version-sunset, auth, required-field and so on. */
  changeClass: string;
  status: string;
  fix: boolean;
  url: string;
}

export interface AdvisoryData {
  total: number;
  verified: number;
  withFix: number;
  providers: string[];
  /** Soonest first. */
  all: AdvisoryRow[];
  /** The build date. Pages that count days from "today" start from it and move to the visitor's date in the browser. */
  builtOn: string;
}

declare const data: AdvisoryData;
export { data };

const NAMES: Record<string, string> = {
  anthropic: "Anthropic", github: "GitHub", google: "Google", "google-gemini": "Gemini", hubspot: "HubSpot",
  "meta-graph": "Meta", openai: "OpenAI", quickbooks: "QuickBooks", reddit: "Reddit", salesforce: "Salesforce",
  shopify: "Shopify", slack: "Slack", stripe: "Stripe", twilio: "Twilio", x: "X", xero: "Xero",
};

export default defineLoader({
  watch: ["../../advisories/*.json"],
  load(files: string[]): AdvisoryData {
    const all = files
      .map((file) => JSON.parse(readFileSync(file, "utf8")) as { id: string; provider: string; title: string; effectiveDate: string; severity: string; changeClass?: string; status: string; fix?: unknown; recipeId?: string })
      .map((a) => ({
        id: a.id,
        provider: NAMES[a.provider] ?? a.provider,
        title: a.title,
        effectiveDate: a.effectiveDate,
        severity: a.severity,
        changeClass: a.changeClass ?? "",
        status: a.status,
        fix: Boolean(a.fix || a.recipeId),
        url: `https://github.com/SriVarshini09/shapi-advisories/blob/main/advisories/${path.basename(`${a.id}.json`)}`,
      }))
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id));
    return {
      total: all.length,
      verified: all.filter((a) => a.status === "verified").length,
      withFix: all.filter((a) => a.fix).length,
      providers: [...new Set(all.map((a) => a.provider))].sort(),
      all,
      builtOn: new Date().toISOString().slice(0, 10),
    };
  },
});
