import type { Probe, Worker } from "../probe";

const API = "https://api.stripe.com";

/** Stripe canary, test mode only: SHAPI_STRIPE_TEST_KEY must be a sk_test_ or rk_test_ key. */
export const stripeWorker: Worker = {
  provider: "stripe",
  probes(env) {
    const key = env.SHAPI_STRIPE_TEST_KEY;
    const ids = ["get-balance", "list-customers", "list-payment-intents"];
    if (!key) {
      return { probes: [], skipped: ids.map((id) => ({ id: `stripe:${id}`, reason: "needs SHAPI_STRIPE_TEST_KEY (test mode)" })) };
    }
    if (!/^(sk|rk)_test_/.test(key)) throw new Error("SHAPI_STRIPE_TEST_KEY must be a test-mode key (sk_test_ or rk_test_)");

    const headers = { Authorization: `Bearer ${key}`, "User-Agent": "shapi-canary" };
    const get = (id: string, endpoint: string, path: string): Probe => ({
      id: `stripe:${id}`,
      provider: "stripe",
      method: "GET",
      endpoint,
      url: `${API}${path}`,
      headers,
    });
    return {
      probes: [
        get("get-balance", "/v1/balance", "/v1/balance"),
        get("list-customers", "/v1/customers", "/v1/customers?limit=3"),
        get("list-payment-intents", "/v1/payment_intents", "/v1/payment_intents?limit=3"),
      ],
      skipped: [],
    };
  },
};
