import type { Octokit } from "@octokit/rest";
import {
  SCAN_PERMISSIONS,
  appOctokit,
  createOctokit,
  installationOctokit,
  scopedInstallationToken,
  type AppCredentials,
  type ClientOptions,
} from "@shapi/github-app";

/** GitHub API clients for the worker: as the app (JWT), as one installation, or read-only on one repository. */
export interface GitHubClients {
  app(): Octokit;
  installation(installationId: string | number): Octokit;
  /** A fresh short-lived token that can only read one repository's contents: for downloading code to scan or repair. */
  readOnly(installationId: string | number, repositoryId: string | number): Promise<Octokit>;
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
    async readOnly(installationId, repositoryId) {
      const { token } = await scopedInstallationToken(creds, installationId, { repositoryIds: [Number(repositoryId)], permissions: { ...SCAN_PERMISSIONS } }, opts);
      return createOctokit({ auth: token }, opts);
    },
  };
}
