export async function trigger(owner: string, repo: string, workflow: string) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.status !== 204) throw new Error("dispatch failed");
}

export async function health() {
  const res = await fetch("https://api.github.com/repos/acme/web/actions/workflows/ci.yml/dispatches", { method: "POST" });
  return res.ok;
}

export async function books(realmId: string) {
  return fetch(`https://quickbooks.api.intuit.com/v3/company/${realmId}/query?minorversion=70`);
}
