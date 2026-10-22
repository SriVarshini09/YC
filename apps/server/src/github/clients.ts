import type { Octokit } from "@octokit/rest";
import { appOctokit, installationOctokit, type AppCredentials, type ClientOptions } from "@shapi/github-app";

/** GitHub API clients for the worker: as the app (JWT) or as one installation. */
export interface GitHubClients {
  app(): Octokit;
  installation(installationId: string | number): Octokit;
}

export function githubClients(creds: AppCredentials, opts: ClientOptions = {}): GitHubClients {
  const app = appOctokit(creds, opts);
  // One client per installation, so its token is cached and refreshed across jobs.
  const installations = new Map<string, Octokit>();
  return {
    app: () => app,
    installation(id) {
      const key = String(id);
      let client = installations.get(key);
      if (!client) installations.set(key, (client = installationOctokit(creds, key, opts)));
      return client;
    },
  };
}
