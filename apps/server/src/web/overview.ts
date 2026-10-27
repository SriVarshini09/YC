import { DOCS_URL, EMPTY, ICONS, MARK, html, plural, shortSha, timeAgo, type Html } from "./html";
import {
  attentionOf,
  deadlinesOf,
  firstScanPending,
  healthOf,
  latestCatchOf,
  providersOf,
  setupOf,
  valueOf,
  type AccountData,
  type AttentionItem,
  type LatestCatch,
  type Setup,
} from "./queries";
import {
  accountHref,
  findingHref,
  healthRing,
  prLink,
  progressBar,
  providerMark,
  providerName,
  repoHref,
  section,
  stateTag,
  tag,
  type ActivityEvent,
} from "./views";
import type { FixRepair, FixTestRun } from "@shapi/db";

/**
 * The account's home. It leads with what SHAPI found and fixed, then what needs the user, then the
 * detail. Before the first scan it is a welcome or a scanning page, with a setup checklist until the
 * account has its first verified fix.
 */
export function overviewPage(data: AccountData, opts: { installLink?: string } = {}): Html {
  const setup = setupOf(data);
  const checklist = setup.complete ? EMPTY : setupCard(data, setup, opts.installLink);
  if (!data.repos.length) return html`${welcomeCard(data, opts.installLink)}${checklist}`;
  if (firstScanPending(data)) return html`${scanningCard(data)}${checklist}`;

  const b = accountHref(data);
  const attention = attentionOf(data);
  const coming = deadlinesOf(data).filter((d) => d.daysUntil >= 0 && d.daysUntil <= 90 && (d.breaking || d.working));
  return html`${valueHero(data)}
${checklist}
<div class="grid cols-3 even">
  <div class="span-2 column" id="attention">${section("Needs your attention", attentionCard(data, attention), attention.length ? { label: "All problems", href: `${b}/findings` } : undefined)}</div>
  <div class="column">${section("Coming up", comingCard(data, coming), { label: "All API changes", href: `${b}/advisories` })}</div>
</div>
${section("Latest fix", catchCard(data, latestCatchOf(data)))}`;
}

/** API changes due in the next 90 days that touch the account's code. */
function comingCard(data: AccountData, coming: ReturnType<typeof deadlinesOf>): Html {
  if (!coming.length) return html`<div class="card all-clear"><span class="icon ok">${ICONS.check}</span><div><b>Nothing coming up</b><p class="note">No API change in the next 90 days touches your code.</p></div></div>`;
  const b = accountHref(data);
  return html`<div class="card coming">${coming.slice(0, 5).map((d) => {
    const tone = d.daysUntil <= 30 ? "bad" : "warn";
    return html`<div class="deadline"><div class="days ${tone}">${d.daysUntil}<small>${d.daysUntil === 1 ? "day" : "days"}</small></div><div class="what"><a href="${b}/advisories?advisory=${encodeURIComponent(d.advisory.id)}#all"><b>${d.advisory.title}</b></a><div class="sub">${providerName(d.advisory.provider)}</div>${
      d.breaking ? tag(`breaks ${plural(d.breaking, "repo")}`, "bad") : tag("still works", "info")
    }</div></div>`;
  })}${coming.length > 5 ? html`<a class="coming-foot" href="${b}/advisories#timeline">${plural(coming.length - 5, "more change")}</a>` : EMPTY}</div>`;
}

/* ---------- the value statement ---------- */

function valueHero(data: AccountData): Html {
  const b = accountHref(data);
  const v = valueOf(data);
  const callSites = data.repos.reduce((n, r) => n + r.callSites, 0);
  const lastScan = data.scans.find((s) => s.finished_at);
  const eyebrow = `${plural(data.repos.length, "repository", "repositories")} · ${plural(callSites, "API call")} · last scan ${lastScan ? timeAgo(lastScan.finished_at, data.now) : "pending"}`;
  const parts: string[] = [];
  if (v.merged) parts.push(`${v.merged} fixed`);
  if (v.review) parts.push(`${plural(v.review, "fix", "fixes")} ready for review`);
  if (v.open) parts.push(`${v.open} with no fix yet`);
  // One sentence for where things stand: problems with no fix yet plus fixes waiting for review need the user.
  const needs = v.open + v.review;
  const tone = v.open ? "bad" : v.review ? "warn" : "ok";
  const title = needs ? `${plural(needs, "problem")} need${needs === 1 ? "s" : ""} you.` : "All clear.";
  const watching = `SHAPI watches ${plural(providersOf(data).length, "provider")} across ${plural(callSites, "API call")}`;
  const sub = v.caught
    ? `SHAPI found ${plural(v.caught, "problem")} in your code: ${parts.join(" · ") || "all handled"}.`
    : `No problems in your code. ${watching}, and opens a tested fix the moment an API change breaks your code.`;
  return html`<section class="value-hero">
<div class="vh-text">
<p class="eyebrow">${eyebrow}</p>
<div class="status"><span class="status-dot ${tone}" aria-hidden="true"></span><div>
<h1>${title}</h1>
<p class="vh-sub">${sub}</p>
<div class="btn-row">${v.review ? html`<a class="button primary" href="${b}/fixes?state=open">${ICONS.fixes} Review ${plural(v.review, "fix", "fixes")}</a>` : EMPTY}${
    v.open ? html`<a class="button ghost" href="#attention">See what needs you</a>` : html`<a class="button ghost" href="${b}/advisories">See what SHAPI watches</a>`
  }</div>
</div></div>
</div>
<div class="vh-ring">${healthRing(healthOf(data))}</div>
</section>`;
}

