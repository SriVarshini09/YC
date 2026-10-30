import { describe, expect, it } from "vitest";
import { AdvisorySchema } from "@shapi/core";
import { changeMatchesRow, diffSpecs, draftAdvisory, operationsReturning, parseEntryChanges, parseReleasePage, previewOnly, resourceKey, scoreRelease, type ChangelogEntry } from "@shapi/bench";

// Execution plan P-08: spec-history replay. Two tiny versions of a Stripe-shaped spec.
const form = (props: Record<string, unknown>, required: string[] = []) => ({ content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties: props, required } } } });
const ok = (ref: string) => ({ "200": { content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } } } });
const before = {
  info: { version: "2025-09-30.clover" },
  paths: {
    "/v1/payment_intents": { post: { requestBody: form({ amount: { type: "integer" }, payment_method_types: { type: "array" }, capture_method: { type: "string", enum: ["automatic", "manual", "automatic_async"] } }), responses: ok("payment_intent") } },
    "/v1/payment_intents/{intent}": { get: { responses: ok("payment_intent") } },
    "/v1/sources": { get: { responses: ok("source") } },
  },
  components: {
    schemas: {
      payment_intent: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["succeeded", "processing", "requires_capture"] }, charges: { type: "object" }, next_action: { type: "object", properties: { redirect_url: { type: "string" } } } } },
      source: { type: "object", properties: { id: { type: "string" } } },
    },
  },
};
const after = {
  info: { version: "2026-03-25.dahlia" },
  paths: {
    "/v1/payment_intents": { post: { requestBody: form({ amount: { type: "integer" }, currency: { type: "string" }, capture_method: { type: "string", enum: ["automatic", "manual"] } }, ["currency"]), responses: ok("payment_intent") } },
    "/v1/payment_intents/{intent}": { get: { responses: ok("payment_intent") } },
  },
  components: {
    schemas: {
      payment_intent: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["succeeded", "processing"] }, charges: { type: "string", nullable: true }, next_action: { type: "object", properties: {} } } },
    },
  },
};

