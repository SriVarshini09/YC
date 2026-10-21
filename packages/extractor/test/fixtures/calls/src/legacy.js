const fetch = require("node-fetch");
const { Octokit } = require("@octokit/core");

const gh = new Octokit();
module.exports = async function () {
  await fetch("https://api.xero.com/api.xro/2.0/Invoices", { method: "PUT", headers: {} });
  await gh.request("POST /repos/{owner}/{repo}/dispatches");
};
