import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { handleStripeEvent, type BillingDeps } from "./stripe";

/**
 * POST /stripe/webhook: verify Stripe's signature on the raw body, apply the event once, and answer
 * 2xx. A failure answers 500 so Stripe redelivers (it retries for up to three days).
 */
export function stripeWebhookRoutes(app: FastifyInstance, deps: { billing?: BillingDeps }): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    scope.post("/stripe/webhook", async (req, reply) => {
      const billing = deps.billing;
      if (!billing) return reply.code(503).send({ ok: false, error: "billing not configured" });
      const signature = req.headers["stripe-signature"];
      let event: Stripe.Event;
      try {
        event = billing.stripe.webhooks.constructEvent(req.body as Buffer, String(signature ?? ""), billing.config.webhookSecret);
      } catch {
        return reply.code(400).send({ ok: false, error: "invalid signature" });
      }
      const outcome = await handleStripeEvent(billing, event);
      req.log.info({ event: event.type, id: event.id, outcome }, "stripe event");
      return reply.send({ ok: true, outcome });
    });
  });
}
