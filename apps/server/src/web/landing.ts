import { loadProviders } from "@shapi/core";
import { DOCS_URL, EMPTY, ICONS, LOGO, html, type Html } from "./html";
import { comparisonView, providerMark } from "./views";

interface LandingOptions {
  /** Sign-in is configured on this server. */
  configured: boolean;
  /** The GitHub App's install page. */
  installLink?: string;
  /** Reviewed advisories in the database, when it could be read. */
  advisories?: number;
  /** How many of them SHAPI can fix automatically (they name a recipe). */
  withFix?: number;
  /** Billing is configured: private repositories beyond the free one are paid, so "free during early access" no longer holds. */
  billingEnabled?: boolean;
}

/**
 * The public page for signed-out visitors: what SHAPI does, how, for which APIs, a real catch with
 * its fix, how it treats your code, and what it costs. Every number on it is read from the server.
 */
export function landingPage(opts: LandingOptions): Html {
  const providers = [...loadProviders()].sort((a, b) => a.name.localeCompare(b.name));
  const signIn = (label: string, cls = "primary") =>
    opts.configured ? html`<a class="button ${cls}" href="/login">${label}</a>` : html`<span class="notice warn">Sign-in is not configured on this server yet.</span>`;
  const install = (cls = "primary") => (opts.installLink ? html`<a class="button ${cls}" href="${opts.installLink}">Install the GitHub App</a>` : EMPTY);
  const ctas = opts.installLink ? html`${install()}${signIn("Sign in with GitHub", "ghost")}` : signIn("Sign in with GitHub");
  const ticker = providers.map((p) => html`<span>${providerMark(p.id, "sm")}${p.name}</span>`);
  return html`<div class="landing">
<div class="lp-progress" aria-hidden="true"></div>
<header class="lp-nav"><div class="lp-inner">
  <a class="brand" href="/" aria-label="SHAPI home">${LOGO}</a>
  <nav><a href="#how">How it works</a><a href="#providers">APIs</a><a href="#trust">Security</a><a href="#pricing">Pricing</a><a href="${DOCS_URL}">Docs</a></nav>
  <div class="btn-row">${opts.configured ? html`<a class="button small ghost" href="/login">Sign in</a>` : EMPTY}${opts.installLink ? html`<a class="button small primary" href="${opts.installLink}">Install on GitHub</a>` : EMPTY}</div>
</div></header>

<section class="lp-hero"><div class="lp-inner">
  <div class="lp-copy rise">
    <p class="eyebrow line">For teams that call other people's APIs</p>
    <h1>APIs change.<em>Your code keeps working.</em></h1>
    <p class="lp-lead">Stripe renames a value. GitHub answers 200 instead of 204. SHAPI recognizes calls to GitHub, Stripe, Slack, OpenAI and ${providers.length - 4} more APIs, finds the exact lines a change breaks, and where a fix recipe exists, sends a pull request that fixes them with a test that proves it.</p>
    <div class="btn-row">${ctas}</div>
    <p class="lp-note">Free for public repositories and one private repository.${opts.billingEnabled ? "" : " Free for everyone during early access."}</p>
  </div>
  <div class="lp-shot rise d2">${storyCard()}</div>
</div></section>

<div class="lp-ticker" aria-label="APIs SHAPI recognizes"><div class="track">${ticker}<span aria-hidden="true"></span>${ticker}</div></div>

<section class="lp-stats"><div class="lp-inner">
  <div><b>${providers.length}</b><span>APIs recognized in your code</span></div>
  ${opts.advisories ? html`<div><b>${opts.advisories}</b><span>reviewed API changes</span></div>` : EMPTY}
  <div><b>TS · JS · Python</b><span>scanned; fixes for TS and JS</span></div>
  <div><b>Every fix</b><span>proven by a contract test</span></div>
</div></section>

<section class="lp-section centered" id="problem"><div class="lp-inner">
  <p class="eyebrow line center">The problem</p>
  <h2>Your tests pass.<br><span class="dim">The real API already moved on.</span></h2>
  <div class="lp-problems">
    ${problem("01", html`Your tests mock the API as it was.`, "They keep passing while the provider changes a status code, renames a field or adds a new value.")}
    ${problem("02", html`Deadlines hide in changelogs.`, "A version is retired on a date announced months ago, in a post nobody on your team read.")}
    ${problem("03", html`You find out in <span class="red">production.</span>`, "From an error report, a failed payment or an angry customer, not from your own checks.")}
  </div>
</div></section>

<section class="lp-section centered" id="how"><div class="lp-inner">
  <p class="eyebrow line center">How it works</p>
  <h2>Four steps, all automatic.</h2>
  <div class="lp-steps">
    ${step("01", "Map", "Install the GitHub App. Each push to your default branch is scanned for calls to third-party APIs, through HTTP clients or official SDKs.")}
    ${step("02", "Match", "Each call is checked against reviewed API changes and deadlines: version sunsets, renamed fields, new status codes. Code that breaks is told apart from code that is fine.")}
    ${step("03", "Fix", "For each affected TypeScript or JavaScript call with a fix recipe, SHAPI writes a contract test, confirms it fails, applies the fix, and opens a pull request only once the test passes.")}
    ${step("04", "Watch", "Canaries probe providers every hour and announced changes are researched from changelogs, so the next change reaches you as a pull request or an alert, not an incident.")}
  </div>
</div></section>

<section class="lp-section alt" id="providers"><div class="lp-inner">
  <p class="eyebrow line">Coverage</p>
  <h2>${providers.length} APIs SHAPI recognizes in your code.</h2>
  <div class="lp-providers">${providers.map((p) => html`<span class="lp-provider">${providerMark(p.id, "sm")}${p.name}</span>`)}</div>
</div></section>

<section class="lp-section" id="proof"><div class="lp-inner lp-proof">
  <div>
    <p class="eyebrow line">A real break</p>
    <h2>GitHub changed a status code. Nobody announced it.</h2>
    <p class="lead">In December 2025, GitHub's workflow dispatch endpoint started answering <b>200 OK</b> with a body instead of <b>204 No Content</b>. The docs still said 204. Code that required exactly 204 treated every successful deploy as a failure.</p>
    <p class="lead">SHAPI finds each place your code checks for 204, proves the break with a test, and opens the fix.</p>
  </div>
  <div class="stack">
    ${comparisonView({ expected: { value: "204 No Content", caption: "The status the code checks for" }, actual: { value: "200 OK", caption: "What GitHub returns now" } })}
    <pre class="diff lp-scrub"><div class="file"><span>src/deploy.ts</span><span class="muted">+1 −1</span></div><span class="l hunk">@@ -19,7 +19,7 @@</span><span class="l del">-  if (res.status !== 204) {</span><span class="l add">+  if (![200, 204].includes(res.status)) {</span><span class="l">     throw new Error(\`deploy dispatch failed with \${res.status}\`);</span></pre>
    <p class="note">The fix SHAPI opened on its demo project: <a href="https://github.com/SriVarshini09/shapi-demo/pull/2">shapi-demo pull request #2</a>.</p>
  </div>
</div></section>

<section class="lp-section alt" id="trust"><div class="lp-inner">
  <p class="eyebrow line">Security</p>
  <h2>Built to be let into your repositories.</h2>
  <div class="lp-trust">
    ${trust("No user token kept", "Sign-in reads who you are and which installations you can open, then drops the GitHub token. Sessions are stored only as a hash.")}
    ${trust("Pull requests, never pushes", "Every change arrives as a pull request on its own branch. You review and merge; SHAPI never writes to your default branch.")}
    ${trust("Verified in a sandbox", "Fixes and their tests run in an isolated sandbox. Dependencies install from the package registry, then the network is cut.")}
    ${trust("AI only if you opt in", `Fixes come from deterministic recipes${opts.advisories && opts.withFix ? ` (${opts.withFix} of the ${opts.advisories} reviewed changes have one today)` : ""}. Claude is used only when you turn it on, and its change is kept only if the test passes.`)}
  </div>
  <p class="note"><a href="${DOCS_URL}/security">Read the security page</a></p>
</div></section>

<section class="lp-section" id="pricing"><div class="lp-inner">
  <p class="eyebrow line">Pricing</p>
  <h2>Start free. Pay for private repositories as you grow.</h2>
  <div class="lp-pricing">
    <div class="card price"><h3>Free</h3><p class="lead">For open source and trying SHAPI on real code.</p><ul>${["Every public repository", "One private repository", "Scans, alerts and fix pull requests", "Slack alerts"].map((x) => html`<li>${ICONS.check}${x}</li>`)}</ul>${signIn("Start free")}</div>
    <div class="card price featured"><h3>Team</h3><p class="lead">For companies whose product runs on other people's APIs.</p><ul>${["Everything in Free", "Each private repository beyond the first", "A monthly price per repository, announced before anyone is charged", ...(opts.billingEnabled ? [] : ["Free during early access"]), "Cancel any time from the billing portal"].map((x) => html`<li>${ICONS.check}${x}</li>`)}</ul>${signIn("Sign in to upgrade", "")}</div>
  </div>
</div></section>

<section class="lp-cta"><div class="lp-inner">
  <h2>Know before <em>it breaks.</em></h2>
  <p>Install in a minute. SHAPI scans your repositories right away, then on every push.</p>
  <div class="btn-row">${ctas}</div>
</div></section>

<footer class="lp-foot"><div class="lp-inner">
  <span class="brand-sm" aria-label="SHAPI">${LOGO}</span>
  <nav><a href="${DOCS_URL}">Docs</a><a href="${DOCS_URL}/security">Security</a><a href="${DOCS_URL}/legal/privacy">Privacy</a><a href="${DOCS_URL}/legal/terms">Terms</a></nav>
</div></footer>
</div>`;
}

