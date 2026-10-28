<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { withBase } from "vitepress";
import { data } from "../../advisories.data";

// The landing page (site/index.md). Every picture on it is a real SHAPI artifact: the demo project's
// src/deploy.ts and its api.lock entry, the canary's shape diff, the GitHub advisory, the contract
// test SHAPI generated, shapi-demo PR #2 and the real `shapi scan` output. The API changes and the
// numbers come from the advisories loader, so nothing goes stale.
//
// Most sections are taller than the screen and pin a stage (position: sticky) while you scroll
// through them. One requestAnimationFrame loop reads how far through each section you are (0 → 1)
// and moves its stage: discrete states (which step, which pane) are refs, continuous movement is
// written straight to the element's style. The markup renders readable before the script runs, and
// with reduced motion the page still follows the scroll but nothing moves on its own.

const INSTALL = "https://github.com/apps/shapi-by-srivarshini/installations/new";
const days = (d: string) => Math.ceil((Date.parse(d) - Date.parse(data.builtOn)) / 86400000);
const inDays = (d: string) => (days(d) === 1 ? "tomorrow" : `in ${days(d)} days`);
const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
// From tomorrow on: changes that take effect today are no longer "coming up".
const ahead = data.upcoming.filter((a) => days(a.effectiveDate) >= 1);
const ringCards = ahead.slice(0, 16);

// The demo project (fixtures/demo-ts): which provider each file calls, how many call sites, and what
// `shapi scan` flags in it: GitHub breaks now (critical), QuickBooks and HubSpot are high, Stripe is fine.
const providers = [
  { key: "github", mark: "Gh", name: "GitHub", file: "deploy.ts", sites: 2, flag: "critical" },
  { key: "stripe", mark: "St", name: "Stripe", file: "billing.ts", sites: 1, flag: "" },
  { key: "hubspot", mark: "Hs", name: "HubSpot", file: "crm.ts", sites: 1, flag: "high" },
  { key: "quickbooks", mark: "Qb", name: "QuickBooks", file: "accounting.ts", sites: 1, flag: "high" },
];
const SOURCE = [
  [14, '    method: "POST",'],
  [15, "    headers: {"],
  [16, '      Accept: "application/vnd.github+json",'],
  [17, "      Authorization: `Bearer ${token}`,"],
  [18, '      "X-GitHub-Api-Version": "2022-11-28",'],
  [19, "    },"],
  [20, "    body: JSON.stringify({ ref: req.ref }),"],
  [21, "  });"],
] as const;
const OLD = "if (res.status !== 204) {";
const NEW = "if (![200, 204].includes(res.status)) {";

// The hero's story, in the order the scroll plays it.
type Phase = "map" | "match" | "fix" | "prove" | "ship";
const PHASES: Phase[] = ["map", "match", "fix", "prove", "ship"];
const STEP_NAMES = ["Map", "Match", "Fix", "Prove", "Ship"];
const STATUS: Record<Phase, string> = { map: "SHAPI · mapping", match: "SHAPI · 1 critical · 2 high", fix: "SHAPI · test written", prove: "SHAPI · applying fix", ship: "SHAPI · PR #2 opened" };
const CAPTION: Record<Phase, [string, string]> = {
  map: ["4 files · 5 call sites · 4 providers,", " mapped in 63 ms."],
  match: ["GitHub changed workflow_dispatch: line 22 breaks.", " QuickBooks and HubSpot are flagged high. Stripe is fine."],
  fix: ["A contract test is written first.", " Against the current code, it fails."],
  prove: ["Recipe status-code-accept-set", " is rewriting line 22."],
  ship: ["Fix PR #2 opened,", " with the test and the evidence attached."],
};
const phase = ref<Phase>("map");
const typed = ref(-1); // how much of NEW is typed on line 22; -1 shows OLD
// The test passes only once the fix is fully typed.
const passed = computed(() => phase.value === "ship" || (phase.value === "prove" && typed.value >= NEW.length));
const broken = computed(() => !passed.value && phase.value !== "map");
const mended = passed;
const flagged = computed(() => phase.value !== "map");
const status = computed(() => (phase.value === "prove" && passed.value ? "SHAPI · test passes" : STATUS[phase.value]));
const caption = computed<[string, string]>(() => (phase.value === "prove" && passed.value ? ["The same test now passes.", " The change is kept."] : CAPTION[phase.value]));
const chipNote = (p: (typeof providers)[number]) => (!flagged.value ? String(p.sites) : p.key === "github" && mended.value ? "fixed" : p.flag || "✓ not affected");
const hotText = computed(() => (typed.value < 0 ? OLD : NEW.slice(0, typed.value)));

