# U-06: GitLab merge requests

## What

`shapi fix --mr` opens a GitLab merge request with the same fix, contract test and description that `--pr` sends to GitHub (`packages/cli/src/gitlab.ts`, through GitLab's REST API v4).

- **The project** comes from `--repo <gitlab url>` or the checkout's `origin`, in https or ssh form, with subgroups and self-managed hosts.
- **The branch** is `shapi/<advisory>`, created from the default branch, or from the clone's commit with `--repo`. All files go in one commit. A rerun commits to the same branch and updates the open merge request instead of opening another.
- **As on GitHub, nothing is overwritten.** A file that changed on the default branch since the fix was computed is refused.
- **Unverified advisories** never open a merge request.
- **The merge request** is labeled `shapi` and deletes its branch on merge.
- **Authentication** is `GITLAB_TOKEN`, an access token with the `api` scope.

## Verified

- URL parsing: https, ssh, a subgroup, a self-managed host with credentials in the URL, and a GitHub URL rejected.
- Against a fake GitLab:
  - a new branch, one commit (`create` and `update` actions) and a merge request;
  - a rerun updating the same merge request;
  - a fix refused when its file changed on `main`.
- `shapi fix --mr` on the demo fixture with a GitLab origin hands the same title, body, branch and files as `--pr` to the delivery.
- Without a GitLab origin, or without `GITLAB_TOKEN`, it refuses with a clear message.

## Not done

- **A live demo merge request** (the plan's test) needs a GitLab project and token from the founder. Once those exist, run `GITLAB_TOKEN=… npx shapi-cli fix --repo <gitlab url> --mr` on a project with an affected call site.
- **The hosted App for GitLab** (webhooks, scans on push) is not built; this is the CLI path.
