import type { HttpMethod } from "@shapi/core";
import type { Env, Probe, Worker } from "../probe";

// Canaries for Slack, OpenAI, Anthropic, Twilio and HubSpot. Every probe is free and has no side
// effects beyond the provider's own test tooling: list and read calls, Slack's api.test, and a
// Twilio message from a magic test number with test credentials (nothing is sent or charged).

type Spec = { id: string; method?: HttpMethod; endpoint: string; url: string; body?: string; contentType?: string };

function probesFor(provider: string, auth: Probe["auth"], headers: Record<string, string>, specs: Spec[]): Probe[] {
  return specs.map((s) => ({
    id: `${provider}:${s.id}`,
    provider,
    method: s.method ?? "GET",
    endpoint: s.endpoint,
    url: s.url,
    headers: { "User-Agent": "shapi-canary", ...headers, ...(s.contentType ? { "Content-Type": s.contentType } : {}) },
    ...(s.body !== undefined ? { body: s.body } : {}),
    auth,
  }));
}

const skip = (provider: string, ids: string[], reason: string) => ids.map((id) => ({ id: `${provider}:${id}`, reason }));

/** Slack: api.test needs no token, so it always runs; the rest need SHAPI_SLACK_BOT_TOKEN (xoxb-, scope channels:read). */
export const slackWorker: Worker = {
  provider: "slack",
  probes(env: Env) {
    const api = "https://slack.com/api";
    const probes = probesFor("slack", "anonymous", {}, [{ id: "api-test", endpoint: "/api/api.test", url: `${api}/api.test` }]);
    const token = env.SHAPI_SLACK_BOT_TOKEN;
    const tokenIds = ["auth-test", "conversations-list"];
    if (!token) return { probes, skipped: skip("slack", tokenIds, "needs SHAPI_SLACK_BOT_TOKEN (a bot token, xoxb-)") };
    if (!token.startsWith("xoxb-")) throw new Error("SHAPI_SLACK_BOT_TOKEN must be a bot token (xoxb-)");
    probes.push(
      ...probesFor("slack", "token", { Authorization: `Bearer ${token}` }, [
        { id: "auth-test", endpoint: "/api/auth.test", url: `${api}/auth.test` },
        { id: "conversations-list", endpoint: "/api/conversations.list", url: `${api}/conversations.list?limit=1&exclude_archived=true` },
      ]),
    );
    return { probes, skipped: [] };
  },
};

/** OpenAI: listing models is free. Needs SHAPI_OPENAI_API_KEY. */
export const openaiWorker: Worker = {
  provider: "openai",
  probes(env: Env) {
    const key = env.SHAPI_OPENAI_API_KEY;
    if (!key) return { probes: [], skipped: skip("openai", ["list-models"], "needs SHAPI_OPENAI_API_KEY") };
    return {
      probes: probesFor("openai", "token", { Authorization: `Bearer ${key}` }, [
        { id: "list-models", endpoint: "/v1/models", url: "https://api.openai.com/v1/models" },
      ]),
      skipped: [],
    };
  },
};

/** Anthropic: listing models is free. Needs SHAPI_ANTHROPIC_API_KEY; pinned to anthropic-version 2023-06-01. */
export const anthropicWorker: Worker = {
  provider: "anthropic",
  probes(env: Env) {
    const key = env.SHAPI_ANTHROPIC_API_KEY;
    if (!key) return { probes: [], skipped: skip("anthropic", ["list-models"], "needs SHAPI_ANTHROPIC_API_KEY") };
    return {
      probes: probesFor("anthropic", "token", { "x-api-key": key, "anthropic-version": "2023-06-01" }, [
        { id: "list-models", endpoint: "/v1/models", url: "https://api.anthropic.com/v1/models?limit=20" },
      ]),
      skipped: [],
    };
  },
};

/**
 * Twilio, test credentials only (SHAPI_TWILIO_TEST_ACCOUNT_SID and SHAPI_TWILIO_TEST_AUTH_TOKEN, from
 * Console → API keys & tokens → Test credentials). It "sends" a message from Twilio's magic test number
 * +15005550006: with test credentials no message is delivered and nothing is charged.
 */
export const twilioWorker: Worker = {
  provider: "twilio",
  probes(env: Env) {
    const sid = env.SHAPI_TWILIO_TEST_ACCOUNT_SID;
    const token = env.SHAPI_TWILIO_TEST_AUTH_TOKEN;
    if (!sid || !token) {
      return { probes: [], skipped: skip("twilio", ["create-message"], "needs SHAPI_TWILIO_TEST_ACCOUNT_SID and SHAPI_TWILIO_TEST_AUTH_TOKEN (test credentials)") };
    }
    if (!/^AC[0-9a-f]{32}$/.test(sid)) throw new Error("SHAPI_TWILIO_TEST_ACCOUNT_SID must be an account SID (AC followed by 32 hex characters)");
    const basic = Buffer.from(`${sid}:${token}`).toString("base64");
    const body = new URLSearchParams({ From: "+15005550006", To: "+15005550006", Body: "SHAPI canary (Twilio test credentials)" }).toString();
    return {
      probes: probesFor("twilio", "token", { Authorization: `Basic ${basic}` }, [
        {
          id: "create-message",
          method: "POST",
          endpoint: "/2010-04-01/Accounts/{AccountSid}/Messages.json",
          url: `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          body,
          contentType: "application/x-www-form-urlencoded",
        },
      ]),
      skipped: [],
    };
  },
};

/** HubSpot: a developer test account's private-app token (SHAPI_HUBSPOT_TOKEN, scope crm.objects.contacts.read). */
export const hubspotWorker: Worker = {
  provider: "hubspot",
  probes(env: Env) {
    const token = env.SHAPI_HUBSPOT_TOKEN;
    const ids = ["list-contacts", "list-deal-pipelines"];
    if (!token) return { probes: [], skipped: skip("hubspot", ids, "needs SHAPI_HUBSPOT_TOKEN (a test account's private-app token)") };
    const api = "https://api.hubapi.com";
    return {
      probes: probesFor("hubspot", "token", { Authorization: `Bearer ${token}` }, [
        { id: "list-contacts", endpoint: "/crm/v3/objects/contacts", url: `${api}/crm/v3/objects/contacts?limit=1` },
        { id: "list-deal-pipelines", endpoint: "/crm/v3/pipelines/{objectType}", url: `${api}/crm/v3/pipelines/deals` },
      ]),
      skipped: [],
    };
  },
};
