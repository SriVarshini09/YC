import type { Advisory, LockedCallSite } from "@shapi/core";
import { DEFAULT_PR_LIMITS, STOP_LABEL } from "@shapi/github-app";
import { FREE_PRIVATE_REPOS, coverage, requiredQuantity } from "../billing/plan";
import { DOCS_URL, EMPTY, ICONS, MARK, html, initials, isoDay, navFor, plural, shortSha, timeAgo, type Html, type NavKey, type Shell, type Theme } from "./html";
import { daysUntil, deadlinesOf, hitsByAdvisory, providersOf, type AccountData, type FindingRow, type PrRow, type RepoRow, type ScanRow } from "./queries";
import {
  accountHref,
  callSiteText,
  commitUrl,
  comparison,
  comparisonView,
  crumbs,
  deadlineRow,
  deadlineTimeline,
  diffView,
  dueTag,
  empty,
  fileUrl,
  findingHref,
  head,
  kindTag,
  prLink,
  providerMark,
  providerName,
  repoHref,
  section,
  severityTag,
  statCard,
  stateTag,
  tag,
  testRunBox,
} from "./views";

export interface PageContext {
  user: { login: string; csrf: string };
  theme: Theme;
}

/** The shell for an account page: sidebar with live counts, and the active entry. */
export function shellFor(data: AccountData, ctx: PageContext, active: NavKey): Shell {
  const affected = data.findings.filter((f) => f.kind === "affected").length;
  const open = data.prs.filter((p) => p.state === "open").length;
  const soon = deadlinesOf(data).filter((d) => d.daysUntil >= 0 && d.daysUntil <= 90).length;
  return {
    user: ctx.user,
    theme: ctx.theme,
    workspace: {
      id: data.account.id,
      login: data.account.login,
      type: data.account.type,
      active,
      nav: navFor(data.account.id, { findings: { count: affected, bad: affected > 0 }, fixes: { count: open }, deadlines: { count: soon, bad: false } }),
    },
  };
}


/* ---------- account picker and messages (no sidebar) ---------- */

export function accountsPage(accounts: { id: string; login: string; type: string; suspended_at: Date | null }[], installLink: string | undefined, user: { login: string; csrf: string }): Html {
  return html`<div class="card">
<span class="mark">${MARK}</span>
<h1>Choose an account</h1>
<p class="lead">Where SHAPI is installed and ${user.login} has access on GitHub.</p>
${
  accounts.length
    ? html`<div class="accounts">${accounts.map(
        (a) => html`<a href="/a/${a.id}"><span class="avatar">${initials(a.login)}</span><span><b>${a.login}</b><span class="note">${a.type}</span></span><span class="meta">${a.suspended_at ? tag("suspended", "warn") : tag("active", "ok")}</span></a>`,
      )}</div>`
    : html`<div class="notice">SHAPI is not installed on any account you can access${installLink ? html`. <a href="${installLink}">Install it</a>, then sign in again.` : "."}</div>`
}
${installLink && accounts.length ? html`<p class="foot"><a href="${installLink}">Install on more accounts or repositories</a>, then sign in again to see them.</p>` : EMPTY}
<form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${user.csrf}"><button type="submit">Sign out</button></form>
</div>`;
}

export function messagePage(title: string, text: string, link?: { href: string; label: string }): Html {
  return html`<div class="card"><span class="mark">${MARK}</span><h1>${title}</h1><p class="lead">${text}</p>${link ? html`<a class="button" href="${link.href}">${link.label}</a>` : EMPTY}</div>`;
}

/* ---------- repositories ---------- */

export function repositoriesPage(data: AccountData, billingEnabled: boolean): Html {
  return html`${head("Repositories", `${plural(data.repos.length, "repository", "repositories")}. SHAPI scans each push to the default branch.`)}
${repoTable(data, data.repos, billingEnabled)}`;
}

