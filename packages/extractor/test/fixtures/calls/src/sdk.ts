import { Octokit } from "@octokit/rest";
import Stripe from "stripe";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: "2024-06-20" });

export async function run() {
  await octokit.rest.actions.createWorkflowDispatch({ owner: "o", repo: "r", workflow_id: "ci.yml", ref: "main" });
  await octokit.request("GET /repos/{owner}/{repo}/pulls", { owner: "o", repo: "r" });
  await stripe.customers.create({ email: "a@b.co" });
  await stripe.somethingNew.doIt();
}

class Billing {
  private client = new Stripe("sk_test");
  charge() {
    return this.client.paymentIntents.create({ amount: 1, currency: "usd" });
  }
}
export { Billing };