/* ---------- the latest catch ---------- */

function catchCard(data: AccountData, c: LatestCatch | undefined): Html {
  if (!c) return html`<div class="card catch empty-catch"><span class="icon ok">${ICONS.check}</span><div><b>No fixes yet</b><p class="note">When an API change breaks your code, the problem and its tested fix show up here.</p></div></div>`;
  const { pr, finding } = c;
  const advisory = pr?.advisory ?? finding?.advisory;
  const provider = advisory?.provider ?? finding?.site.provider ?? "unknown";
  const title = advisory?.title ?? pr?.advisory_id ?? finding!.advisory_id;
  const repo = pr?.repo ?? finding!.repo;
  const when = pr?.created_at ?? finding!.created_at;
  const site = pr?.repair?.sites.find((s) => s.status === "fixed");
  const source = pr?.repair?.changes.find((ch) => ch.kind === "modified");
  const buttons = html`${
    pr?.url && pr.number ? html`<a class="button primary" href="${pr.url}">${ICONS.external} ${pr.state === "open" ? "Review" : "View"} PR #${pr.number}</a>` : EMPTY
  }${finding ? html`<a class="button" href="${findingHref(data, finding.id)}">See the full fix ${ICONS.arrow}</a>` : EMPTY}`;
  const story = site
    ? html`${finding?.reasons.length ? html`<p class="catch-why"><b>Why it broke:</b> ${finding.reasons.join("; ")}</p>` : EMPTY}<div class="catch-flow">${testChip(site.before, "before")}<span class="flow-arrow">${ICONS.arrow}</span>${testChip(site.after, "after")}${pr ? stateTag(pr.state) : EMPTY}</div>${source ? miniDiff(source) : EMPTY}${proofSteps(pr!.repair!)}`
    : html`<p class="catch-why">${finding?.reasons.join("; ") ?? ""}</p><p class="note">${
        advisory?.recipeId ? "SHAPI opens a fix PR after the next fix run, within the account's PR limits." : `No automatic fix for this change. ${advisory?.migrationNote ?? ""}`
      }</p>`;
  return html`<div class="card catch">
