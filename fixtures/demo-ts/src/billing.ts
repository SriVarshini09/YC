import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2024-06-20" });

export async function createCustomer(email: string): Promise<string> {
  const customer = await stripe.customers.create({ email });
  if (customer.tax_exempt === "exempt") console.log("tax exempt customer", customer.id);
  return customer.id;
}