function repoTable(data: AccountData, repos: RepoRow[], billingEnabled = false): Html {
  if (!repos.length) return html`<div class="card tight">${empty("No repositories yet. Install the SHAPI GitHub App on a repository and push to its default branch.")}</div>`;
  const covered = coverage(data.repos, data.billing, billingEnabled);
  const rows = repos.map((r) => {
    const c = covered.get(r.id);
    const flags = html`${r.paused || r.pausedFromWeb ? tag("paused", "warn") : EMPTY}${r.enabled ? EMPTY : tag("archived", "")}${c && !c.covered && r.enabled ? tag("not covered by plan", "warn", c.reason) : EMPTY}`;
    const providers = r.providers.slice(0, 5);
    return html`<tr class="${r.affected ? "affected" : ""}">
<td><a href="${repoHref(data, r.id)}"><b>${r.full_name}</b></a> ${flags}<span class="sub">${r.private ? "private" : "public"} · <span class="mono">${r.default_branch}</span>${r.lockSha ? ` · ${plural(r.callSites, "call site")}` : ""}</span></td>
<td>${providers.length ? html`<span class="marks">${providers.map((p) => html`<span title="${providerName(p.id)}: ${plural(p.callSites, "call")}">${providerMark(p.id, "sm")}</span>`)}${r.providers.length > 5 ? html`<span class="muted small">+${r.providers.length - 5}</span>` : EMPTY}</span>` : html`<span class="muted">—</span>`}</td>
<td>${r.affected ? tag(`${r.affected} affected`, "bad") : r.lockSha ? tag("none", "ok") : html`<span class="muted">—</span>`}${r.exposed ? html` ${tag(`${r.exposed} exposed`, "warn")}` : EMPTY}</td>
<td>${r.openPrs ? html`<a href="${repoHref(data, r.id)}#fixes">${plural(r.openPrs, "open PR")}</a>` : html`<span class="muted">${r.mergedPrs ? `${r.mergedPrs} merged` : "—"}</span>`}</td>
<td>${r.scan ? html`${stateTag(r.scan.status)} <span class="mono">${shortSha(r.scan.sha)}</span><span class="sub">${timeAgo(r.scan.finished_at ?? r.scan.created_at, data.now)}</span>` : html`<span class="muted">not scanned yet</span>`}</td>
</tr>`;
  });
  return html`<div class="card tight"><table><thead><tr><th>Repository</th><th>Providers</th><th>Call sites</th><th>Fix PRs</th><th>Last scan</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* ---------- one repository ---------- */

interface RepoDetail {
  scans: ScanRow[];
}

export function repositoryPage(data: AccountData, repo: RepoRow, detail: RepoDetail, csrf: string): Html {
  const b = accountHref(data);
  const prs = data.prs.filter((p) => p.repository_id === repo.id);
  const findings = data.findings.filter((f) => f.repository_id === repo.id);
  const pause = html`<form method="post" action="${repoHref(data, repo.id)}/pause" class="inline"><input type="hidden" name="csrf" value="${csrf}">${
    repo.pausedFromWeb ? html`<button type="submit">Resume SHAPI on this repository</button>` : html`<button type="submit">Pause SHAPI on this repository</button>`
  }</form>`;
  const actions = html`<a class="button" href="https://github.com/${repo.full_name}">${ICONS.external} GitHub</a>${
    repo.dashboard_issue ? html`<a class="button" href="https://github.com/${repo.full_name}/issues/${repo.dashboard_issue}">Dashboard issue #${repo.dashboard_issue}</a>` : EMPTY
  }${pause}`;
  const flags = html`${repo.private ? tag("private", "plain") : tag("public", "plain")}${repo.pausedFromWeb ? tag("paused here", "warn") : EMPTY}${repo.paused ? tag("paused from the dashboard issue", "warn") : EMPTY}${repo.enabled ? EMPTY : tag("archived", "")}`;
  const kv = (k: string, v: Html | string) => html`<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const strip = html`<div class="card strip">
${kv("Last scan", repo.scan ? html`${stateTag(repo.scan.status)} <a class="mono" href="${commitUrl(repo.full_name, repo.scan.sha)}">${shortSha(repo.scan.sha)}</a> <span class="muted small">${timeAgo(repo.scan.finished_at ?? repo.scan.created_at, data.now)}</span>` : html`<span class="muted">pending</span>`)}
${kv("Call sites", String(repo.callSites))}
${kv("Providers", String(repo.providers.length))}
${kv("Affected", repo.affected ? html`<span class="ink-bad">${repo.affected}</span>` : html`<span class="ink-ok">0</span>`)}
${kv("Exposed", String(repo.exposed))}
${kv("Open fix PRs", String(repo.openPrs))}
</div>`;
  return html`${crumbs([{ label: "Overview", href: b }, { label: "Repositories", href: `${b}/repositories` }, { label: repo.full_name }])}
${head(repo.full_name, "", actions)}
<div>${flags}${repo.pausedFromWeb || repo.paused ? html` <span class="note">Scans continue; no PRs are opened or updated while paused.</span>` : EMPTY}</div>
${strip}
${section("Call sites by provider", callSitesByProvider(data, repo, findings, prs))}
<div class="grid cols-2">
<div id="fixes">${section("Fix pull requests", prTable(data, prs, { repo: false }))}</div>
<div>${section("Recent scans", scanTable(repo, detail.scans, data.now))}</div>
</div>`;
}

type SiteRow = Pick<LockedCallSite, "file" | "line" | "method" | "endpoint"> & Partial<Pick<LockedCallSite, "client" | "operation" | "provider">> & { sha: string };

/**
 * Every third-party call in the repository, grouped by provider: the latest api.lock's call sites, plus
 * any finding whose call site the lock does not list (older scans stored none). Affected rows are highlighted.
 */
