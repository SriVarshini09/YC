/**
 * How many cards of `width` (with their gap) fit around a ring of `radius` side by side, at most `max`.
 * The landing page's ring of API changes shows only that many, so neighbours never overlap on a phone.
 */
export const ringSlots = (radius: number, width: number, max: number) => Math.max(3, Math.min(max, Math.floor((2 * Math.PI * radius) / width)));
