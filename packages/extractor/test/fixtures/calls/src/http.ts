import axios from "axios";
import got from "got";
import { request } from "undici";

const GITHUB = process.env.GITHUB_API_URL ?? "https://api.github.com";

export async function dispatch(owner: string, repo: string, workflow: string) {
  return fetch(`${GITHUB}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main" }),
  });
}

export async function getRepo(opts: { owner: string; repo: string }) {
  return fetch(`https://api.github.com/repos/${opts.owner}/${encodeURIComponent(opts.repo)}?per_page=1`);
}

export async function stripeCharge() {
  return axios.post("https://api.stripe.com/v1/charges", { amount: 100 });
}

export async function slackConfig() {
  return axios({ url: "https://slack.com/api/chat.postMessage", method: "post" });
}

const hubspot = axios.create({ baseURL: "https://api.hubapi.com" });
export async function contacts() {
  return hubspot.get("/crm/v3/objects/contacts");
}

export async function twilioGot(sid: string) {
  return got.post("https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json");
}

export async function openai() {
  return request("https://api.openai.com/v1/models", { method: "GET" });
}

export async function unknown(url: string) {
  return fetch(url);
}

export async function internal() {
  return fetch("/api/health");
}
