// QuickBooks Online: pinned to minor version 65, which Intuit has silently
// answered as minor version 75 since August 2025.
const QBO = "https://quickbooks.api.intuit.com";

export async function openInvoices(realmId: string, accessToken: string) {
  const query = encodeURIComponent("select * from Invoice where Balance > '0'");
  const res = await fetch(`${QBO}/v3/company/${realmId}/query?query=${query}&minorversion=65`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const body = await res.json();
  return body.QueryResponse.Invoice;
}
