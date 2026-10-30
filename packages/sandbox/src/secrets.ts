/**
 * Credential isolation (execution plan I-04): no provider key, token or other secret ever enters a sandbox. Sandboxes
 * get a fixed, minimal environment; this is the check every command goes through, so a mistake that would pass one in
 * (a new env var, a key forwarded "for the probe") fails loudly instead of leaking it. Fixes never need a credential:
 * the network is off while the repository's code runs, so nothing in a sandbox can call a provider, with or without one.
 */

/** Names of environment variables that hold credentials (`GITHUB_TOKEN`, `npm_config__authToken`, `DATABASE_URL`). */
export const SECRET_NAME = /key|token|secret|passw|private|credential|dsn|cookie|auth|^DATABASE_URL$/i;

export class SandboxSecretError extends Error {}

/** The values of the host's secret-named environment variables, long enough to recognize. */
export function hostSecrets(host: Record<string, string | undefined> = process.env): string[] {
  return Object.entries(host).flatMap(([name, value]) => (value && value.length >= 8 && SECRET_NAME.test(name) ? [value] : []));
}

/** Throws when an environment for a sandbox command names a secret, or holds one of the host's secret values. */
export function assertNoSecrets(env: Record<string, string> | undefined, host: Record<string, string | undefined> = process.env): void {
  if (!env) return;
  const secrets = hostSecrets(host);
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name)) throw new SandboxSecretError(`refused to pass ${name} into a sandbox: sandboxes hold no credentials`);
    if (secrets.some((s) => value.includes(s))) throw new SandboxSecretError(`refused to pass ${name} into a sandbox: its value holds one of the host's secrets`);
  }
}