<div class="catch-head">${providerMark(provider)}<div><p class="eyebrow">${providerName(provider)} · ${repo} · ${timeAgo(when, data.now)}</p><h3>${finding ? html`<a href="${findingHref(data, finding.id)}">${title}</a>` : title}</h3></div></div>
${story}
<div class="btn-row catch-actions">${buttons}</div>
</div>`;
}

/** How the fix was proven, in four short steps. */
function proofSteps(repair: FixRepair): Html {
  const steps = [
    "Test written",
    "Failed on your code",
    repair.method === "llm" ? "Claude proposed the fix" : repair.recipeId ? `Recipe ${repair.recipeId} applied` : "Fix applied",
    repair.sandbox ? `Passed in sandbox ${repair.sandbox}` : "Passed after the fix",
  ];
  return html`<ol class="proof">${steps.map((s) => html`<li><span class="proof-dot">${ICONS.check}</span><span>${s}</span></li>`)}</ol>`;
}

function testChip(run: FixTestRun | undefined, phase: "before" | "after"): Html {
  if (!run) return html`<span class="chip">${phase === "before" ? "No baseline run" : "Not verified"}</span>`;
  return html`<span class="chip ${run.passed ? "pass" : "fail"}">${run.passed ? ICONS.check : ICONS.cross} ${run.passed ? "Passing" : "Failing"} ${phase} · ${run.tests}</span>`;
}

/** The changed lines of the fix, enough to see what it does; the finding page has the whole diff. */
function miniDiff(change: FixRepair["changes"][number]): Html {
  const changed = change.diff.split("\n").filter((l) => /^[+-]/.test(l));
  const added = changed.filter((l) => l.startsWith("+")).length;
  const removed = changed.length - added;
  return html`<pre class="diff mini"><div class="file"><span>${change.file}</span><span class="muted">+${added} −${removed}</span></div>${changed
    .slice(0, 4)
    .map((l) => html`<span class="l ${l.startsWith("+") ? "add" : "del"}">${l}</span>`)}</pre>`;
}

/* ---------- what needs the user ---------- */

const ATTENTION_SHOWN = 5;

function attentionCard(data: AccountData, items: AttentionItem[]): Html {
  if (!items.length) return html`<div class="card all-clear"><span class="icon ok">${ICONS.check}</span><div><b>All clear</b><p class="note">Nothing needs you right now. SHAPI keeps watching.</p></div></div>`;
  const rows = items.slice(0, ATTENTION_SHOWN).map((item) => attentionRow(data, item));
  const more = items.length - ATTENTION_SHOWN;
  return html`<div class="card tight todo-list">${rows}${more > 0 ? html`<a class="todo more" href="${accountHref(data)}/findings">${plural(more, "more item")} ${ICONS.arrow}</a>` : EMPTY}</div>`;
}

function attentionRow(data: AccountData, item: AttentionItem): Html {
  const row = (href: string, tone: string, icon: Html, title: Html, sub: string) =>
    html`<a class="todo" href="${href}"><span class="icon ${tone}">${icon}</span><span class="text"><b>${title}</b><span class="sub">${sub}</span></span><span class="go">${ICONS.arrow}</span></a>`;
  switch (item.kind) {
    case "review": {
      const { pr } = item;
      return row(pr.url ?? `${accountHref(data)}/fixes?state=open`, "info", ICONS.pr, html`Review fix PR ${pr.number ? `#${pr.number}` : pr.branch}`, `${pr.advisory?.title ?? pr.advisory_id} · ${pr.repo}`);
    }
    case "manual":
      return row(findingHref(data, item.finding.id), "bad", ICONS.alert, html`Fix by hand: ${item.finding.advisory?.title ?? item.finding.advisory_id}`, `${item.finding.repo} · no automatic fix for this change`);
    case "closed":
      return row(findingHref(data, item.finding.id), "warn", ICONS.cross, html`Decide on: ${item.finding.advisory?.title ?? item.finding.advisory_id}`, `${item.finding.repo} · fix PR ${item.pr?.number ? `#${item.pr.number} ` : ""}was closed without merging`);
    case "scan-failed":
      return row(repoHref(data, item.repo.id), "bad", ICONS.scan, html`Scan failed in ${item.repo.full_name}`, item.repo.scan?.error ?? "see the repository page");
    case "deadline":
      return row(
        `${accountHref(data)}/advisories?advisory=${encodeURIComponent(item.deadline.advisory.id)}`,
        "warn",
        ICONS.deadlines,
        html`${item.deadline.advisory.title}`,
        `${providerName(item.deadline.advisory.provider)} · takes effect in ${plural(item.deadline.daysUntil, "day")}`,
      );
    case "pending":
      return row(findingHref(data, item.finding.id), "", ICONS.pr, html`Fix on the way: ${item.finding.advisory?.title ?? item.finding.advisory_id}`, `${item.finding.repo} · SHAPI opens it on the next fix run`);
  }
}

/* ---------- first run ---------- */

function setupCard(data: AccountData, setup: Setup, installLink: string | undefined): Html {
  const b = accountHref(data);
  const cta = (key: string, state: string): Html => {
    if (state === "done") return EMPTY;
    if (key === "install" && installLink) return html`<a class="button primary" href="${installLink}">Install the app</a>`;
    if (key === "slack") return html`<a class="button" href="${b}/settings">Connect Slack</a>`;
    if (key === "fix" && state === "active") return html`<a class="button primary" href="${b}/fixes?state=open">Review the fix</a>`;
    return EMPTY;
  };
  return html`<section class="card setup">
<div class="setup-head"><div><h2>Get started</h2><p class="note">Four steps from install to your first verified fix.</p></div><span class="setup-count">${setup.done} of ${setup.steps.length} done</span></div>
${progressBar(setup.done, setup.steps.length)}
<ol class="setup-steps">${setup.steps.map(
    (s, i) => html`<li class="step-${s.state}"><span class="step-dot">${s.state === "done" ? ICONS.check : String(i + 1)}</span><div class="what"><b>${s.label}</b><span class="sub">${s.detail}</span></div>${cta(s.key, s.state)}</li>`,
  )}</ol>