function callSitesByProvider(data: AccountData, repo: RepoRow, findings: FindingRow[], prs: PrRow[]): Html {
  const byKey = new Map<string, FindingRow[]>();
  for (const f of findings) {
    const key = `${f.site.file}:${f.site.line}`;
    byKey.set(key, [...(byKey.get(key) ?? []), f]);
  }
  const sites: SiteRow[] = (repo.lock?.callSites ?? []).map((s) => ({ ...s, sha: repo.lockSha ?? "" }));
  const listed = new Set(sites.map((s) => `${s.file}:${s.line}`));
  for (const f of findings) {
    const key = `${f.site.file}:${f.site.line}`;
    if (listed.has(key)) continue;
    listed.add(key);
    sites.push({ ...f.site, provider: f.site.provider ?? f.advisory?.provider ?? null, sha: f.sha });
  }
  if (!sites.length) {
    return html`<div class="card tight">${empty(repo.scan?.status === "failed" ? `The last scan failed: ${repo.scan.error ?? "unknown error"}` : repo.lock ? "No third-party API calls found in this repository." : "No completed scan yet.")}</div>`;
  }
  const prFor = (advisoryId: string) => prs.find((p) => p.advisory_id === advisoryId);
  const groups = new Map<string, SiteRow[]>();
  for (const site of sites) {
    const id = site.provider ?? "unknown";
    groups.set(id, [...(groups.get(id) ?? []), site]);
  }
  const hitCount = (list: SiteRow[], kind: "affected" | "exposed") => list.filter((s) => byKey.get(`${s.file}:${s.line}`)?.some((f) => f.kind === kind)).length;
  const ordered = [...groups.keys()].sort((a, b) => hitCount(groups.get(b)!, "affected") - hitCount(groups.get(a)!, "affected") || groups.get(b)!.length - groups.get(a)!.length || a.localeCompare(b));
  return html`<div class="card tight">${ordered.map((id) => {
    const list = groups.get(id)!;
    const affected = hitCount(list, "affected");
    const exposed = hitCount(list, "exposed");
    const rows = list.map((s) => {
      const hits = byKey.get(`${s.file}:${s.line}`) ?? [];
      const worst = hits.find((f) => f.kind === "affected") ?? hits[0];
      const pr = worst ? prFor(worst.advisory_id) : undefined;
      return html`<tr class="${worst?.kind ?? ""}">
<td><a class="mono" href="${fileUrl(repo.full_name, s.sha, s.file, s.line)}">${s.file}:${s.line}</a>${s.client ? html`<span class="sub">${s.client}${s.operation ? html` · <span class="mono">${s.operation}</span>` : EMPTY}</span>` : EMPTY}</td>
<td><span class="mono">${callSiteText(s)}</span></td>
<td>${kindTag(worst?.kind ?? "ok")}</td>
<td>${worst ? html`<a href="${findingHref(data, worst.id)}">${worst.advisory?.title ?? worst.advisory_id}</a>${hits.length > 1 ? html` <span class="muted small">+${hits.length - 1} more</span>` : EMPTY}<span class="sub">${worst.reasons.join("; ")}</span>` : html`<span class="muted">—</span>`}</td>
<td>${fixPrCell(pr, worst)}</td>
</tr>`;
    });
    return html`<div class="group-head">${providerMark(id, "sm")}${id === "unknown" ? "Unknown host" : providerName(id)}<span class="meta">${affected ? tag(`${affected} affected`, "bad") : EMPTY}${exposed ? tag(`${exposed} exposed`, "warn") : EMPTY}<span>${plural(list.length, "call site")}</span></span></div>
<table class="sites"><colgroup><col class="c-site"><col class="c-req"><col class="c-status"><col class="c-change"><col class="c-pr"></colgroup><thead><tr><th>Call site</th><th>Request</th><th>Status</th><th>API change</th><th>Fix PR</th></tr></thead><tbody>${rows}</tbody></table>`;
  })}</div>`;
}

function scanTable(repo: RepoRow, scans: ScanRow[], now: Date): Html {
  if (!scans.length) return html`<div class="card tight">${empty("None yet.")}</div>`;
  return html`<div class="card tight"><table><thead><tr><th>Commit</th><th>Status</th><th>When</th></tr></thead><tbody>${scans.map(
    (s) => html`<tr><td><a class="mono" href="${commitUrl(repo.full_name, s.sha)}">${shortSha(s.sha)}</a>${s.error ? html`<span class="sub">${s.error}</span>` : EMPTY}</td><td>${stateTag(s.status)}</td><td class="muted">${timeAgo(s.finished_at ?? s.created_at, now)}</td></tr>`,
  )}</tbody></table></div>`;
}

/** The fix PR for a finding: its link and state, "pending" while a fixable one waits, "manual fix" when no recipe fits. */
function fixPrCell(pr: PrRow | undefined, finding: FindingRow | undefined): Html {
  if (pr) return html`${prLink(pr)} ${stateTag(pr.state)}`;
  if (finding?.kind === "affected") return html`<span class="muted small">${finding.advisory?.recipeId ? "pending" : "manual fix"}</span>`;
  return html`<span class="muted">—</span>`;
}

