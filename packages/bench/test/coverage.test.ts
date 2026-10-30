import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getProvider, loadAdvisories, type Advisory } from "@shapi/core";
import { methodsTouched, stripeCoverage, type ChangelogEntry } from "@shapi/bench";

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