function step(n: string, title: string, text: string): Html {
  return html`<div class="lp-step"><span class="lp-step-n">${n}</span><h3>${title}</h3><p>${text}</p></div>`;
}

function problem(n: string, title: Html, text: string): Html {
  return html`<div class="lp-problem"><div class="n">${n}</div><div><h3>${title}</h3><p>${text}</p></div></div>`;
}

function trust(title: string, text: string): Html {
  return html`<div class="lp-trust-item"><span class="icon ok">${ICONS.check}</span><div><b>${title}</b><p class="note">${text}</p></div></div>`;
}

/**
 * The hero's picture, from the GitHub incident below and SHAPI's demo project (src/deploy.ts): the code
 * works, GitHub changes, line 22 breaks, SHAPI types the fix. Each state is stacked in place and shown in turn by a CSS loop (no script); with
 * reduced motion only the fixed state shows.
 */
function storyCard(): Html {
  const before = html`<span class="k">if</span> (res.status !== 204) {`;
  const after = html`<span class="k">if</span> (![200, 204].includes(res.status)) {`;
  const line = (n: number, code: Html | string) => html`<span class="ln"><span class="no">${n}</span><span>${code}</span></span>`;
  return html`<div class="story" role="img" aria-label="GitHub changes its API, a line of code breaks, and SHAPI fixes it with a tested pull request">
<div class="story-bar"><span class="file">src/deploy.ts</span><span class="stack-cell story-badges"><span class="tag s1">works</span><span class="tag warn s2">changed</span><span class="tag bad s3">breaks</span><span class="tag ok s4">fixed</span></span></div>
<pre class="story-code">${line(13, html`<span class="k">const</span> res = <span class="k">await</span> fetch(\`…/dispatches\`, {`)}${line(14, '  method: "POST",')}${line(21, "});")}<span class="ln hot"><span class="no">22</span><span class="stack-cell"><span class="txt before">${before}</span><span class="txt after">${after}</span></span></span>${line(23, "  throw new Error(`deploy dispatch failed with ${res.status}`);")}${line(24, "}")}</pre>
<div class="story-event stack-cell">
<p class="s1"><i></i><span>Watching <b>GitHub</b> for changes to the endpoints this code calls.</span></p>
<p class="s2"><i></i><span><b>GitHub changed.</b> workflow_dispatch now answers 200 with a body, not 204.</span></p>
<p class="s3"><i></i><span><b>Line 22 breaks.</b> It only accepts 204, so every successful deploy now throws.</span></p>
<p class="s4"><i></i><span><b>Fixed.</b> A contract test failed before the fix and passes after it. Pull request opened.</span></p>
</div>
<div class="story-progress"><i></i></div>
</div>`;
}