</section>`;
}

function welcomeCard(data: AccountData, installLink: string | undefined): Html {
  const step = (icon: Html, title: string, text: string) => html`<div class="mini-step"><span class="icon info">${icon}</span><b>${title}</b><span class="note">${text}</span></div>`;
  return html`<section class="card welcome">
<span class="mark big">${MARK}</span>
<h1>Welcome to SHAPI, ${data.account.login}</h1>
<p class="lead">Install the GitHub App on the repositories you want watched. SHAPI maps every call your code makes to a third-party API, checks it against ${plural(data.advisories.size, "reviewed API change")}, and opens a pull request with a tested fix when one breaks your code.</p>
<div class="btn-row">${installLink ? html`<a class="button primary" href="${installLink}">Install the GitHub App</a>` : EMPTY}<a class="button" href="${DOCS_URL}">How SHAPI works</a></div>
<div class="mini-steps">
${step(ICONS.scan, "Map", "Every HTTP and SDK call to a third-party API, on each push.")}
${step(ICONS.advisories, "Match", "Against reviewed changes: sunsets, renames, new status codes.")}
${step(ICONS.fixes, "Fix", "A pull request whose contract test fails before and passes after.")}
</div>
</section>`;
}

function scanningCard(data: AccountData): Html {
  const total = data.repos.length;
  const finished = data.repos.filter((r) => r.scan?.status === "succeeded" || r.scan?.status === "failed").length;
  const state = (status: string | undefined) => (status === "running" ? tag("scanning", "info") : status === "failed" ? tag("failed", "bad") : status === "succeeded" ? tag("done", "ok") : tag("queued", ""));
  return html`<section class="card scanning">
<div class="scan-head"><span class="pulse" aria-hidden="true"></span><div><h1>Scanning your repositories</h1><p class="lead">SHAPI is mapping every third-party API call in your code. This page refreshes by itself.</p></div></div>
${progressBar(finished, total)}
<p class="note">${finished} of ${plural(total, "repository", "repositories")} finished</p>
<ul class="scan-list">${data.repos.map((r) => html`<li><span>${r.full_name}</span><span>${state(r.scan?.status)}${r.scan ? html` <span class="mono muted">${shortSha(r.scan.sha)}</span>` : EMPTY}</span></li>`)}</ul>
</section>`;
}

/* ---------- activity ---------- */

/** Scans, fixes and new problems, newest first. Shown on the Repositories page. */
export function activityOf(data: AccountData, limit = 8): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const s of data.scans) {
    if (!s.finished_at && s.status !== "failed") continue;
    events.push({
      at: s.finished_at ?? s.created_at,
      kind: "scan",
      tone: s.status === "succeeded" ? "ok" : s.status === "failed" ? "bad" : "",
      text: html`Scan of <a href="${repoHref(data, s.repository_id)}">${s.repo}</a> ${s.status} at <span class="mono">${shortSha(s.sha)}</span>`,
      ...(s.error ? { sub: s.error } : {}),
    });
  }
  for (const p of data.prs) {
    const title = p.advisory?.title ?? p.advisory_id;
    const link = prLink(p);
    events.push({ at: p.created_at, kind: "pr", tone: "info", text: html`Fix PR ${link} opened in ${p.repo}`, sub: title });
    if (p.state !== "open" && p.closed_at) events.push({ at: p.closed_at, kind: p.state === "merged" ? "merged" : "closed", tone: p.state === "merged" ? "ok" : "", text: html`Fix PR ${link} ${p.state} in ${p.repo}`, sub: title });
  }
  const newProblems = new Map<string, { at: Date; repo: string; repository_id: string; changes: Set<string> }>();
  for (const f of data.findings.filter((f) => f.kind === "affected")) {
    const key = `${f.repository_id}:${f.created_at.toISOString().slice(0, 16)}`;
    const e = newProblems.get(key) ?? { at: f.created_at, repo: f.repo, repository_id: f.repository_id, changes: new Set<string>() };
    e.changes.add(f.advisory_id);
    newProblems.set(key, e);
  }
  for (const e of newProblems.values()) events.push({ at: e.at, kind: "finding", tone: "bad", text: html`${plural(e.changes.size, "problem")} found in <a href="${repoHref(data, e.repository_id)}">${e.repo}</a>` });
  return events.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