/* ---------- findings ---------- */

export function findingsPage(data: AccountData, filter: { kind?: string; advisory?: string }): Html {
  const b = accountHref(data);
  const kind = filter.kind === "affected" || filter.kind === "exposed" ? filter.kind : "all";
  let rows = kind === "all" ? data.findings : data.findings.filter((f) => f.kind === kind);
  if (filter.advisory) rows = rows.filter((f) => f.advisory_id === filter.advisory);
  const counts = { all: data.findings.length, affected: data.findings.filter((f) => f.kind === "affected").length, exposed: data.findings.filter((f) => f.kind === "exposed").length };
  const filters = html`<div class="filters">${(["all", "affected", "exposed"] as const).map(
    (k) => html`<a class="${k === kind ? "on" : ""}" href="${b}/findings?kind=${k}${filter.advisory ? `&advisory=${encodeURIComponent(filter.advisory)}` : ""}">${k[0]!.toUpperCase() + k.slice(1)} · ${counts[k]}</a>`,
  )}${filter.advisory ? html`<a class="on" href="${b}/findings?kind=${kind}">${data.advisories.get(filter.advisory)?.title ?? filter.advisory} ✕</a>` : EMPTY}</div>`;
  return html`${head("Findings", "Call sites in your code that call an endpoint with a known API change, from the latest scan of each repository.")}
${filters}
${findingTable(data, rows)}`;
}

function findingTable(data: AccountData, rows: FindingRow[]): Html {
  if (!rows.length) return html`<div class="card tight">${empty("No findings match. Affected call sites depend on exactly what changed; exposed ones call the endpoint without depending on the change.")}</div>`;
  const prFor = (f: FindingRow) => data.prs.find((p) => p.repository_id === f.repository_id && p.advisory_id === f.advisory_id);
  return html`<div class="card tight"><table><thead><tr><th>Status</th><th>API change</th><th>Call site</th><th>Deadline</th><th>Fix PR</th></tr></thead><tbody>${rows.map((f) => {
    const pr = prFor(f);
    const days = f.advisory ? daysUntil(f.advisory.effectiveDate, data.now) : undefined;
    return html`<tr class="${f.kind}">
<td>${kindTag(f.kind)}<span class="sub">${f.advisory ? severityTag(f.advisory.severity) : EMPTY}</span></td>
<td><a href="${findingHref(data, f.id)}"><b>${f.advisory?.title ?? f.advisory_id}</b></a><span class="sub">${f.advisory ? html`${providerMark(f.advisory.provider, "sm")} ` : EMPTY}${f.advisory ? providerName(f.advisory.provider) : ""} · <span class="mono">${f.advisory ? `${f.advisory.endpoint.method} ${f.advisory.endpoint.path}` : callSiteText(f.site)}</span></span></td>
<td><a class="mono" href="${fileUrl(f.repo, f.sha, f.site.file, f.site.line)}">${f.site.file}:${f.site.line}</a><span class="sub">${f.repo}</span></td>
<td>${days === undefined ? html`<span class="muted">—</span>` : dueTag(days)}<span class="sub">${f.advisory ? isoDay(f.advisory.effectiveDate) : ""}</span></td>
<td>${fixPrCell(pr, f)}</td>
</tr>`;
  })}</tbody></table></div>`;
}

/* ---------- fix PRs ---------- */

export function fixesPage(data: AccountData, filter: { state?: string }): Html {
  const b = accountHref(data);
  const state = filter.state === "open" || filter.state === "merged" || filter.state === "closed" ? filter.state : "all";
  const rows = state === "all" ? data.prs : data.prs.filter((p) => p.state === state);
  const count = (s: string) => (s === "all" ? data.prs.length : data.prs.filter((p) => p.state === s).length);
  return html`${head("Fix pull requests", "One PR per repository and API change. A change is kept only when its contract test failed before it and passes after it.")}
<div class="filters">${(["all", "open", "merged", "closed"] as const).map((s) => html`<a class="${s === state ? "on" : ""}" href="${b}/fixes?state=${s}">${s[0]!.toUpperCase() + s.slice(1)} · ${count(s)}</a>`)}</div>
${prTable(data, rows, { repo: true })}`;
}

