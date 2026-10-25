import { loadProviders } from "@shapi/core";
import { DOCS_URL, EMPTY, ICONS, LOGO, html, type Html } from "./html";
import { comparisonView, providerMark } from "./views";

export interface LandingOptions {
  /** Sign-in is configured on this server. */
  configured: boolean;
  /** The GitHub App's install page. */
  installLink?: string;
  /** Reviewed advisories in the database, when it could be read. */
  advisories?: number;
}

/**
 * The public page for signed-out visitors: what SHAPI does, how, for which APIs, a real catch with
 * its fix, how it treats your code, and what it costs. Every number on it is read from the server.
 */
export function landingPage(opts: LandingOptions): Html {
  const providers = [...loadProviders()].sort((a, b) => a.name.localeCompare(b.name));
  const signIn = (label: string, cls = "primary") =>
    opts.configured ? html`<a class="button ${cls}" href="/login">${label}</a>` : html`<span class="notice warn">Sign-in is not configured on this server yet.</span>`;
  const install = opts.installLink ? html`<a class="button ghost" href="${opts.installLink}">Install the GitHub App</a>` : EMPTY;
  return html`<div class="landing">
<header class="lp-nav"><div class="lp-inner">
  <a class="brand" href="/" aria-label="SHAPI home">${LOGO}</a>
  <nav><a href="#how">How it works</a><a href="#providers">APIs</a><a href="#trust">Security</a><a href="#pricing">Pricing</a><a href="${DOCS_URL}">Docs</a></nav>
  ${opts.configured ? html`<a class="button small" href="/login">Sign in</a>` : EMPTY}
</div></header>

<section class="lp-hero"><div class="lp-inner">
  <div class="lp-copy">
    <p class="eyebrow">Breaking-change protection for third-party APIs</p>
    <h1>Third-party APIs change.<br><span class="hl">Your code shouldn't break.</span></h1>
    <p class="lp-lead">SHAPI finds every call your code makes to GitHub, Stripe, Slack, OpenAI and ${providers.length - 4} more APIs. It tells you when a change hits your code and opens a pull request with a fix that a test proves.</p>
    <div class="btn-row">${signIn("Sign in with GitHub")}${install}</div>
    <p class="lp-note">Free for public repositories and one private repository. Free for everyone during early access.</p>
  </div>
  <div class="lp-shot" aria-label="Example of a catch and its fix">${exampleCatch()}</div>
</div></section>

<section class="lp-stats"><div class="lp-inner">
  <div><b>${providers.length}</b><span>APIs watched</span></div>
  ${opts.advisories ? html`<div><b>${opts.advisories}</b><span>reviewed API changes</span></div>` : EMPTY}
  <div><b>TS · JS · Python</b><span>HTTP clients and SDKs</span></div>
  <div><b>Every fix</b><span>proven by a contract test</span></div>
</div></section>

<section class="lp-section" id="how"><div class="lp-inner">
  <p class="eyebrow">How it works</p>
  <h2>From install to a tested fix, without a meeting.</h2>
  <div class="lp-steps">
    ${step("1", ICONS.scan, "Map every call", "Install the GitHub App. Each push to your default branch is scanned for calls to third-party APIs, through HTTP clients or official SDKs.")}
    ${step("2", ICONS.advisories, "Match against real changes", "Each call is checked against a reviewed database of API changes: version sunsets, renamed fields, new status codes, auth and scope changes. Canaries watch live APIs for the undocumented ones.")}
    ${step("3", ICONS.fixes, "Fix with proof", "For each affected call, SHAPI writes a contract test, confirms it fails, applies the fix, and opens a pull request only once the test passes.")}
  </div>
</div></section>

<section class="lp-section alt" id="providers"><div class="lp-inner">
  <p class="eyebrow">Coverage</p>
  <h2>${providers.length} APIs your product depends on.</h2>
  <div class="lp-providers">${providers.map((p) => html`<span class="lp-provider">${providerMark(p.id, "sm")}${p.name}</span>`)}</div>
</div></section>

<section class="lp-section" id="proof"><div class="lp-inner lp-proof">
  <div>
    <p class="eyebrow">A real break</p>
    <h2>GitHub changed a status code. Nobody announced it.</h2>
    <p class="lead">In December 2025, GitHub's workflow dispatch endpoint started answering <b>200 OK</b> with a body instead of <b>204 No Content</b>. The docs still said 204. Code that required exactly 204 treated every successful deploy as a failure.</p>
    <p class="lead">SHAPI finds each place your code checks for 204, proves the break with a test, and opens the fix.</p>
  </div>
  <div class="stack">
    ${comparisonView({ expected: { value: "204 No Content", caption: "The status the code checks for" }, actual: { value: "200 OK", caption: "What GitHub returns now" } })}
    <pre class="diff"><div class="file"><span>src/ops/deploy.ts</span><span class="muted">+1 −1</span></div><span class="l hunk">@@ -11,3 +11,3 @@</span><span class="l del">-  if (res.status !== 204) throw new Error(\`dispatch failed: \${res.status}\`);</span><span class="l add">+  if (![200, 204].includes(res.status)) throw new Error(\`dispatch failed: \${res.status}\`);</span><span class="l">   return { started: true };</span></pre>
  </div>
</div></section>

<section class="lp-section alt" id="trust"><div class="lp-inner">
  <p class="eyebrow">Security</p>
  <h2>Built to be let into your repositories.</h2>
  <div class="lp-trust">
    ${trust("No user token kept", "Sign-in reads who you are and which installations you can open, then drops the GitHub token. Sessions are stored only as a hash.")}
    ${trust("Pull requests, never pushes", "Every change arrives as a pull request on its own branch. You review and merge; SHAPI never writes to your default branch.")}
    ${trust("Verified in a sandbox", "Fixes and their tests run in an isolated sandbox. Dependencies install from the package registry, then the network is cut.")}
    ${trust("AI only if you opt in", "Deterministic recipes fix most changes. Claude is used only when you turn it on, and its change is kept only if the test passes.")}
  </div>
  <p class="note"><a href="${DOCS_URL}/security">Read the security page</a></p>
</div></section>

<section class="lp-section" id="pricing"><div class="lp-inner">
  <p class="eyebrow">Pricing</p>
  <h2>Start free. Pay for private repositories as you grow.</h2>
  <div class="lp-pricing">
    <div class="card price"><h3>Free</h3><p class="lead">For open source and trying SHAPI on real code.</p><ul>${["Every public repository", "One private repository", "Scans, alerts and fix pull requests", "Slack alerts"].map((x) => html`<li>${ICONS.check}${x}</li>`)}</ul>${signIn("Start free")}</div>
    <div class="card price featured"><h3>Team</h3><p class="lead">For companies whose product runs on other people's APIs.</p><ul>${["Everything in Free", "Each private repository beyond the first", "A monthly price per repository, announced before anyone is charged", "Free during early access", "Cancel any time from the billing portal"].map((x) => html`<li>${ICONS.check}${x}</li>`)}</ul>${signIn("Sign in to upgrade", "")}</div>
  </div>
</div></section>

<section class="lp-cta"><div class="lp-inner">
  <h2>Know before your integrations break.</h2>
  <p>Install in a minute. SHAPI scans your repositories right away, then on every push.</p>
  <div class="btn-row">${signIn("Sign in with GitHub")}${install}</div>
</div></section>

<footer class="lp-foot"><div class="lp-inner">
  <span class="brand-sm" aria-label="SHAPI">${LOGO}</span>
  <nav><a href="${DOCS_URL}">Docs</a><a href="${DOCS_URL}/security">Security</a><a href="${DOCS_URL}/legal/privacy">Privacy</a><a href="${DOCS_URL}/legal/terms">Terms</a></nav>
</div></footer>
</div>`;
}

