import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The 👍/👎 links in a fix PR (execution plan D-01). Each link names the repository and the advisory, signed with the
 * server's secret, so a click can be stored without a sign-in and nobody can forge one for another repository.
 * Nothing about who clicked is in the link or kept.
 */
export interface FeedbackTarget {
  repositoryId: string;
  advisoryId: string;
}

const PURPOSE = "shapi-pr-feedback:";

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(PURPOSE + payload).digest("base64url").slice(0, 32);
}

export function feedbackToken(secret: string, target: FeedbackTarget): string {
  const payload = Buffer.from(JSON.stringify({ r: target.repositoryId, a: target.advisoryId })).toString("base64url");
  return `${payload}.${sign(secret, payload)}`;
}

/** The 👍 and 👎 URLs on the web app (`/feedback?t=…&v=up|down`). */
export function feedbackLinks(publicUrl: string, secret: string, target: FeedbackTarget): { up: string; down: string } {
  const base = `${publicUrl.replace(/\/+$/, "")}/feedback?t=${feedbackToken(secret, target)}`;
  return { up: `${base}&v=up`, down: `${base}&v=down` };
}

/** The target a token names, or undefined when it is malformed or its signature is wrong. */
export function readFeedbackToken(secret: string, token: string): FeedbackTarget | undefined {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return undefined;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const { r, a } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { r?: unknown; a?: unknown };
    if (typeof r !== "string" || !/^\d+$/.test(r) || typeof a !== "string" || !/^[a-z0-9-]+$/.test(a)) return undefined;
    return { repositoryId: r, advisoryId: a };
  } catch {
    return undefined;
  }
}