function prTable(data: AccountData, prs: PrRow[], opts: { repo: boolean }): Html {
  if (!prs.length) return html`<div class="card tight">${empty("No fix pull requests yet.")}</div>`;
  const findingFor = (p: PrRow) => data.findings.find((f) => f.repository_id === p.repository_id && f.advisory_id === p.advisory_id);
  return html`<div class="card tight"><table><thead><tr><th>Pull request</th><th>API change</th><th>State</th><th>Verified</th><th>Updated</th></tr></thead><tbody>${prs.map((p) => {
    const f = findingFor(p);
    const fixed = p.repair?.sites.filter((s) => s.status === "fixed").length ?? 0;
    return html`<tr>
<td><b>${prLink(p)}</b>${opts.repo ? html`<span class="sub">${p.repo}</span>` : EMPTY}</td>
<td>${f ? html`<a href="${findingHref(data, f.id)}">${p.advisory?.title ?? p.advisory_id}</a>` : html`${p.advisory?.title ?? p.advisory_id}`}<span class="sub">${p.advisory ? `${providerName(p.advisory.provider)} · ` : ""}<span class="mono">${p.advisory_id}</span></span></td>
<td>${stateTag(p.state)}${p.stopped ? html` ${tag("stopped", "warn")}` : EMPTY}</td>
<td>${p.repair ? html`${tag(`${fixed} of ${p.repair.sites.length} fixed`, fixed === p.repair.sites.length ? "ok" : "warn")}<span class="sub">${p.repair.method === "llm" ? "Claude, verified by contract tests" : `recipe ${p.repair.recipeId ?? ""}`}</span>` : html`<span class="muted small">details on the PR</span>`}</td>
<td class="muted">${timeAgo(p.updated_at, data.now)}</td>
</tr>`;
  })}</tbody></table></div>`;
}

/* ---------- deadlines ---------- */

export function deadlinesPage(data: AccountData): Html {
  const b = accountHref(data);
  const deadlines = deadlinesOf(data);
  const inEffect = deadlines.filter((d) => d.daysUntil < 0);
  const ahead = deadlines.filter((d) => d.daysUntil >= 0);
  return html`${head("Deadlines", "When each API change for a provider in your code takes effect. Red within 30 days, amber within 90.")}
<div class="card">${deadlineTimeline(deadlines, data.now)}</div>
${inEffect.length ? section("Already in effect", html`<div class="card">${inEffect.map((d) => deadlineRow(d, `${b}/findings?advisory=${encodeURIComponent(d.advisory.id)}`))}</div>`) : EMPTY}
${section("Coming up", ahead.length ? html`<div class="card">${ahead.map((d) => deadlineRow(d, `${b}/advisories?advisory=${encodeURIComponent(d.advisory.id)}`))}</div>` : html`<div class="card tight">${empty("Nothing scheduled for the providers in your code.")}</div>`)}`;
}

/* ---------- advisories ---------- */

export function advisoriesPage(data: AccountData, filter: { provider?: string; advisory?: string }): Html {
  const b = accountHref(data);
  const present = new Set(providersOf(data).map((p) => p.id));
  const hits = hitsByAdvisory(data.findings);
  const all = [...data.advisories.values()];
  const providers = [...new Set(all.map((a) => a.provider))].sort((x, y) => Number(present.has(y)) - Number(present.has(x)) || x.localeCompare(y));
  let rows = filter.provider ? all.filter((a) => a.provider === filter.provider) : all;
  if (filter.advisory) rows = rows.filter((a) => a.id === filter.advisory);
  const relevance = (a: Advisory) => {
    const h = hits.get(a.id);
    return h?.affected ? 0 : h?.exposed ? 1 : present.has(a.provider) ? 2 : 3;
  };
  rows = rows.sort((x, y) => relevance(x) - relevance(y) || daysUntil(x.effectiveDate, data.now) - daysUntil(y.effectiveDate, data.now));
  const filters = html`<div class="filters"><a class="${filter.provider ? "" : "on"}" href="${b}/advisories">All · ${all.length}</a>${providers.map(
    (p) => html`<a class="${p === filter.provider ? "on" : ""}" href="${b}/advisories?provider=${encodeURIComponent(p)}">${providerName(p)}${present.has(p) ? "" : " ·"}</a>`,
  )}</div>`;
  return html`${head("Advisories", `${plural(all.length, "reviewed API change")} SHAPI watches for. Providers in your code come first; a dot marks ones your code does not use.`)}
${filters}
${filter.advisory ? html`<div class="filters"><a class="on" href="${b}/advisories">${data.advisories.get(filter.advisory)?.title ?? filter.advisory} ✕</a></div>` : EMPTY}
<div class="card tight"><table><thead><tr><th>API change</th><th>Severity</th><th>Takes effect</th><th>Your code</th><th>Fix</th></tr></thead><tbody>${rows.map((a) => {
    const h = hits.get(a.id);
    const days = daysUntil(a.effectiveDate, data.now);
    return html`<tr class="${h?.affected ? "affected" : h?.exposed ? "exposed" : ""}">
<td><b>${a.title}</b><span class="sub">${providerMark(a.provider, "sm")} ${providerName(a.provider)} · <span class="mono">${a.endpoint.method} ${a.endpoint.path}</span> · ${a.changeClass} · <a href="${a.sources[0]}">source</a></span></td>
<td>${severityTag(a.severity)}</td>
<td>${dueTag(days)}<span class="sub">${isoDay(a.effectiveDate)}</span></td>
<td>${h?.affected ? html`<a href="${b}/findings?advisory=${encodeURIComponent(a.id)}">${tag(`${h.affected} affected`, "bad")}</a>` : EMPTY}${h?.exposed ? html` <a href="${b}/findings?kind=exposed&advisory=${encodeURIComponent(a.id)}">${tag(`${h.exposed} exposed`, "warn")}</a>` : EMPTY}${
      !h ? html`<span class="muted small">${present.has(a.provider) ? "not called" : "provider not used"}</span>` : EMPTY
    }</td>
<td>${a.recipeId ? tag("automatic", "ok") : tag("manual", "")}</td>
</tr>`;
  })}</tbody></table>${rows.length ? EMPTY : empty("No advisories match.")}</div>`;
}

