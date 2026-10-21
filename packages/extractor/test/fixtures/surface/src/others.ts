import axios from "axios";
import got from "got";
import Stripe from "stripe";

const stripe = new Stripe("sk_test", { apiVersion: "2023-10-16" });

export async function customer() {
  const customer = await stripe.customers.create({ email: "a@b.co" });
  if (customer.tax_exempt === "reverse") return customer.id;
  return customer.address?.country;
}

export async function hubspot() {
  const resp = await axios.get("https://api.hubapi.com/crm/v3/objects/contacts", { params: { limit: 10 } });
  if (resp.status === 200) return resp.data.results.map((r: { id: string }) => r.id);
}

export async function twilio() {
  const msg = await got.post("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json").json<{ sid: string; status: string }>();
  return msg.status === "queued" ? msg.sid : null;
}

export function promiseChain() {
  return fetch("https://api.openai.com/v1/models").then((r) => {
    if (r.status === 401) throw new Error("auth");
    return r;
  });
}

export async function quickbooks(realmId: string) {
  return fetch(`https://quickbooks.api.intuit.com/v3/company/${realmId}/query?query=select&minorversion=65`);
}