// The problem, word by word. Each word but the last keeps its space: Vue drops whitespace between elements.
const PROBLEM = "Your tests mock the API as it was. GitHub started answering 200 instead of 204, told no one, and every deploy that checked for 204 failed in production.";
const problemWords = PROBLEM.split(" ").map((w, i, all) => (i < all.length - 1 ? `${w} ` : w));

// "How it works": the pane beside the step at the middle of the screen.
const PANE_TITLES = ["api.lock", "canary · github · workflow_dispatch", "shapi scan", "shapi fix · recipe status-code-accept-set", "github.com/SriVarshini09/shapi-demo/pull/2"];
const pane = ref(0);

// The same morning, two ways: flips at the middle of its section, or with the switch.
const withShapi = ref(false);

// The real output of `npx shapi-cli scan .` on the demo project, printed as you scroll.
const hubspotDays = days("2026-12-04");
const TERM: [string, string][] = [
  ['<span class="c">$</span> npx shapi-cli scan .', ""],
  ["SHAPI scan  .", ""],
  ["4 files · 5 call sites · 4 providers · 63 ms", "c"],
  ["", ""],
  ["Providers", ""],
  ["  github      2 call sites", ""],
  ["  hubspot     1 call site    @hubspot/api-client", ""],
  ["  quickbooks  1 call site", ""],
  ["  stripe      1 call site    stripe", ""],
  ["", ""],
  ["Affected call sites (3)", ""],
  ['  <span class="crit">CRITICAL</span>  src/deploy.ts:13  POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches', ""],
  ["            workflow_dispatch returns 200 with a body instead of 204", ""],
  ["            why: compares the response status to 204", "c"],
  ['  <span class="high">HIGH</span>      src/accounting.ts:7  GET /v3/company/{realmId}/query', ""],
  ["            Minor versions below 75 are silently answered as minor version 75", ""],
  ["            why: sends minorversion=65 (below 75)", "c"],
  ['  <span class="high">HIGH</span>      src/crm.ts:6  GET /crm-pipelines/v1/pipelines/deals', ""],
  ["            Pipelines API v1 retired on 2026-12-04", ""],
  ...((hubspotDays > 0 && hubspotDays <= 90
    ? [["", ""], ["Deadlines in the next 90 days", ""], [`  2026-12-04 (${hubspotDays} days)  hubspot  Pipelines API v1 retired on 2026-12-04  1 call site`, ""]]
    : []) as [string, string][]),
];
const termShown = ref(TERM.length);
const termHtml = computed(() => TERM.slice(0, termShown.value).map(([l, c]) => (c ? `<span class="${c}">${l}</span>` : l)).join("\n") + (termShown.value < TERM.length ? '\n<span class="caret"></span>' : ""));

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (t: number) => 1 - Math.pow(1 - t, 3);
const rect = (el: Element) => el.getBoundingClientRect();
// How far through a pinned section the page is: 0 when it reaches the top, 1 when its end does.
const prog = (el: Element) => { const r = rect(el); return clamp(-r.top / Math.max(1, r.height - innerHeight)); };
// How far an element has travelled through the screen, from entering at the bottom to leaving at the top.
const through = (el: Element) => { const r = rect(el); return clamp((innerHeight - r.top) / (innerHeight + r.height)); };
const inView = (el: Element) => { const r = rect(el); return r.bottom > 0 && r.top < innerHeight; };

const root = ref<HTMLElement>();
let alive = true;
let raf = 0;
let lenis: { raf(t: number): void; destroy(): void } | undefined;
let stopListeners = () => {};