/* ---------- one finding ---------- */

interface FindingDetail {
  id: string;
  kind: "affected" | "exposed";
  site: FindingRow["site"];
  locked?: LockedCallSite;
  reasons: string[];
  advisory_id: string;
  advisory?: Advisory;
  sha: string;
  full_name: string;
  repository_id: string;
  finished_at: Date | null;
  pr?: Pick<PrRow, "url" | "number" | "branch" | "state" | "stopped" | "repair">;
}

export function findingPage(account: { id: string }, f: FindingDetail, now: Date): Html {
  const b = `/a/${account.id}`;
  const a = f.advisory;
  const title = a?.title ?? f.advisory_id;
  const days = a ? daysUntil(a.effectiveDate, now) : undefined;
  const kvRow = (k: string, v: Html | string) => html`<tr><td>${k}</td><td>${v}</td></tr>`;
  const changed = a
    ? html`<div class="card stack">
<h2>What changed</h2>
<p>${a.summary}</p>
<table class="kv-table"><tbody>
${kvRow("Endpoint", html`<span class="mono">${a.endpoint.method} ${a.endpoint.path}</span>`)}
${kvRow("Change class", a.changeClass)}
${kvRow("Takes effect", html`${isoDay(a.effectiveDate)} ${dueTag(days!)}`)}
${kvRow("First observed", a.firstObserved ?? "unknown")}
${kvRow("Provider notice", a.publishedNotice ? html`<a href="${a.publishedNotice.url}">${a.publishedNotice.date ?? "notice"}</a>` : "none (undocumented change)")}
${kvRow("Sources", html`${a.sources.map((s, i) => html`${i ? " · " : ""}<a href="${s}">${new URL(s).hostname}</a>`)}`)}
${kvRow("Advisory", html`<span class="mono">${a.id}</span> · ${a.status}`)}
</tbody></table>
<div class="notice">Migration: ${a.migrationNote}</div>
</div>`
    : html`<div class="card"><h2>What changed</h2><p class="muted">Advisory <span class="mono">${f.advisory_id}</span> is no longer in the database.</p></div>`;
  const where = html`<div class="card stack">
<h2>Where in your code</h2>
<p><a class="mono" href="${fileUrl(f.full_name, f.sha, f.site.file, f.site.line)}">${f.site.file}:${f.site.line}</a> in <a href="${b}/r/${f.repository_id}">${f.full_name}</a> at <span class="mono">${shortSha(f.sha)}</span></p>
<p class="mono">${callSiteText(f.site)}${f.locked ? html` <span class="muted">· ${f.locked.client}${f.locked.operation ? ` · ${f.locked.operation}` : ""}</span>` : EMPTY}</p>
<div><b>Why it is ${f.kind}</b><ul class="reasons">${f.reasons.map((r) => html`<li>${r}</li>`)}</ul></div>
</div>`;
  return html`${crumbs([{ label: "Overview", href: b }, { label: "Findings", href: `${b}/findings` }, { label: title }])}
${head(title, a ? `${providerName(a.provider)} · ${f.full_name}` : f.full_name, html`${kindTag(f.kind)}${a ? severityTag(a.severity) : EMPTY}${a ? providerMark(a.provider) : EMPTY}`)}
<div class="grid cols-2">${changed}${where}</div>
${a ? section("Expected vs actual", html`<div class="card">${comparisonView(comparison(a, f.locked))}</div>`) : EMPTY}
${section("The fix", fixSection(f, b))}`;
}

