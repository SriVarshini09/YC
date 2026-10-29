import { describe, expect, it } from "vitest";
import { aheadOf, daysUntil, inDays, isoDay } from "../.vitepress/theme/dates";

// The landing page is built once per deploy; these count from the visitor's date, not the build's.
describe("landing page dates", () => {
  const builtOn = "2026-10-29";
  const advisories = [
    { id: "a", effectiveDate: "2026-11-05" },
    { id: "b", effectiveDate: "2026-11-19" },
    { id: "c", effectiveDate: "2026-12-04" },
  ];

  it("drops a change that took effect between the build and the visit", () => {
    expect(aheadOf(advisories, builtOn).map((a) => a.id)).toEqual(["a", "b", "c"]);
    const visit = isoDay(Date.parse("2026-11-19T15:00:00Z"));
    expect(visit).toBe("2026-11-19");
    expect(aheadOf(advisories, visit).map((a) => a.id)).toEqual(["c"]);
  });

  it("counts days from the visit, not the build", () => {
    expect(daysUntil("2026-12-04", builtOn)).toBe(36);
    expect(daysUntil("2026-12-04", "2026-11-19")).toBe(15);
    expect(inDays("2026-12-04", "2026-11-19")).toBe("in 15 days");
    expect(inDays("2026-12-04", "2026-12-03")).toBe("tomorrow");
  });
});