function step(n: string, icon: Html, title: string, text: string): Html {
  return html`<div class="card lp-step"><span class="lp-step-n">${n}</span><span class="icon info">${icon}</span><h3>${title}</h3><p class="note">${text}</p></div>`;
}

function trust(title: string, text: string): Html {
  return html`<div class="lp-trust-item"><span class="icon ok">${ICONS.check}</span><div><b>${title}</b><p class="note">${text}</p></div></div>`;
}

/** The hero's picture: what a catch looks like in the app, drawn from the GitHub incident above. */
function exampleCatch(): Html {
  return html`<div class="card catch lp-catch">
<div class="catch-head">${providerMark("github")}<div><p class="eyebrow">GitHub · acme/payments-api · just now</p><h3>workflow_dispatch returns 200 with a body instead of 204</h3></div></div>
<div class="catch-flow"><span class="chip fail">${ICONS.cross} Failing before · 1 failed</span><span class="flow-arrow">${ICONS.arrow}</span><span class="chip pass">${ICONS.check} Passing after · 1 passed</span></div>
<pre class="diff mini"><div class="file"><span>src/ops/deploy.ts</span><span class="muted">+1 −1</span></div><span class="l del">-  if (res.status !== 204) throw …</span><span class="l add">+  if (![200, 204].includes(res.status)) throw …</span></pre>
<div class="btn-row"><span class="button primary">${ICONS.external} Review fix PR</span><span class="tag ok">contract test passes</span></div>
</div>`;
}