function fixSection(f: FindingDetail, b: string): Html {
  const a = f.advisory;
  const pr = f.pr;
  if (!pr) {
    if (f.kind === "exposed") return html`<div class="card"><p>No fix needed: this call site calls the changed endpoint but does not depend on what changed.</p></div>`;
    if (a && !a.recipeId) return html`<div class="card stack"><p><b>Manual fix.</b> SHAPI has no deterministic recipe for this change, so no PR is opened unless the account turns on Claude fixes in <a href="${b}/settings">Settings</a>.</p><div class="notice">${a.migrationNote}</div></div>`;
    return html`<div class="card"><p>A fix PR has not been opened yet. SHAPI opens it after the next fix run, within the account's PR limits, unless the repository is paused.</p></div>`;
  }
  const button = prLink(pr, "button");
  const r = pr.repair;
  if (!r) return html`<div class="card stack"><p>${stateTag(pr.state)}${pr.stopped ? html` ${tag("stopped", "warn")}` : EMPTY} The diff and the test results are on the pull request.</p><div>${button}</div></div>`;
  const site = r.sites.find((s) => s.file === f.site.file && s.line === f.site.line) ?? r.sites.find((s) => s.status === "fixed") ?? r.sites[0];
  const fixed = r.sites.filter((s) => s.status === "fixed").length;
  const steps = html`<div class="steps">
<div class="step"><span class="n ok">1</span><div>A contract test was written for this call site${site?.test ? html`: <span class="mono">${site.test}</span>` : EMPTY}. It calls the function with the response the code was written for and the one the provider sends now.</div></div>
<div class="step"><span class="n ${site?.before && !site.before.passed ? "ok" : "bad"}">2</span><div>${site?.before ? (site.before.passed ? "The test passed on the original code, so no change was needed here." : "The test failed on the original code: the breakage is real.") : "No baseline run was recorded."}</div></div>
<div class="step"><span class="n ok">3</span><div>${r.method === "llm" ? "Claude proposed a change" : html`The deterministic recipe <span class="mono">${r.recipeId ?? ""}</span> changed the code`}${r.sandbox ? html`, in sandbox <span class="mono">${r.sandbox}</span>` : EMPTY}.</div></div>
<div class="step"><span class="n ${site?.after?.passed ? "ok" : "bad"}">4</span><div>${site?.after?.passed ? "The same test passes after the change. Only then was the PR opened." : site?.status === "already-handled" ? "No change was kept for this call site." : `The change was not kept: ${site?.reason ?? site?.status ?? "unknown"}.`}</div></div>
</div>`;
  return html`<div class="card stack">
<div class="head"><div>${stateTag(pr.state)}${pr.stopped ? html` ${tag("stopped", "warn")}` : EMPTY} ${tag(`${fixed} of ${r.sites.length} call sites fixed`, fixed === r.sites.length ? "ok" : "warn")} <span class="note">verified ${isoDay(r.verifiedAt)}</span></div><div class="actions">${button}</div></div>
${steps}
<h2>Test result</h2>
<div class="compare">${testRunBox(site?.before, "before", site?.test)}<div class="arrow">${ICONS.arrow}</div>${testRunBox(site?.after, "after", site?.test)}</div>
<h2>Diff</h2>
${r.changes.length ? r.changes.map(diffView) : html`<p class="muted">No file changes recorded.</p>`}
</div>`;
}

/* ---------- settings ---------- */

