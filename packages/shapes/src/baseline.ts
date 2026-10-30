import { shapeHash, type ResponseShape } from "./shape";

/**
 * The natural churn of an endpoint (execution plan CN-04): optional fields that come and go between responses (a
 * `discount` only some orders have, a `next_page` on all but the last page). They are not a change in the API, so
 * SHAPI learns them per endpoint from its recent history and leaves them out when it decides whether, and how, the
 * shape changed. A field removed for good flips once and stays gone, so it is still a change.
 */

/** How many recent observations of an endpoint the baseline is learned from. */
export const BASELINE_WINDOW = 24;
/** Presence flips (present to absent or back) that make a field churn rather than change. */
export const CHURN_FLIPS = 2;

const ok = (s: ResponseShape) => s.status >= 200 && s.status < 300 && s.body.kind === "json";

/** The path hashes of the fields that came and went at least `minFlips` times in `history` (oldest first), with their paths when known. */
export function churningFields(history: ResponseShape[], minFlips = CHURN_FLIPS): Map<string, string | undefined> {
  const successes = history.filter(ok);
  const paths = new Map<string, string | undefined>();
  for (const s of successes) for (const f of s.body.fields) if (!paths.has(f.pathHash) || f.path) paths.set(f.pathHash, f.path);
  const churn = new Map<string, string | undefined>();
  for (const [hash, path] of paths) {
    let flips = 0;
    let present: boolean | undefined;
    for (const s of successes) {
      const now = s.body.fields.some((f) => f.pathHash === hash);
      if (present !== undefined && now !== present) flips++;
      present = now;
    }
    if (flips >= minFlips) churn.set(hash, path);
  }
  return churn;
}

/** The shape without its endpoint's churning fields: what SHAPI compares between cycles. */
export function stableShape(shape: ResponseShape, churn: Map<string, unknown>): ResponseShape {
  if (!churn.size) return shape;
  return { ...shape, body: { ...shape.body, fields: shape.body.fields.filter((f) => !churn.has(f.pathHash)) } };
}

export const stableHash = (shape: ResponseShape, churn: Map<string, unknown>) => shapeHash(stableShape(shape, churn));
