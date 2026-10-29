import { describe, expect, it } from "vitest";
import { authFromEnv, repoFromUrl } from "@shapi/github-app";

describe("helpers", () => {
  it("parses GitHub repository URLs", () => {
    expect(repoFromUrl("https://github.com/SriVarshini09/shapi-demo")).toBe("SriVarshini09/shapi-demo");
    expect(repoFromUrl("https://github.com/SriVarshini09/shapi-demo.git\n")).toBe("SriVarshini09/shapi-demo");
    expect(repoFromUrl("git@github.com:acme/demo.git")).toBe("acme/demo");
    expect(repoFromUrl("https://gitlab.com/acme/demo")).toBeUndefined();
  });

  it("prefers GitHub App credentials, then a token", () => {
    expect(authFromEnv({ SHAPI_GITHUB_APP_ID: "1", SHAPI_GITHUB_APP_INSTALLATION_ID: "2", SHAPI_GITHUB_APP_PRIVATE_KEY: "k", GITHUB_TOKEN: "t" })).toEqual({
      appId: "1",
      installationId: 2,
      privateKey: "k",
    });
    expect(authFromEnv({ GH_TOKEN: "t" })).toEqual({ token: "t" });
  });

  it("ignores App key settings when the App is not configured, and an empty GITHUB_TOKEN", () => {
    expect(authFromEnv({ SHAPI_GITHUB_APP_PRIVATE_KEY_PATH: "/nope/key.pem", GITHUB_TOKEN: "t" })).toEqual({ token: "t" });
    expect(authFromEnv({ GITHUB_TOKEN: "", GH_TOKEN: "g" })).toEqual({ token: "g" });
  });
});
