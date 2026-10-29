import { describe, expect, it } from "vitest";
import { ringSlots } from "../.vitepress/theme/ring";

// The landing page's ring of API changes: 220px cards, 226px with their gap.
describe("ring of API changes", () => {
  it("keeps every card on a wide screen", () => {
    expect(ringSlots(580, 226, 16)).toBe(16);
  });

  it("shows fewer cards on a smaller ring, so neighbours don't overlap", () => {
    // A phone (radius 260) used to hold 16 cards about 100px apart.
    const phone = ringSlots(260, 226, 16);
    expect(phone).toBe(7);
    expect((2 * Math.PI * 260) / phone).toBeGreaterThanOrEqual(226);
    // A 1024px screen: radius 430.
    expect(ringSlots(1024 * 0.42, 226, 16)).toBe(11);
  });

  it("never asks for more cards than there are, or fewer than three", () => {
    expect(ringSlots(580, 226, 5)).toBe(5);
    expect(ringSlots(50, 226, 16)).toBe(3);
  });
});
