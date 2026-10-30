import { afterEach, describe, expect, it } from "vitest";
import { SandboxSecretError, assertNoSecrets, hostSecrets, localProvider } from "@shapi/sandbox";

// Execution plan I-04: sandboxes hold no provider keys, and a sandbox process cannot read any.
const FAKE = {
  SHAPI_ANTHROPIC_API_KEY: "sk-ant-shapi-test-0123456789abcdef",
  SHAPI_GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY----- shapi-test-key",
  SHAPI_STRIPE_TEST_KEY: "sk_test_shapi0123456789",
  E2B_API_KEY: "e2b_shapi_test_0123456789",
  DATABASE_URL: "postgres://shapi:hunter2-shapi@db.internal/shapi",
};

afterEach(() => {
  for (const k of Object.keys(FAKE)) delete process.env[k];
});

describe("assertNoSecrets", () => {
  it("lets the sandbox's own variables through", () => {
    expect(() => assertNoSecrets({ CI: "1", FORCE_COLOR: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_update_notifier: "false", PYTHONDONTWRITEBYTECODE: "1" }, FAKE)).not.toThrow();
  });

  it("refuses a credential by its name, or by a host secret's value under any name", () => {
    for (const name of ["GITHUB_TOKEN", "OPENAI_API_KEY", "STRIPE_SECRET", "AWS_SECRET_ACCESS_KEY", "SENTRY_DSN", "DATABASE_URL", "npm_config__authToken"]) {
      expect(() => assertNoSecrets({ [name]: "x" }, FAKE), name).toThrow(SandboxSecretError);
    }
    expect(() => assertNoSecrets({ HARMLESS: `prefix ${FAKE.SHAPI_STRIPE_TEST_KEY}` }, FAKE)).toThrow(/holds one of the host's secrets/);
    expect(hostSecrets(FAKE)).toHaveLength(5);
  });
});

describe("a sandbox process", () => {
  it("sees none of the host's keys in its environment, and cannot be handed one", async () => {
    Object.assign(process.env, FAKE);
    const sandbox = await localProvider().create();
    try {
      // What untrusted repository code could try first: print its environment. (The local sandbox is for development:
      // it is not isolated from the host, and production refuses it; there each sandbox is its own E2B microVM.)
      const script = "process.stdout.write(JSON.stringify(process.env));";
      const r = await sandbox.exec(process.execPath, ["-e", script]);
      expect(r.exitCode).toBe(0);
      for (const value of Object.values(FAKE)) expect(r.stdout).not.toContain(value);
      await expect(sandbox.exec(process.execPath, ["-e", "1"], { env: { SHAPI_STRIPE_TEST_KEY: FAKE.SHAPI_STRIPE_TEST_KEY } })).rejects.toThrow(SandboxSecretError);
    } finally {
      await sandbox.close();
    }
  });
});