export function settingsPage(data: AccountData, notice: string | undefined, csrf: string): Html {
  const b = accountHref(data);
  const settings = data.account.settings as { prLimits?: { hourly?: number; open?: number }; failOnAffected?: boolean; llmFixes?: boolean; slackWebhookUrl?: string };
  const limits = { ...DEFAULT_PR_LIMITS, ...(settings.prLimits ?? {}) };
  return html`${head("Settings", `How SHAPI opens pull requests for ${data.account.login}.`)}
${notice ? html`<div class="notice">${notice}</div>` : EMPTY}
<div class="grid cols-2">
<form class="settings card" method="post" action="${b}/settings">
<input type="hidden" name="csrf" value="${csrf}">
<h2>Pull requests</h2>
<label>New fix PRs per hour, per repository <input type="number" name="hourly" min="1" max="20" value="${limits.hourly}"></label>
<label>Open SHAPI PRs at once, per repository <input type="number" name="open" min="1" max="50" value="${limits.open}"></label>
<label class="check"><input type="checkbox" name="failOnAffected" ${settings.failOnAffected ? "checked" : ""}> <span>Fail the SHAPI check when a call site is affected <span class="note">(it is neutral by default, so it never blocks a merge)</span></span></label>
<label class="check"><input type="checkbox" name="llmFixes" ${settings.llmFixes ? "checked" : ""}> <span>Use Claude when no deterministic recipe fits <span class="note">(sends the affected file and its contract test to Anthropic; the change is kept only if the test passes in the sandbox)</span></span></label>
<h2>Slack alerts</h2>
<label>Slack alerts for new affected call sites <span class="note">${
    settings.slackWebhookUrl ? html`(connected: webhook ending in <span class="mono">${settings.slackWebhookUrl.slice(-6)}</span>; paste a new one to replace it)` : html`(paste an <a href="https://api.slack.com/messaging/webhooks">incoming webhook</a> link, https://hooks.slack.com/services/…)`
  }</span> <input type="url" name="slack" placeholder="https://hooks.slack.com/services/…" autocomplete="off"></label>
${settings.slackWebhookUrl ? html`<label class="check"><input type="checkbox" name="slackRemove"> <span>Stop Slack alerts</span></label>` : EMPTY}
<p><button class="primary" type="submit">Save settings</button></p>
</form>
<div class="stack">
${
  settings.slackWebhookUrl
    ? html`<div class="card stack"><h2>Test Slack</h2><p class="note">Posts one message to the connected channel.</p><form method="post" action="${b}/slack/test" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Send a test message to Slack</button></form></div>`
    : EMPTY
}
<div class="card stack"><h2>Pausing</h2><p class="note">Pause a repository from its page, or tick the box on its SHAPI Dashboard issue. Scans continue; no PRs are opened or updated while paused. Add the <span class="mono">${STOP_LABEL}</span> label to a SHAPI PR to stop updates to that PR.</p></div>
<div class="card stack"><h2>Appearance</h2><p class="note">Light or dark follows your system by default. Change it with the theme buttons at the bottom of the sidebar.</p></div>
</div>
</div>`;
}

/* ---------- billing ---------- */

export function billingPage(data: AccountData, enabled: boolean, notice: string | undefined, csrf: string): Html {
  const b = accountHref(data);
  if (!enabled) return html`${head("Billing", "Billing is not configured on this server; every repository is covered.")}`;
  const privates = data.repos.filter((r) => r.private && r.enabled).length;
  const needed = requiredQuantity(data.repos);
  const billing = data.billing;
  const paying = billing && ["active", "trialing", "past_due"].includes(billing.status);
  const paid = paying ? billing.quantity : 0;
  const form = (action: string, label: string, primary = false) =>
    html`<form method="post" action="${b}/billing/${action}" class="inline"><input type="hidden" name="csrf" value="${csrf}"><button type="submit" class="${primary ? "primary" : ""}">${label}</button></form>`;
  const notices: Record<string, string> = {
    done: "Thanks. Your plan updates as soon as Stripe confirms the payment.",
    updated: "Your plan now covers every private repository.",
    cancelled: "Checkout was cancelled. Nothing was charged.",
  };
  const covered = coverage(data.repos, data.billing, true);
  const uncovered = data.repos.filter((r) => r.enabled && !covered.get(r.id)?.covered);
  return html`${head("Billing", "Public repositories are free, and so is one private repository. Pay only for private repositories beyond that.")}
${notice && notices[notice] ? html`<div class="notice">${notices[notice]}</div>` : EMPTY}
<div class="grid cols-3">
${statCard({ label: "Plan", value: paying ? "Paid" : "Free", sub: paying ? `${paid} paid private ${paid === 1 ? "repository" : "repositories"} plus ${FREE_PRIVATE_REPOS} free` : `public repositories and ${FREE_PRIVATE_REPOS} private repository` })}
${statCard({ label: "Private repositories", value: privates, sub: uncovered.length ? `${uncovered.length} not covered` : "all covered", tone: uncovered.length ? "bad" : "" })}
${statCard({ label: paying && billing?.cancel_at ? "Cancels on" : "Renews", value: paying && billing?.cancel_at ? isoDay(billing.cancel_at) : paying && billing?.current_period_end ? isoDay(billing.current_period_end) : "—", sub: billing?.status === "past_due" ? "payment past due" : paying ? "billed by Stripe" : "no subscription" })}
</div>
<div class="card stack">
<p>${paying ? html`<b>Paid plan</b>: ${paid} private repositor${paid === 1 ? "y" : "ies"} plus ${FREE_PRIVATE_REPOS} free` : html`<b>Free plan</b>: public repositories and ${FREE_PRIVATE_REPOS} private repository`}${billing?.status === "past_due" ? html` ${tag("payment past due", "warn")}` : EMPTY}</p>
<p class="muted">${privates} private repositor${privates === 1 ? "y" : "ies"} installed.${
    paying && billing?.cancel_at
      ? html` ${tag(`Cancels on ${isoDay(billing.cancel_at)}`, "warn")} After that, only public repositories and ${FREE_PRIVATE_REPOS} private repository are scanned.`
      : paying && billing?.current_period_end
        ? html` Renews ${isoDay(billing.current_period_end)}.`
        : ""
  }</p>
<div class="btn-row">
${!paying && needed > 0 ? form("checkout", `Upgrade to cover ${needed} more private repositor${needed === 1 ? "y" : "ies"}`, true) : EMPTY}
${paying && needed > paid ? form("add-repos", `Add ${needed - paid} repositor${needed - paid === 1 ? "y" : "ies"} to the plan`, true) : EMPTY}
${billing?.stripe_customer_id ? form("portal", "Manage billing and invoices") : EMPTY}
</div>
<p class="note">Prices and invoices come from Stripe. Removing private repositories lowers the plan automatically; adding them never raises it without this button.${!paying && needed > 0 ? html` Upgrading means you accept the <a href="${DOCS_URL}/legal/terms">terms of service</a>.` : ""}</p>
</div>
${uncovered.length ? section("Not covered by the plan", html`<div class="card tight"><table><tbody>${uncovered.map((r) => html`<tr><td><a href="${repoHref(data, r.id)}">${r.full_name}</a></td><td class="muted">${(covered.get(r.id) as { reason?: string }).reason ?? ""}</td></tr>`)}</tbody></table></div>`) : EMPTY}`;
}
