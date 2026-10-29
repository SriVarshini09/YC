import type { FastifyInstance } from "fastify";
import type { Db } from "@shapi/db";
import { verifyWebhookSignature } from "@shapi/github-app";

/** GitHub caps webhook payloads at 25 MB. */
const MAX_PAYLOAD = 25 * 1024 * 1024;

export interface WebhookDeps {
  db: Db;
  /** Unset until the GitHub App is configured; the route then answers 503. */
  secret?: string;
  /** Queue the delivery for the worker. If this fails the delivery is still stored, and the sweeper queues it. */
  enqueue(deliveryId: string): Promise<void>;
}

/**
 * The payload as jsonb accepts it. Postgres rejects a \u0000 escape in jsonb, and a delivery that cannot be
 * stored would fail on every redelivery too: NUL characters (in a commit message, say) become U+FFFD.
 */
export function storable(text: string, payload: unknown): string {
  if (!text.includes("\\u0000")) return text;
  return JSON.stringify(payload, (_key, value: unknown) => (typeof value === "string" ? value.replace(/\0/g, "�") : value));
}

/**
 * POST /github/webhook: verify the signature on the raw body, store the delivery once (keyed by
 * X-GitHub-Delivery, so redeliveries are no-ops), queue it, and answer fast. GitHub gives up after
 * 10 seconds and never retries on its own, so all real work happens in the worker.
 */
export function webhookRoutes(app: FastifyInstance, deps: WebhookDeps): void {
  void app.register(async (scope) => {
    // Raw bytes for this route only: the signature covers the exact body GitHub sent.
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: MAX_PAYLOAD }, (_req, body, done) => done(null, body));

    scope.post("/github/webhook", { bodyLimit: MAX_PAYLOAD }, async (req, reply) => {
      if (!deps.secret) return reply.code(503).send({ ok: false, error: "github app not configured" });
      const body = req.body;
      if (!Buffer.isBuffer(body)) return reply.code(415).send({ ok: false, error: "expected application/json" });
      if (!verifyWebhookSignature(deps.secret, body, req.headers["x-hub-signature-256"] as string | undefined)) {
        return reply.code(401).send({ ok: false, error: "invalid signature" });
      }
      const event = req.headers["x-github-event"];
      const deliveryId = req.headers["x-github-delivery"];
      if (typeof event !== "string" || typeof deliveryId !== "string" || !deliveryId) {
        return reply.code(400).send({ ok: false, error: "missing X-GitHub-Event or X-GitHub-Delivery" });
      }
      let payload: { action?: unknown; installation?: { id?: unknown } };
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        return reply.code(400).send({ ok: false, error: "invalid JSON" });
      }

      const installationId = typeof payload.installation?.id === "number" ? payload.installation.id : null;
      const inserted = await deps.db
        .insertInto("webhook_deliveries")
        .values({
          delivery_id: deliveryId,
          event,
          action: typeof payload.action === "string" ? payload.action : null,
          installation_id: installationId,
          payload: storable(body.toString("utf8"), payload),
        })
        .onConflict((oc) => oc.column("delivery_id").doNothing())
        .returning("delivery_id")
        .executeTakeFirst();
      if (!inserted) return reply.code(202).send({ ok: true, duplicate: true });

      try {
        await deps.enqueue(deliveryId);
      } catch (err) {
        req.log.error({ err, deliveryId }, "could not queue webhook delivery; the sweeper will");
      }
      return reply.code(202).send({ ok: true });
    });
  });
}
