/** The repository's page in the SHAPI web app, linked from its check runs, fix PRs and Dashboard issue; undefined without a public URL. */
export function repoPageUrl(publicUrl: string | undefined, accountId: string, repositoryId: string): string | undefined {
  return publicUrl ? `${publicUrl.replace(/\/+$/, "")}/a/${accountId}/r/${repositoryId}` : undefined;
}
