import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deprecatedShapeRules, lintSource, loadAdvisories, type Advisory } from "@shapi/core";

// Execution plan S-06: the deprecated-shape lint.
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));
const rules = deprecatedShapeRules(advisories);

describe("deprecated-shape lint (S-06)", () => {
  it("takes retired model ids, renamed fields and renamed enum values from verified advisories only", () => {
    expect(rules.some((r) => r.kind === "model" && r.name === "claude-sonnet-4-5" && r.advisoryId === "anthropic-claude-sonnet-4-5-retirement")).toBe(true);
    for (const r of rules) expect(advisories.find((a) => a.id === r.advisoryId)!.status).toBe("verified");
    const draft = { ...advisories.find((a) => a.id === "anthropic-claude-sonnet-4-5-retirement")!, id: "draft", status: "unverified" } as Advisory;
    expect(deprecatedShapeRules([draft])).toEqual([]);
    // Each name once, even when several advisories retire it.
    expect(new Set(rules.map((r) => `${r.kind}:${r.name}`)).size).toBe(rules.length);
  });

  it("keeps field rules to distinctive names: snake_case, camelCase or 8+ characters", () => {
    const base = advisories.find((a) => a.fix)!;
    const withFields = (from: string) => ({ ...base, status: "verified", fix: { fields: [{ from, to: "x" }] } }) as Advisory;
    expect(deprecatedShapeRules([withFields("id")])).toEqual([]);
    expect(deprecatedShapeRules([withFields("status")])).toEqual([]);
    expect(deprecatedShapeRules([withFields("tax_exempt")]).map((r) => r.name)).toEqual(["tax_exempt"]);
    expect(deprecatedShapeRules([withFields("runUrl")]).map((r) => r.name)).toEqual(["runUrl"]);
  });

  it("finds a model id as a whole string literal, and a field only where it is read", () => {
    const own = [
      { kind: "model" as const, name: "gpt-4", advisoryId: "a", provider: "openai" },
      { kind: "field" as const, name: "tax_exempt", replacement: "tax_status", advisoryId: "b", provider: "stripe" },
    ];
    const text = [
      'const a = "gpt-4";',
      'const b = "gpt-4o"; // not the same model',
      "const c = `gpt-4`;",
      "if (customer.tax_exempt) {}",
      'const d = customer["tax_exempt"];',
      "const tax_exempt_note = 1; // a name, not a read",
    ].join("\n");
    expect(lintSource("src/a.ts", text, own).map((f) => `${f.line}:${f.column} ${f.name}`)).toEqual(["1:11 gpt-4", "3:11 gpt-4", "4:13 tax_exempt", "5:19 tax_exempt"]);
  });

  it("counts an enum value only in a file that names its field: plain words like hosted are everywhere", () => {
    const uiMode = rules.filter((r) => r.advisoryId === "stripe-checkout-session-ui-mode-values-renamed");
    expect(uiMode.map((r) => [r.name, r.field])).toEqual(expect.arrayContaining([["hosted", "ui_mode"], ["custom", "ui_mode"]]));
    // A credentials module whose own setting happens to be "hosted": not about Stripe Checkout (seen in a real repository).
    expect(lintSource("src/credentials.ts", 'if (mode === "hosted") return key;\nconst kind = "custom";', uiMode)).toEqual([]);
    const checkout = 'const session = await stripe.checkout.sessions.create({ ui_mode: "hosted" });\nif (session.ui_mode === "custom") {}';
    expect(lintSource("src/checkout.ts", checkout, uiMode).map((f) => `${f.line} ${f.name}`)).toEqual(["1 hosted", "2 custom"]);
    // camelCase code (uiMode) counts as naming the field too.
    expect(lintSource("src/ui.tsx", 'const uiMode = props.embedded ? "embedded" : "hosted";', uiMode).map((f) => f.name)).toEqual(["embedded", "hosted"]);
  });
});