onMounted(async () => {
  const el = root.value!;
  const $ = <T extends Element = HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const $$ = <T extends Element = HTMLElement>(s: string) => [...el.querySelectorAll<T>(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.classList.add("motion");

  const css = getComputedStyle(el);
  const color = (name: string) => css.getPropertyValue(name).trim();
  const C = { ink: color("--ink"), break: color("--break"), fixed: color("--fixed"), soon: color("--soon") };
  const rgba = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

  let mx = 0.5;
  let my = 0.5;
  const onPointer = (e: PointerEvent) => { mx = e.clientX / innerWidth; my = e.clientY / innerHeight; };

  // 1. hero: threads run from each provider to the file that calls it, then the story plays.
  const hero = $("#hero"), canvas = $<HTMLCanvasElement>("#threads"), ctx = canvas.getContext("2d")!;
  const copy = $(".hero-copy"), rig = $(".rig"), caption = $(".caption");
  const chips = $$(".prov"), files = $$(".tree .file[data-k]");
  let rise = 0;
  const onResize = () => {
    const d = devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * d; canvas.height = canvas.clientHeight * d; ctx.setTransform(d, 0, 0, d, 0, 0);
    rise = parseFloat(getComputedStyle(rig).getPropertyValue("--rise")) || 0;
  };
  function drawHero(t: number) {
    if (!inView(hero)) return;
    const p = prog(hero);
    // The headline and the editor rise together, so they keep their gap and never overlap.
    const lift = ease(clamp(p / 0.22));
    copy.style.transform = `translateY(${-lift * rise}vh)`;
    copy.style.opacity = String(clamp(1 - lift * 1.6));
    caption.style.opacity = String(clamp((p - 0.06) * 12));
    rig.style.transform = `translateX(-50%) translateY(${-lift * rise}vh)`;
    phase.value = p < 0.24 ? "map" : p < 0.44 ? "match" : p < 0.6 ? "fix" : p < 0.8 ? "prove" : "ship";
    typed.value = phase.value === "ship" ? NEW.length : phase.value === "prove" ? Math.round(clamp((p - 0.6) / 0.12) * NEW.length) : -1;
    if (!reduce) chips.forEach((c, i) => { c.style.transform = `translate(${(mx - 0.5) * 14}px, ${Math.sin(t / 1000 + i) * 4}px)`; });

    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    chips.forEach((chip, ci) => {
      const file = files.find((f) => f.dataset.k === chip.dataset.k);
      if (!file || chip.offsetParent === null || file.offsetParent === null) return;
      const a = rect(chip), b = rect(file), gh = chip.dataset.k === "github", high = chip.dataset.flag === "high" && flagged.value, safe = !chip.dataset.flag && flagged.value;
      const x1 = a.right, y1 = a.top + a.height / 2, x2 = b.left + 6, y2 = b.top + b.height / 2;
      const col = gh && broken.value ? C.break : (gh && mended.value) || safe ? C.fixed : high ? C.soon : C.ink;
      const strong = (gh && flagged.value) || high || safe;
      for (let s = 0; s < 9; s++) {
        const o = (s - 4) * 2.2, wob = reduce ? 0 : Math.sin(t / 1300 + s + ci) * 6;
        const c1x = x1 + (x2 - x1) * 0.45, c1y = y1 + o * 3 + wob, c2x = x1 + (x2 - x1) * 0.6, c2y = y2 + o * 2 - wob;
        ctx.strokeStyle = rgba(col, strong ? 0.35 : 0.11);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x1, y1 + o * 0.6); ctx.bezierCurveTo(c1x, c1y, c2x, c2y, x2, y2 + o * 0.3); ctx.stroke();
        if (reduce) continue;
        // a particle travelling along each strand: the data the call sends and gets back
        const u = (t / (2200 + s * 120) + s * 0.17 + ci * 0.31) % 1, v = 1 - u;
        const px = v * v * v * x1 + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * x2;
        const py = v * v * v * (y1 + o * 0.6) + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * (y2 + o * 0.3);
        ctx.fillStyle = rgba(col, strong ? 0.9 : 0.4);
        ctx.beginPath(); ctx.arc(px, py, strong ? 1.8 : 1.3, 0, 6.29); ctx.fill();
      }
    });
  }

  // 2. the problem, lit word by word
  const scrub = $(".scrub p"), words = $$(".scrub .w");
  function drawScrub() {
    if (!inView(scrub)) return;
    const p = clamp((through(scrub) - 0.22) / 0.42);
    words.forEach((w, i) => { w.style.opacity = String(clamp(p * words.length - i, 0.14, 1)); });
  }

  // 3. how it works: the step nearest the middle of the screen (lower on phones, under the pinned screen)
  const steps = $$(".f");
  function drawPipe() {
    const mid = innerWidth < 1000 ? innerHeight * 0.78 : innerHeight * 0.5;
    let best = 0, bd = Infinity;
    steps.forEach((s, i) => { const r = rect(s), d = Math.abs(r.top + r.height / 2 - mid); if (d < bd) { bd = d; best = i; } });
    pane.value = best;
  }

  // 4. the API changes on a turning ring; the front card is the brightest
  const helix = $("#changes"), ring = $(".ring"), cards = $$(".adv");
  function drawHelix(t: number) {
    if (!inView(helix)) return;
    // on phones the ring is wider than the screen, so one card at a time faces you
    const p = prog(helix), R = innerWidth < 640 ? 260 : Math.min(580, innerWidth * 0.42), step = 360 / cards.length;
    const rot = -p * 300 - (reduce ? 0 : t / 280);
    ring.style.transform = `translateY(${(0.5 - p) * 50}px) rotateX(${-7 + (my - 0.5) * 6}deg) rotateY(${rot}deg)`;
    cards.forEach((c, i) => {
      const front = Math.cos(((i * step + rot) * Math.PI) / 180);
      c.style.transform = `rotateY(${i * step}deg) translateZ(${R}px)`;
      c.style.opacity = (0.1 + 0.9 * Math.pow(Math.max(0, front), 1.6)).toFixed(3);
    });
  }

  // 5. two ways: the scroll flips it once, at the middle; the switch can flip it back
  const two = $("#two");
  let lastHalf: boolean | undefined;
  function drawTwo() {
    if (!inView(two)) return;
    const half = prog(two) > 0.5;
    if (half !== lastHalf) { lastHalf = half; withShapi.value = half; }
  }

  // 6. the terminal prints as you scroll
  const term = $("#cli");
  function drawTerm() {
    if (!inView(term)) return;
    termShown.value = reduce ? TERM.length : Math.round(clamp(prog(term) / 0.75) * TERM.length);
  }

  // 7. your code and the API fit together
  const close = $("#close"), left = $(".fit .code-p"), right = $(".fit .api-p"), tags = $$(".fit .tag");
  function drawClose() {
    if (!inView(close)) return;
    const p = ease(clamp(prog(close) / 0.8));
    left.style.transform = `translate(${(1 - p) * -90}px, ${(1 - p) * 16}px) rotate(${(1 - p) * -12}deg)`;
    right.style.transform = `translate(${(1 - p) * 90}px, ${(1 - p) * -30}px) rotate(${(1 - p) * 14}deg)`;
    right.classList.toggle("joined", p > 0.98);
    tags.forEach((g) => { g.style.opacity = String(clamp(1 - p * 1.3)); });
  }

  const draw = (t: number) => { drawHero(t); drawScrub(); drawPipe(); drawHelix(t); drawTwo(); drawTerm(); drawClose(); };
  const tick = (t: number) => { if (!alive) return; lenis?.raf(t); draw(t); raf = requestAnimationFrame(tick); };
  const onScroll = () => draw(performance.now());

  addEventListener("resize", onResize);
  onResize();
  if (reduce) {
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  } else {
    addEventListener("pointermove", onPointer, { passive: true });
    raf = requestAnimationFrame(tick);
  }
  stopListeners = () => {
    removeEventListener("resize", onResize);
    removeEventListener("scroll", onScroll);
    removeEventListener("pointermove", onPointer);
  };

  // Smooth scrolling, loaded only here so the docs pages keep the browser's own scrolling.
  if (!reduce) {
    const { default: Lenis } = await import("lenis");
    if (alive) lenis = new Lenis({ lerp: 0.09 });
  }
});

onBeforeUnmount(() => {
  alive = false;
  cancelAnimationFrame(raf);
  stopListeners();
  lenis?.destroy();
});
</script>

<template>
  <div ref="root" class="home">
    <!-- 1. hero: the real deploy.ts, mapped, broken by GitHub, fixed and proven -->
    <section id="hero" class="hero">
      <div class="stage">
        <canvas id="threads" aria-hidden="true"></canvas>
        <div class="hero-copy">
          <span class="eyebrow">For teams that call other people's APIs</span>
          <h1>APIs change.<span class="it">Your code keeps working.</span></h1>
          <p class="lede">SHAPI finds the exact lines a third-party API change breaks. Where a fix recipe exists, it opens a pull request that fixes them, with a test that proves it.</p>
          <div class="actions">
            <a class="pill solid" :href="INSTALL">Install the GitHub App</a>
            <a class="pill" :href="withBase('/guide/quickstart')">Try it in your terminal</a>
          </div>
        </div>
        <div class="steps" aria-hidden="true">
          <span v-for="(s, i) in STEP_NAMES" :key="s" :class="{ on: PHASES[i] === phase }">{{ s }}</span>
        </div>
        <div class="rig">
          <div class="provs">
            <div
              v-for="p in providers"
              :key="p.key"
              :class="['prov', { hit: p.key === 'github' && broken, ok: p.key === 'github' && mended, warn: p.flag === 'high' && flagged, safe: !p.flag && flagged }]"
              :data-k="p.key"
              :data-flag="p.flag"
            >
              <i>{{ p.mark }}</i>{{ p.name }}<small>{{ chipNote(p) }}</small>
            </div>
            <div class="more">+ {{ data.providers.length - providers.length }} more providers covered</div>
          </div>
          <div class="desk">
            <div :class="['toast', { on: phase === 'ship' }]"><b>PR #2 opened</b> SHAPI: workflow_dispatch returns 200 with a body instead of 204</div>
            <div class="editor">
              <div class="ed-bar">
                <i></i><i></i><i></i><span class="tab on">deploy.ts</span><span class="tab">api.lock</span>
                <span :class="['ed-status', { bad: broken, ok: mended }]">{{ status }}</span>
              </div>
              <div class="ed-body">
                <div class="tree">
                  <div class="dir">fixtures/demo-ts/src</div>
                  <div
                    v-for="(p, i) in providers"
                    :key="p.key"
                    :class="['file', { cur: i === 0, hit: i === 0 && broken, ok: i === 0 && mended, warn: p.flag === 'high' && flagged, safe: !p.flag && flagged }]"
                    :data-k="p.key"
                  >
                    {{ p.file }} <em>{{ p.sites }}</em>
                  </div>
                  <div class="dir">test/shapi</div>
                  <div :class="['file', 'new', { on: phase !== 'map' && phase !== 'match' }]">github-workflow-dispatch-…test.ts</div>
                </div>
                <pre class="src"><span class="l"><b>13</b>  <span class="k">const res = await fetch</span>(`${GITHUB_API}/repos/${req.owner}/${req.repo}/actions/workflows/…</span><span v-for="[n, l] in SOURCE" :key="n" class="l"><b>{{ n }}</b>{{ l }}</span><span :class="['l', { hit: broken, ok: mended }]"><b>22</b>  <span :class="{ squig: phase === 'match' }">{{ hotText }}</span><span v-if="typed >= 0 && typed < NEW.length" class="caret"></span></span><span class="l"><b>23</b>    throw new Error(`deploy dispatch failed with ${res.status}`);</span><span class="l"><b>24</b>  }</span><span :class="['diag', { on: phase === 'match' }]"><span class="h">SHAPI · CRITICAL · github-workflow-dispatch-204-to-200</span>workflow_dispatch returns 200 with a body instead of 204. This line compares the response status to 204, so every successful deploy now throws.</span></pre>
              </div>
              <div :class="['ed-panel', { on: phase === 'fix' || phase === 'prove' }]">
                <div class="mute">$ npx vitest run test/shapi/github-workflow-dispatch-204-to-200.test.ts</div>
                <template v-if="passed">
                  <div class="good">✓ triggerDeploy handles the before (204) response</div>
                  <div class="good">✓ triggerDeploy handles the after (200) response</div>
                  <div>&nbsp;</div>
                  <div class="good">Tests  2 passed · change kept</div>
                </template>
                <template v-else-if="phase === 'prove'">
                  <div>✓ triggerDeploy handles the before (204) response</div>
                  <div class="bad">✗ triggerDeploy handles the after (200) response</div>
                  <div class="bad">&nbsp;&nbsp;Error: deploy dispatch failed with 200</div>
                  <div class="mute">→ applying recipe status-code-accept-set, then running the test again</div>
                </template>
                <template v-else>
                  <div>✓ triggerDeploy handles the before (204) response</div>
                  <div class="bad">✗ triggerDeploy handles the after (200) response</div>
                  <div class="bad">&nbsp;&nbsp;Error: deploy dispatch failed with 200</div>
                  <div class="bad">Tests  1 failed | 1 passed</div>
                </template>
              </div>
            </div>
          </div>
        </div>
        <p class="caption"><b>{{ caption[0] }}</b>{{ caption[1] }}</p>
      </div>
    </section>

    <!-- 2. the problem -->
    <section class="scrub">
      <p>
        <span v-for="(w, i) in problemWords" :key="i" :class="['w', { red: i === problemWords.length - 1 }]">{{ w }}</span>
      </p>
    </section>

    <!-- 3. how it works: five real artifacts, one per step, on a pinned screen -->
    <section id="how" class="pipe">
      <div class="pipe-head">
        <span class="eyebrow">How SHAPI works</span>
        <h2>One API change, <span class="it">start to finish.</span></h2>
      </div>
      <div class="list">
        <article :class="['f', { on: pane === 0 }]">
          <span class="n">01 · MAP</span>
          <h3>Read what your code expects.</h3>
          <p>SHAPI reads your code, never runs it. Every call site goes into <code>api.lock</code>: the endpoint, and the status codes, fields, headers and query params your code relies on.</p>
        </article>
        <article :class="['f', { on: pane === 1 }]">
          <span class="n">02 · WATCH</span>
          <h3>Probe the providers every hour.</h3>
          <p>Canaries call providers' APIs every hour and record the shape of each answer. When a shape changes in a breaking way, an advisory is drafted for review. Announced changes are researched from changelogs.</p>
        </article>
        <article :class="['f', { on: pane === 2 }]">
          <span class="n">03 · MATCH</span>
          <h3>Only the code that breaks.</h3>
          <p>The advisory is matched against <code>api.lock</code>. A call that checks for 204 is flagged; a call that only uses the same endpoint is left alone.</p>
        </article>
        <article :class="['f', { on: pane === 3 }]">
          <span class="n">04 · FIX</span>
          <h3>A fix that has to prove itself.</h3>
          <p>SHAPI writes a contract test, confirms it fails, applies the recipe, and keeps the change only once the test passes.</p>
        </article>
        <article :class="['f', { on: pane === 4 }]">
          <span class="n">05 · SHIP</span>
          <h3>A pull request with its evidence.</h3>
          <p>The change, the test, and why: the advisory, its sources, and the test runs before and after. By default, at most two new pull requests an hour, and one you close stays closed.</p>
        </article>
        <p class="more"><a :href="withBase('/guide/how-it-works')">How SHAPI works, in detail →</a></p>
      </div>
      <div class="media">
        <div class="screen">
          <div class="screen-bar"><i></i><i></i><i></i><span>{{ PANE_TITLES[pane] }}</span></div>
          <div :class="['pane', { on: pane === 0 }]">
            <div class="lbl">src/deploy.ts</div>
            <div class="box">
              <div class="r"><b class="mute">13</b>  const res = await <mark>fetch</mark>(`…/actions/workflows/${req.workflow}/dispatches`, {</div>
              <div class="r"><b class="mute">14</b>    <mark>method: "POST"</mark>,</div>
              <div class="r"><b class="mute">18</b>    <mark>"X-GitHub-Api-Version": "2022-11-28"</mark>,</div>
              <div class="r"><b class="mute">22</b>  if (<mark>res.status !== 204</mark>) {</div>
            </div>
            <div class="flow">written to api.lock</div>
            <div class="box">
              <div class="r">{</div>
              <div class="r">  "file": "src/deploy.ts", "line": 13, "provider": <mark>"github"</mark>,</div>
              <div class="r">  "method": <mark>"POST"</mark>, "client": "fetch",</div>
              <div class="r">  "endpoint": "/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches",</div>
              <div class="r">  "surface": { "statusCodes": [<mark>204</mark>],</div>
              <div class="r">    "headers": [{ "name": "x-github-api-version", "value": <mark>"2022-11-28"</mark> }] }</div>
              <div class="r">}</div>
            </div>
          </div>
          <div :class="['pane', { on: pane === 1 }]">
            <div class="lbl">Probe every hour · POST …/dispatches on SHAPI's test repository</div>
            <div class="ticks">
              <i><span>8 hours ago</span></i><i></i><i></i><i></i><i><span>4 hours ago</span></i><i></i><i></i><i></i><i class="hit"><span>this hour</span></i>
            </div>
            <div class="shape">
              <div>
                <div class="lbl">Recorded shape</div>
                <div class="box"><div class="r">status   204</div><div class="r">body     none</div><div class="r">&nbsp;</div><div class="r">&nbsp;</div></div>
              </div>
              <div>
                <div class="lbl">Shape now</div>
                <div class="box">
                  <div class="r chg">status   200</div>
                  <div class="r add">+ body.workflow_run_id   number</div>
                  <div class="r add">+ body.run_url           string</div>
                  <div class="r add">+ body.html_url          string</div>
                </div>
              </div>
            </div>
            <div class="box stag"><span class="bad">breaking</span> · status-code · drafted <span class="mute">advisories/drafts/github-workflow-dispatch-204-to-200.json</span></div>
          </div>
          <div :class="['pane', { on: pane === 2 }]">
            <div class="shape">
              <div>
                <div class="lbl">api.lock</div>
                <div class="box"><div class="r">"endpoint": "…/dispatches",</div><div class="r">"surface": {</div><div class="r">  "statusCodes": [<mark class="bad">204</mark>]</div><div class="r">}</div></div>
              </div>
              <div>
                <div class="lbl">advisory · verified</div>
                <div class="box"><div class="r">"changeClass": "status-code",</div><div class="r">"trigger": {</div><div class="r">  "statusCodes": [<mark class="bad">204</mark>],</div><div class="r">  "newStatusCodes": [200] }</div></div>
              </div>
            </div>
            <div class="box finding stag">
              <div class="r"><span class="bad">CRITICAL</span>  src/deploy.ts:13  POST …/actions/workflows/{workflow}/dispatches</div>
              <div class="r">          workflow_dispatch returns 200 with a body instead of 204</div>
              <div class="r mute">          why: compares the response status to 204</div>
              <div class="r mute">          fix: Treat both 200 and 204 as success (any 2xx).</div>
            </div>
            <div class="box stag"><div class="r">src/deploy.ts:28  GET …/workflows/{workflow}/runs   <span class="good">not affected</span></div></div>
          </div>
          <div :class="['pane', { on: pane === 3 }]">
            <div class="diff">
              <div class="h">src/deploy.ts</div>
              <div class="d mute">@@ -19,7 +19,7 @@</div>
              <div class="d del">-  if (res.status !== 204) {</div>
              <div class="d add">+  if (![200, 204].includes(res.status)) {</div>
              <div class="d mute">     throw new Error(`deploy dispatch failed with ${res.status}`);</div>
            </div>
            <div class="box stag"><span class="good">A</span> test/shapi/github-workflow-dispatch-204-to-200.test.ts <span class="mute">· calls triggerDeploy() with the 204 it was written for and the 200 GitHub sends now</span></div>
            <div class="runs stag">
              <div class="run fail"><b>Before the fix</b>fail · 1 failed | 1 passed</div>
              <div class="run pass"><b>After the fix</b>pass · 2 passed</div>
            </div>
          </div>
          <div :class="['pane', { on: pane === 4 }]">
            <div class="prc">
              <div class="t">
                <b>SHAPI: workflow_dispatch returns 200 with a body instead of 204</b>
                <span class="state">Merged</span> <span class="mute">&nbsp;2 files · src/deploy.ts, test/shapi/…test.ts</span>
              </div>
              <table>
                <tbody>
                  <tr><td>Change</td><td><code>res.status !== 204</code> → <code>![200, 204].includes(res.status)</code></td></tr>
                  <tr><td>Contract test, before</td><td class="bad">fail (1 failed | 1 passed)</td></tr>
                  <tr><td>Contract test, after</td><td class="good">pass (2 passed)</td></tr>
                  <tr><td>Severity · change class</td><td>critical · status-code</td></tr>
                  <tr><td>First observed</td><td>2025-12-19</td></tr>
                  <tr><td>Provider notice</td><td>none (undocumented change)</td></tr>
                </tbody>
              </table>
              <div class="foot">The change was kept only because the contract test failed before it and passes after it.</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 4. the researched API changes, on a turning ring -->
    <section id="changes" class="helix">
      <div class="stage">
        <div class="helix-copy">
          <span class="eyebrow">The API changes</span>
          <h2>{{ data.total }} changes, <span class="it">researched.</span></h2>
          <p>Across {{ data.providers.length }} providers, {{ ahead.length }} still ahead. Each has a date, its sources, and the exact shape that breaks.</p>
          <a class="pill" :href="withBase('/advisories')">See all {{ data.total }} API changes</a>
        </div>
        <div class="ring">
          <a v-for="a in ringCards" :key="a.id" class="adv" :href="a.url">
            <span class="top"><span>{{ short(a.effectiveDate) }}</span><span>{{ a.changeClass }}</span></span>
            <b>{{ a.provider }}</b>
            <span class="what">{{ a.title }}</span>
            <span class="foot"><span :class="['sev', a.severity]">{{ a.severity }}</span><span class="when">{{ inDays(a.effectiveDate) }}</span></span>
          </a>
        </div>
      </div>
    </section>

    <!-- 5. the same morning, two ways: production logs -->
    <section id="two" class="two">
      <div class="stage">
        <div class="two-inner">
          <div class="two-head">
            <span class="eyebrow">Dec 19, 2025 · GitHub changes a status code</span>
            <h2>The same morning, <span class="it">two ways.</span></h2>
          </div>
          <div class="logs">
            <div class="logs-bar">
              deploy-service · production · illustration
              <div class="switch" role="group" aria-label="Show the morning">
                <button type="button" :class="{ on: !withShapi }" :aria-pressed="!withShapi" @click="withShapi = false">Without SHAPI</button>
                <button type="button" :class="{ on: withShapi }" :aria-pressed="withShapi" @click="withShapi = true">With SHAPI</button>
              </div>
            </div>
            <div class="log-body">
              <div :class="['lset', { on: !withShapi }]">
                <div><span>09:14:02</span>POST /repos/acme/api/actions/workflows/deploy.yml/dispatches → 200</div>
                <div class="e"><span>09:14:02</span>Error: deploy dispatch failed with 200</div>
                <div><span>09:14:03</span>deploy marked failed · alert sent to on-call</div>
                <div><span>09:31:40</span>POST /repos/acme/api/actions/workflows/deploy.yml/dispatches → 200</div>
                <div class="e"><span>09:31:40</span>Error: deploy dispatch failed with 200</div>
                <div><span>10:02:15</span>on-call: tests pass locally, mocks return 204</div>
                <div class="e"><span>11:47:09</span>Error: deploy dispatch failed with 200</div>
              </div>
              <div :class="['lset', { on: withShapi }]">
                <div class="s"><span>04:00:00</span>SHAPI canary · workflow_dispatch answered 200, recorded 204</div>
                <div class="s"><span>04:00:01</span>SHAPI · 1 affected call site · src/deploy.ts:13</div>
                <div class="g"><span>04:03:12</span>SHAPI · PR #2 opened · contract test fails before, passes after</div>
                <div><span>08:55:30</span>PR #2 approved and merged</div>
                <div><span>09:14:02</span>POST /repos/acme/api/actions/workflows/deploy.yml/dispatches → 200</div>
                <div class="g"><span>09:14:02</span>deploy started</div>
                <div class="g"><span>09:31:40</span>deploy started</div>
              </div>
            </div>
            <div class="verdict">
              <span>Deploys that morning</span><b :class="withShapi ? 'g' : 'e'">{{ withShapi ? "2 started, 0 failed" : "3 marked failed" }}</b>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 6. the terminal: the real shapi scan output -->
    <section id="cli" class="term-sec">
      <div class="stage">
        <div>
          <span class="eyebrow">Try it now</span>
          <h2>One command. <span class="it">No account.</span></h2>
          <p>Run it in any TypeScript, JavaScript or Python repository. This is real output on SHAPI's demo project, with the fix hints left out; <code>npx shapi-cli fix . --write</code> fixes all three, each with a test.</p>
          <span class="cmd">$ <b>npx shapi-cli scan .</b></span>
        </div>
        <div class="term"><pre v-html="termHtml"></pre></div>
      </div>
    </section>

    <!-- 7. pricing and code handling -->
    <section class="trust">
      <div class="col">
        <span class="eyebrow">Pricing</span>
        <h2>Free <span class="it">to start.</span></h2>
        <div class="plan">
          <b>Free</b>
          <p>Public repositories and one private repository. Scans, checks, fix pull requests and Slack alerts included.</p>
        </div>
        <div class="plan">
          <b>More private repositories</b>
          <p>A monthly price per repository, announced before it starts. SHAPI asks before anything is charged. Free during early access.</p>
        </div>
      </div>
      <div class="col">
        <span class="eyebrow">Your code stays yours</span>
        <h2>Read-only, <span class="it">nothing kept.</span></h2>
        <ul class="checks">
          <li><b>Read-only tokens:</b> each scan can only read that one repository, and the token expires within an hour.</li>
          <li><b>Source isn't kept:</b> only the map of API calls, the findings and each fix's diff are stored.</li>
          <li><b>Fixes run in a fresh microVM,</b> with no credentials inside and the network off before your code or tests run.</li>
          <li><b>Claude is off by default.</b></li>
        </ul>
        <p class="more">
          Read <a :href="withBase('/security')">security and code handling</a>, the <a :href="withBase('/legal/privacy')">privacy policy</a> and the
          <a :href="withBase('/legal/subprocessors')">subprocessors</a>.
        </p>
      </div>
    </section>

    <!-- 8. close: the logo's two pieces, your code and the API, fit together -->
    <section id="close" class="close">
      <div class="stage">
        <div>
          <div class="fit">
            <svg viewBox="0 0 76 76" aria-hidden="true">
              <path class="code-p" d="M0 0 H48 C48 40 28 36 28 76 H0 Z" />
              <path class="api-p" d="M56 0 H76 V76 H36 C36 36 56 40 56 0 Z" />
            </svg>
            <span class="tag l">your code</span><span class="tag r">the API</span>
          </div>
          <h2>Know before <span class="it">it breaks.</span></h2>
          <p>Install SHAPI on one repository. It takes a minute and needs no code changes.</p>
          <div class="actions">
            <a class="pill solid" :href="INSTALL">Install the GitHub App</a>
            <span class="cmd">$ <b>npx shapi-cli scan .</b></span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
