import { describe, expect, it } from "vitest";
import { getProvider, loadProviders, providerForHost, providerForPackage, sdkEndpoint } from "@shapi/core";

describe("provider registry", () => {
  it("loads and validates about 30 providers with unique ids", () => {
    const providers = loadProviders();
    expect(providers.length).toBeGreaterThanOrEqual(30);
    expect(new Set(providers.map((p) => p.id)).size).toBe(providers.length);
  });

  it("includes the providers named in the research", () => {
    for (const id of ["github", "stripe", "twilio", "shopify", "quickbooks", "xero", "hubspot", "slack", "openai", "anthropic", "reddit", "meta-graph"]) {
      expect(getProvider(id), id).toBeDefined();
    }
  });

  it("resolves exact hosts, wildcard hosts, and prefers the more specific match", () => {
    expect(providerForHost("api.github.com")?.id).toBe("github");
    expect(providerForHost("API.GITHUB.COM:443")?.id).toBe("github");
    expect(providerForHost("acme.myshopify.com")?.id).toBe("shopify");
    expect(providerForHost("generativelanguage.googleapis.com")?.id).toBe("google-gemini");
    expect(providerForHost("sheets.googleapis.com")?.id).toBe("google");
    expect(providerForHost("myshopify.com")).toBeUndefined();
    expect(providerForHost("example.com")).toBeUndefined();
  });

  it("resolves SDK packages and SDK method chains", () => {
    expect(providerForPackage("@octokit/rest")?.id).toBe("github");
    expect(providerForPackage("stripe")?.id).toBe("stripe");
    expect(providerForPackage("left-pad")).toBeUndefined();
    const github = getProvider("github")!;
    expect(sdkEndpoint(github, "rest.actions.createWorkflowDispatch")).toEqual({
      method: "POST",
      path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
    });
    expect(sdkEndpoint(getProvider("stripe")!, "customers.create")).toEqual({ method: "POST", path: "/v1/customers" });
    expect(sdkEndpoint(github, "rest.nope.nothing")).toBeUndefined();
  });
});