describe("spec-history replay (P-08)", () => {
  it("finds what a client could trip over between two versions of a spec", () => {
    const changes = diffSpecs(before as never, after as never);
    expect(changes.map((c) => `${c.kind} ${c.operation ?? c.schema} ${c.field ?? ""} ${c.values?.join(",") ?? ""}`.trim())).toEqual([
      "parameter-removed POST /v1/payment_intents payment_method_types",
      "enum-value-removed POST /v1/payment_intents capture_method automatic_async",
      "parameter-required POST /v1/payment_intents currency",
      "operation-removed GET /v1/sources",
      "enum-value-removed payment_intent status requires_capture",
      "property-type-changed payment_intent charges",
      "property-removed payment_intent next_action.redirect_url",
      "schema-removed source",
    ]);
  });

  it("maps each change to a change class, and drafts it as a valid unverified advisory", () => {
    const changes = diffSpecs(before as never, after as never);
    const returning = operationsReturning(before as never);
    expect(returning.get("payment_intent")).toEqual(["POST /v1/payment_intents", "GET /v1/payment_intents/{intent}"]);
    const drafts = changes.map((c) => draftAdvisory(c, { provider: "stripe", version: "2026-03-25.dahlia", returning, sources: ["https://github.com/stripe/openapi"] }));
    for (const d of drafts) expect(AdvisorySchema.parse(d)).toEqual(d);
    expect(new Set(drafts.map((d) => d.status))).toEqual(new Set(["unverified"]));
    const removedParam = drafts.find((d) => d.trigger.body?.[0]?.field === "payment_method_types")!;
    expect(removedParam).toMatchObject({ changeClass: "required-field", endpoint: { method: "POST", path: "/v1/payment_intents" }, effectiveDate: "2026-03-25" });
    const status = drafts.find((d) => d.trigger.enums?.[0]?.field === "status")!;
    expect(status).toMatchObject({ changeClass: "enum-added", endpoint: { method: "*", path: "/v1/payment_intents/**" }, trigger: { enums: [{ field: "status", values: ["requires_capture"] }] } });
  });

  it("reads a release page's Breaking and Non-breaking rows, and an entry's REST API table", () => {
    const page = [
      "| Title | Affected Products | Breaking change? | Category |",
      "| --- | --- | --- | --- |",
      "| [Removes support for specifying payment method types](https://docs.stripe.com/changelog/dahlia/2026-03-25/removes-payment-method-types.md) | Payments | Breaking | api |",
      "| [Adds a funding source identifier](https://docs.stripe.com/changelog/dahlia/2026-08-26/adds-funding.md) | Payments | Non-breaking | api |",
    ].join("\n");
    expect(parseReleasePage(page)).toEqual([
      { title: "Removes support for specifying payment method types", url: "https://docs.stripe.com/changelog/dahlia/2026-03-25/removes-payment-method-types.md", date: "2026-03-25", breaking: true, category: "api" },
      { title: "Adds a funding source identifier", url: "https://docs.stripe.com/changelog/dahlia/2026-08-26/adds-funding.md", date: "2026-08-26", breaking: false, category: "api" },
    ]);
    const entry = [
      "## Changes",
      "",
      "#### REST API",
      "",
      "| Parameter | Change | Resources or endpoints |",
      "| --- | --- | --- |",
      "| `payment_method_types` | Removed | [PaymentIntent#confirm](/api/x), [PaymentIntent#create](/api/y), [SetupIntent#create](/api/z) |",
      "",
      "#### Ruby",
      "",
      "| `payment_method_types` | Removed | [PaymentIntentCreateParams](/api/y) |",
    ].join("\n");
    expect(parseEntryChanges(entry)).toEqual([{ field: "payment_method_types", change: "Removed", resources: ["PaymentIntent#confirm", "PaymentIntent#create", "SetupIntent#create"] }]);
    expect(parseEntryChanges("## What's new\n\nA behavior change.")).toEqual([]);
    // The two other table shapes: a field path holding its resource, and enum values with the field in the link anchor.
    const shapes = [
      "## Changes",
      "",
      "#### REST API",
      "",
      "| Fields | Change | From → to |",
      "| --- | --- | --- |",
      "| `Issuing.Token.network_data.visa.card_reference_id` | Changed | `string → nullable(string)` |",
      "| `Issuing.Card.wallets.apple_pay`, `Issuing.Card.wallets.google_pay` | Removed | |",
      "",
      "| Value | Change | Enums |",
      "| --- | --- | --- |",
      "| `custom`, `embedded`, `hosted` | Removed | [Checkout.Session#create](/api/checkout/sessions/create#create_checkout_session-ui_mode) |",
      "",
      "## Upgrade",
    ].join("\n");
    expect(parseEntryChanges(shapes)).toEqual([
      { field: "network_data.visa.card_reference_id", change: "Changed", resources: ["Issuing.Token"] },
      { field: "wallets.apple_pay", change: "Removed", resources: ["Issuing.Card"] },
      { field: "wallets.google_pay", change: "Removed", resources: ["Issuing.Card"] },
      { field: "ui_mode", change: "Removed", resources: ["Checkout.Session#create"], values: ["custom", "embedded", "hosted"] },
    ]);
  });

  it("matches a spec change to a changelog row by field and resource", () => {
    expect(resourceKey("PaymentIntent#create")).toBe("payment_intent");
    const row = { field: "payment_method_types", change: "Removed", resources: ["PaymentIntent#create"] };
    expect(changeMatchesRow({ kind: "parameter-removed", changeClass: "required-field", operation: "POST /v1/payment_intents", field: "payment_method_types", detail: "" }, row)).toBe(true);
    expect(changeMatchesRow({ kind: "property-removed", changeClass: "field-rename", schema: "payment_intent", field: "payment_method_types", detail: "" }, row)).toBe(true);
    expect(changeMatchesRow({ kind: "parameter-removed", changeClass: "required-field", operation: "POST /v1/charges", field: "payment_method_types", detail: "" }, row)).toBe(false);
    expect(changeMatchesRow({ kind: "parameter-removed", changeClass: "required-field", operation: "POST /v1/payment_intents", field: "amount", detail: "" }, row)).toBe(false);
  });

  it("scores recall against GA breaking rows, false positives against non-breaking rows, and behavior-only rows", () => {
    const changes = diffSpecs(before as never, after as never);
    const entry = (title: string, breaking: boolean, rest: ChangelogEntry["rest"], date = "2026-03-25", category = "api"): ChangelogEntry => ({ title, url: `https://docs.stripe.com/changelog/dahlia/${date}/${title}.md`, date, breaking, category, rest });
    const score = scoreRelease({
      release: "dahlia",
      version: "2026-03-25.dahlia",
      before: { sha: "a", version: "2025-09-30.clover" },
      after: { sha: "b", version: "2026-03-25.dahlia" },
      changes,
      entries: [
        entry("found", true, [{ field: "payment_method_types", change: "Removed", resources: ["PaymentIntent#create"] }]),
        entry("behavior", true, []),
        entry("missed", true, [{ field: "unknown_field", change: "Removed", resources: ["Charge"] }]),
        entry("additive", false, [{ field: "status", change: "Changed", resources: ["PaymentIntent"] }]),
        entry("preview", true, [{ field: "amount", change: "Removed", resources: ["PaymentIntent#create"] }], "2026-08-26"),
        entry("stripejs", true, [], "2026-03-25", "stripejs"),
        { ...entry("preview-api", true, [{ field: "destination", change: "Added", resources: ["Reserve.Plan"] }]), preview: true },
        entry("v2", true, [{ field: "configurations", change: "Removed", resources: ["v2.core.AccountLink#create"] }]),
      ],
    });
    expect(score).toMatchObject({ breakingEntries: 5, clientOnly: 1, breakingFound: 1, behaviorOnly: 1, outsideSpec: 1, previewOnly: 1, breakingMissed: 1, candidatesMatchingBreaking: 1, candidatesMatchingNonBreaking: 1, nonBreakingEntriesMatched: 1 });
    expect(score.missed.map((m) => m.reason)).toEqual(["no REST field change listed: a behavior change", "no spec change matches unknown_field (Removed)", "a preview API, which the GA spec does not carry", "a v2 API, which stripe/openapi does not publish"]);
    expect(previewOnly("[x](/api/reserve/plans?api-version=2026-09-30.preview#a) [y](/api/b?api-version=2026-09-30.preview)")).toBe(true);
    expect(previewOnly("[x](/api/a?api-version=2026-09-30.preview) [y](/api/b?api-version=2026-09-30.endive)")).toBe(false);
    expect(previewOnly("A behavior change.")).toBe(false);
  });
});
