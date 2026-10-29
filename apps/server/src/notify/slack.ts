import { SEVERITY_RANK, type Finding } from "@shapi/core";
import { withService, type Db } from "@shapi/db";

/** New affected call sites in one repository, from a push scan or an advisory fan-out. */
export interface FindingsNotice {
  accountId: string;
  repositoryId: string;
  sha: string;
  reason: "push" | "advisory";
  findings: Finding[];
}

export type Notifier = (notice: FindingsNotice) => Promise<void>;

/** Only Slack incoming webhooks: the server never posts to any other address a customer types in. */
export const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+$/;

/** At most this many findings are listed in one message; the rest are counted. */
const MAX_LISTED = 10;
/** Slack's limit on a section block's text, and room kept for the "…and N more." line. */
const MAX_SECTION = 3000;
const MORE_ROOM = 40;

export interface SlackNotifierDeps {
  db: Db;
  fetch?: typeof globalThis.fetch;
  /** The web app, linked from the message. */
  publicUrl: string;
  /** The public advisory repository (owner/name), for links to each advisory. */
  advisoriesRepo?: string;
  log?: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
  now?: () => Date;
}

/** Post new affected findings to the account's Slack incoming webhook, when it has one. Never throws. */
export function slackNotifier(deps: SlackNotifierDeps): Notifier {
  return async (notice) => {
    if (!notice.findings.length) return;
    try {
      const target = await withService(deps.db, (tx) =>
        tx
          .selectFrom("repositories")
          .innerJoin("accounts", "accounts.id", "repositories.account_id")
          .select(["repositories.full_name", "accounts.login", "accounts.settings"])
          .where("repositories.id", "=", notice.repositoryId)
          .where("accounts.id", "=", notice.accountId)
          .executeTakeFirst(),
      );
      const webhook = (target?.settings as { slackWebhookUrl?: string } | undefined)?.slackWebhookUrl;
      if (!target || !webhook || !SLACK_WEBHOOK.test(webhook)) return;
      const message = slackMessage({ ...notice, repository: target.full_name, publicUrl: deps.publicUrl, advisoriesRepo: deps.advisoriesRepo, now: deps.now?.() ?? new Date() });
      await postSlack(deps.fetch ?? globalThis.fetch, webhook, message);
      deps.log?.info({ repository: target.full_name, findings: notice.findings.length }, "slack alert sent");
    } catch (err) {
      deps.log?.error({ err, repositoryId: notice.repositoryId }, "slack alert failed");
    }
  };
}

export async function postSlack(doFetch: typeof globalThis.fetch, webhook: string, message: object): Promise<void> {
  const res = await doFetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Slack answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Slack mrkdwn needs &, < and > escaped; links are written as <url|text>. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function slackMessage(n: FindingsNotice & { repository: string; publicUrl: string; advisoriesRepo?: string; now: Date }): object {
  const repoUrl = `https://github.com/${n.repository}`;
  const count = n.findings.length;
  const what = `${count} new affected call site${count === 1 ? "" : "s"}`;
  const why = n.reason === "push" ? `after the push of \`${n.sha.slice(0, 7)}\`` : "from a new or updated advisory";
  const findings = [...n.findings].sort((a, b) => SEVERITY_RANK[a.advisory.severity] - SEVERITY_RANK[b.advisory.severity] || a.callSite.file.localeCompare(b.callSite.file));
  const all = findings.slice(0, MAX_LISTED).map((f) => {
    const a = f.advisory;
    // HEAD: the advisory repository's default branch, whatever it is called.
    const title = n.advisoriesRepo ? `<https://github.com/${n.advisoriesRepo}/blob/HEAD/advisories/${encodeURIComponent(a.id)}.json|${esc(a.title)}>` : esc(a.title);
    // Encoded, so a path with a space, #, | or > cannot break the link or change its text.
    const file = f.callSite.file.split("/").map(encodeURIComponent).join("/");
    const where = `<${repoUrl}/blob/${n.sha}/${file}#L${f.callSite.line}|${esc(f.callSite.file)}:${f.callSite.line}>`;
    const days = Math.ceil((Date.parse(a.effectiveDate) - n.now.getTime()) / 86_400_000);
    const deadline = days > 0 ? ` · deadline ${a.effectiveDate} (in ${days} day${days === 1 ? "" : "s"})` : "";
    return `• *${a.severity.toUpperCase()}* ${title}\n   ${where}${deadline}`;
  });
  // Slack rejects the whole message when a section's text is over 3000 characters: list what fits, count the rest.
  const lines: string[] = [];
  for (const line of all) {
    if ([...lines, line].join("\n").length > MAX_SECTION - MORE_ROOM) break;
    lines.push(line);
  }
  if (count > lines.length) lines.push(`…and ${count - lines.length} more.`);
  const dashboard = `${n.publicUrl.replace(/\/+$/, "")}/a/${n.accountId}`;
  return {
    text: `SHAPI: ${what} in ${n.repository}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*SHAPI:* ${what} in <${repoUrl}|${esc(n.repository)}>, ${why}.` } },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      { type: "context", elements: [{ type: "mrkdwn", text: `<${dashboard}|Open in SHAPI> · fixes with a recipe arrive as pull requests` }] },
    ],
  };
}

/** The message the web app's "Send a test message" button posts. */
export function slackTestMessage(account: string, publicUrl: string): object {
  return {
    text: `SHAPI is connected for ${account}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `*SHAPI is connected* for ${esc(account)}. New affected call sites will be posted here. <${publicUrl.replace(/\/+$/, "")}|Open SHAPI>` } }],
  };
}
