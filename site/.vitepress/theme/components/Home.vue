<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { withBase } from "vitepress";
import { data } from "../../advisories.data";

// The landing page (site/index.md). Numbers and deadlines come from the advisories loader, so
// nothing here goes stale; the docs workflow rebuilds daily, which moves "in N days" along.
//
// Scrolling drives most of the page: every element with `data-scroll` gets `--p` (0 → 1) from
// where it sits in the viewport, and home.css turns that into motion. Without JavaScript, or with
// reduced motion, `--p` stays at its CSS default of 1 and the page shows its finished state.

const INSTALL = "https://github.com/apps/shapi-by-srivarshini/installations/new";
const days = (d: string) => Math.ceil((Date.parse(d) - Date.parse(data.builtOn)) / 86400000);
const inDays = (d: string) => (days(d) === 1 ? "tomorrow" : `in ${days(d)} days`);
const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
// From tomorrow on: changes that take effect today are no longer "coming up".
const ahead = data.upcoming.filter((a) => days(a.effectiveDate) >= 1);
const upcoming = ahead.slice(0, 10);
const ticker = ahead.slice(0, 12);
const next = ahead[0];

const problems = [
  { title: "Your tests mock the API as it was.", body: "They keep passing while the provider changes a status code, renames a field or adds a new value." },
  { title: "Deadlines hide in changelogs.", body: "A version is retired on a date announced months ago, in a post nobody on your team read." },
  { title: "You find out in production.", body: "From an error report, a failed payment or an unhappy customer, not from your own checks.", red: "production." },
];

const chapters = [
  { name: "Map", body: "SHAPI reads your code, never runs it, and finds every call to GitHub, Stripe, HubSpot and dozens more APIs: the endpoint, and what the code relies on, such as a status code, a field or a value." },
  { name: "Match", body: `Each call is checked against ${data.total} researched API changes and deadlines. Code that depends on what changed breaks; code that only calls the same endpoint is left alone.` },
  { name: "Fix", body: "Where a fix recipe exists (TypeScript and JavaScript), SHAPI writes a contract test that fails on the change, applies the fix, and keeps it only once the test passes." },
  { name: "Watch", body: "The fix arrives as a pull request with its proof. Every push is scanned again, and each new change is checked against the code SHAPI already mapped." },
];

const proof = [
  { b: "One pull request per change,", t: " covering every affected place in the repository." },
  { b: "The change itself,", t: " for example minorversion=65 → 75." },
  { b: "A contract test per call,", t: " with its run before and after the fix." },
  { b: "The evidence:", t: " the provider's notice, the severity and the sources." },
  { b: "No noise:", t: " at most 2 new pull requests an hour, and one you closed stays closed." },
];

// The hero card: the code works, GitHub changes, the line breaks, SHAPI fixes it. Loops on a timer.
const BEFORE = "if (res.status === 204) {";
const AFTER = "if ([200, 204].includes(res.status)) {";
const STAGES = [
  { badge: "Works", kind: "ok", dot: "idle", ms: 2600, text: "Watching <b>GitHub</b> for changes to the endpoints this code uses." },
  { badge: "Changed", kind: "soon", dot: "soon", ms: 2800, text: "<b>GitHub changed.</b> workflow_dispatch now answers <b>200</b> with a body, not 204." },
  { badge: "Breaks", kind: "bad", dot: "bad", ms: 2800, text: "<b>Line 15 breaks.</b> It only accepts 204, so every deploy now looks like a failure." },
  { badge: "Fixing", kind: "wait", dot: "ink", ms: 0, text: "<b>SHAPI is fixing it.</b> Writing a test that fails on the change first…" },
  { badge: "Fixed", kind: "ok", dot: "ok", ms: 3600, text: "<b>Fixed.</b> The test failed before and passes now. Pull request opened." },
];
const ready = ref(false);
const stage = ref(4);
const line = ref(AFTER);
const typing = ref(false);
// Each word but the last keeps its space: Vue drops whitespace between elements.
const words = (s: string) => s.split(" ").map((w, i, all) => (i < all.length - 1 ? `${w} ` : w));

// The scroll story ("how it works"): `story` is which chapter sits at the middle of the screen,
// as a float (0 = Map centred, 3 = Watch centred), so the stage always shows the text beside it.
// Each phase plays while its chapter scrolls up to the middle.
const story = ref(3);
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const phase = computed(() => ({
  map: seg(story.value, -0.9, -0.15),
  match: seg(story.value, 0.15, 0.8),
  fix: seg(story.value, 1.15, 1.8),
  watch: seg(story.value, 2.15, 2.8),
}));
const chapter = computed(() => Math.min(3, Math.max(0, Math.round(story.value))));
const typed = computed(() => (phase.value.fix >= 1 ? AFTER : phase.value.fix > 0.15 ? AFTER.slice(0, Math.round(((phase.value.fix - 0.15) / 0.85) * AFTER.length)) : BEFORE));
const stageVars = computed(() => ({ "--map": phase.value.map, "--match": phase.value.match, "--fix": phase.value.fix, "--watch": phase.value.watch }));

// Numbers count up as they scroll in.
const counted = ref(1);
const count = (n: number) => Math.round(n * (1 - Math.pow(1 - counted.value, 3)));

type Mode = "pin" | "out" | "enter" | "view";
function measure(el: HTMLElement, mode: Mode, vh: number): number {
  const r = el.getBoundingClientRect();
  if (mode === "pin") return clamp(-r.top / Math.max(1, r.height - vh));
  if (mode === "out") return clamp(-r.top / Math.max(1, r.height));
  if (mode === "enter") return clamp((vh * 0.9 - r.top) / (vh * 0.45));
  return clamp((vh - r.top) / (vh + r.height));
}

let alive = true;
let frame = 0;
let tracked: HTMLElement[] = [];
const root = ref<HTMLElement>();
const storyEl = ref<HTMLElement>();
const statsEl = ref<HTMLElement>();
const rail = ref<HTMLElement>();
const track = ref<HTMLElement>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loop() {
  while (alive) {
    for (let i = 0; i < STAGES.length && alive; i++) {
      stage.value = i;
      if (i === 0) line.value = BEFORE;
      if (i === 3) {
        typing.value = true;
        for (let n = 0; n <= AFTER.length && alive; n++) {
          line.value = AFTER.slice(0, n);
          await sleep(38);
        }
        typing.value = false;
      } else await sleep(STAGES[i]!.ms);
    }
  }
}

function update() {
  frame = 0;
  const vh = innerHeight;
  for (const el of tracked) {
    const p = measure(el, el.dataset.scroll as Mode, vh);
    el.style.setProperty("--p", p.toFixed(4));
    if (el === storyEl.value) story.value = chapterAt(el, vh);
    if (el === statsEl.value) counted.value = p;
  }
  const max = document.documentElement.scrollHeight - vh;
  root.value?.style.setProperty("--page", clamp(scrollY / Math.max(1, max)).toFixed(4));
}
const onScroll = () => (frame ||= requestAnimationFrame(update));

// Measured on the chapter titles, against the middle of the screen (or, on phones, where the
// stage is pinned above the text, the middle of the space below it).
function chapterAt(el: HTMLElement, vh: number): number {
  const [a, b] = [...el.querySelectorAll(".chapter h3")].map((c) => {
    const r = c.getBoundingClientRect();
    return r.top + r.height / 2;
  });
  const mark = innerWidth < 960 ? vh * 0.72 : vh * 0.45;
  return a === undefined || b === undefined ? 3 : (mark - a) / Math.max(1, b - a);
}

// The deadline rail moves sideways while the page scrolls down: its section is as tall as the
// distance the track has to travel, plus one screen.
function sizeRail() {
  if (!rail.value || !track.value) return;
  const travel = Math.max(0, track.value.scrollWidth - rail.value.clientWidth);
  rail.value.style.setProperty("--travel", `${travel}px`);
  onScroll();
}

onMounted(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  ready.value = true;
  tracked = [...document.querySelectorAll<HTMLElement>(".home [data-scroll]")];
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", sizeRail);
  update();
  requestAnimationFrame(sizeRail);
  loop();
});
onBeforeUnmount(() => {
  alive = false;
  removeEventListener("scroll", onScroll);
  removeEventListener("resize", sizeRail);
  cancelAnimationFrame(frame);
});
</script>

<template>
  <div ref="root" :class="['home', { motion: ready }]">
    <div class="progress" aria-hidden="true"></div>

    <section class="wrap hero" data-scroll="out">
      <div class="hero-copy">
        <div class="eyebrow">For teams that call other people's APIs</div>
        <h1>APIs change.<br />Your code <span class="under">keeps working.</span></h1>
        <p class="lede">
          Stripe renames a value. GitHub answers 200 instead of 204. SHAPI finds the exact lines in your code that a change breaks and, where a fix recipe
          exists, opens a pull request that fixes them, with a test that proves it.
        </p>
        <div class="actions">
          <a class="pill solid" :href="INSTALL">Install the GitHub App</a>
          <a class="pill ghost" :href="withBase('/guide/quickstart')">Try it in your terminal</a>
        </div>
        <p class="note">Free for public repositories and one private one. Free for everyone during early access.</p>
      </div>

      <div class="story" role="img" aria-label="An API change breaks a line of code, and SHAPI fixes it">
        <div class="bar">
          <span class="file">src/deploy.ts</span>
          <span :class="['badge', STAGES[stage]!.kind]"><i></i>{{ STAGES[stage]!.badge }}</span>
        </div>
        <div class="code">
          <div class="ln"><span>12</span><span><b>const</b> res = <b>await</b> fetch(dispatchUrl, {</span></div>
          <div class="ln"><span>13</span><span>&nbsp;&nbsp;method: "POST", headers, body</span></div>
          <div class="ln"><span>14</span><span>});</span></div>
          <div :class="['ln', 'hot', stage === 2 ? 'bad' : stage >= 3 ? 'good' : '']">
            <span>15</span><span class="txt">{{ line }}<i v-if="typing" class="caret"></i></span>
          </div>
          <div class="ln"><span>16</span><span>&nbsp;&nbsp;log("deploy started");</span></div>
          <div class="ln"><span>17</span><span>}</span></div>
        </div>
        <div class="event"><span :class="['dot', STAGES[stage]!.dot]"></span><span v-html="STAGES[stage]!.text"></span></div>
        <div class="steps">
          <span v-for="n in 4" :key="n" :class="stage === 4 || n - 1 < stage ? 'done' : n - 1 === stage ? 'run' : ''"
            ><i :style="{ animationDuration: `${STAGES[stage]!.ms || 1600}ms` }"></i
          ></span>
        </div>
      </div>
      <div class="scroll-cue" aria-hidden="true"><span></span>Scroll</div>
    </section>

    <div class="ticker" aria-label="Upcoming API deadlines">
      <div class="track">
        <template v-for="copy in 2" :key="copy">
          <a v-for="a in ticker" :key="`${copy}-${a.id}`" class="item" :href="a.url" :aria-hidden="copy === 2 ? 'true' : undefined" :tabindex="copy === 2 ? -1 : undefined">
            <b>{{ a.provider }}</b> · {{ a.title }}<span :class="['days', { near: days(a.effectiveDate) <= 14 }]">{{ inDays(a.effectiveDate) }}</span>
          </a>
        </template>
      </div>
    </div>

    <section ref="statsEl" class="wrap stats" data-scroll="enter">
      <div><strong>{{ count(data.total) }}</strong><span>researched API changes</span></div>
      <div><strong>{{ count(ahead.length) }}</strong><span>deadlines still ahead</span></div>
      <div><strong>{{ count(data.providers.length) }}</strong><span>providers</span></div>
      <div><strong>{{ count(data.withFix) }}</strong><span>with an automatic fix</span></div>
    </section>

    <section class="block">
      <div class="wrap center rise" data-scroll="enter">
        <div class="eyebrow center">The problem</div>
        <h2>Your tests pass.<br /><span class="dim">The real API already moved on.</span></h2>
      </div>
      <div class="wrap problems">
        <div v-for="(p, i) in problems" :key="i" class="problem" data-scroll="view">
          <div class="n">0{{ i + 1 }}</div>
          <div>
            <h3 class="scrub" :style="{ '--n': words(p.title).length }">
              <span v-for="(w, j) in words(p.title)" :key="j" :class="['w', { red: w.trim() === p.red }]" :style="{ '--i': j }">{{ w }}</span>
            </h3>
            <p>{{ p.body }}</p>
          </div>
        </div>
      </div>
    </section>

    <section class="block band" id="how">
      <div class="wrap center rise" data-scroll="enter">
        <div class="eyebrow center">How it works</div>
        <h2>One API change,<br /><span class="dim">from start to finish.</span></h2>
      </div>

      <div ref="storyEl" class="wrap chapters" data-scroll="pin">
        <div class="texts">
          <article v-for="(c, i) in chapters" :key="c.name" :class="['chapter', { on: ready && chapter === i }]">
            <span class="n">0{{ i + 1 }}</span>
            <h3>{{ c.name }}</h3>
            <p>{{ c.body }}</p>
          </article>
        </div>

        <div class="pin">
          <div class="stage" :style="stageVars" role="img" aria-label="SHAPI maps three API calls, matches a GitHub change, fixes the line and opens a pull request">
            <div class="stage-bar">
              <span class="file">api.lock</span>
              <span class="dots"><i v-for="n in 4" :key="n" :class="{ on: chapter >= n - 1 || !ready }"></i></span>
            </div>

            <div class="layer map">
              <div class="calls">
                <div class="call c1"><span class="file">src/deploy.ts:13</span><span :class="['tag', phase.match > 0.5 ? 'bad' : '']">{{ phase.match > 0.5 ? "breaks" : "POST" }}</span></div>
                <div class="call c2"><span class="file">src/accounting.ts:7</span><span class="tag">GET</span></div>
                <div class="call c3"><span class="file">src/crm.ts:6</span><span class="tag">GET</span></div>
              </div>
              <svg class="wires" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <path :class="{ hit: phase.match > 0.5 }" pathLength="1" d="M48 22 C 58 22, 58 45, 66 45" />
                <path pathLength="1" d="M48 45 C 58 45, 58 68, 66 68" />
                <path pathLength="1" d="M48 68 C 58 68, 58 22, 66 22" />
              </svg>
              <div class="apis">
                <span class="api a1">HubSpot</span>
                <span :class="['api', 'a2', { hit: phase.match > 0.5 }]">GitHub</span>
                <span class="api a3">QuickBooks</span>
              </div>
              <div class="notice">
                <span class="badge bad"><i></i>critical</span>
                <b>GitHub changed.</b> workflow_dispatch now answers 200 with a body instead of 204.
              </div>
            </div>

            <div class="layer fix">
              <div class="code">
                <div class="ln"><span>13</span><span><b>const</b> res = <b>await</b> fetch(dispatchUrl, {</span></div>
                <div class="ln"><span>14</span><span>});</span></div>
                <div :class="['ln', 'hot', phase.fix >= 1 ? 'good' : 'bad']"><span>15</span><span class="txt">{{ typed }}</span></div>
                <div class="ln"><span>16</span><span>&nbsp;&nbsp;log("deploy started");</span></div>
              </div>
              <div class="log">
                <div :class="{ show: phase.fix > 0.1 }"><span class="x">✕</span>contract test · POST /dispatches answers 200 → <b>fails</b></div>
                <div :class="{ show: phase.fix > 0.5 }"><span class="arrow">→</span>applying recipe <b>status-code-accept-set</b></div>
                <div :class="{ show: phase.fix >= 1 }"><span class="v">✓</span>contract test · 200 and 204 accepted → <b>passes</b></div>
              </div>
              <div class="tests">
                <span :class="['badge', phase.fix > 0.08 ? 'bad' : 'wait']"><i></i>contract test fails before</span>
                <span :class="['badge', phase.fix >= 1 ? 'ok' : 'wait']"><i></i>{{ phase.fix >= 1 ? "passes after" : "running…" }}</span>
              </div>
            </div>

            <div class="layer watch">
              <div class="pr">
                <div class="pr-top"><span class="badge ok"><i></i>open</span><span class="file">#12 · shapi-demo</span></div>
                <b>SHAPI: workflow_dispatch returns 200 with a body instead of 204</b>
                <div class="pr-meta">1 file · +1 −1 · contract test passed in a fresh sandbox</div>
              </div>
              <div class="radar">
                <span class="ring"></span><span class="ring r2"></span><span class="core"></span>
                <p>Watching every push.<br /><template v-if="next">Next: {{ next.provider }}, {{ inDays(next.effectiveDate) }}.</template></p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p class="more"><a :href="withBase('/guide/how-it-works')">How SHAPI works, in detail →</a></p>
    </section>

    <section class="block">
      <div class="wrap split">
        <div class="rise" data-scroll="enter">
          <div class="eyebrow">See it on your code</div>
          <h2>One command.<br /><span class="dim">No account needed.</span></h2>
          <p class="lede small">
            Run it in any TypeScript, JavaScript or Python repository. This is SHAPI's demo project; <code>npx shapi-cli fix . --write</code> fixes all
            three, each with a test that failed before and passes after.
          </p>
          <a class="pill ghost" :href="withBase('/guide/quickstart')">Read the quickstart</a>
        </div>
        <div class="term" data-scroll="enter">
          <div class="bar"><span class="file">terminal</span></div>
          <pre><span class="cmd">$ npx shapi-cli scan .</span>

<span class="out o1">Affected call sites (3)</span>
<span class="out o2">  <span class="crit">CRITICAL</span>  src/deploy.ts:13
            workflow_dispatch returns 200 with a body
            instead of 204</span>
<span class="out o3">  <span class="high">HIGH</span>      src/accounting.ts:7
            Minor versions below 75 are silently
            answered as minor version 75</span>
<span class="out o4">  <span class="high">HIGH</span>      src/crm.ts:6
            Pipelines API v1 retired on 2026-12-04</span></pre>
        </div>
      </div>
    </section>

    <section class="block">
      <div class="wrap center rise" data-scroll="enter">
        <div class="eyebrow center">Coming up</div>
        <h2>The next API deadlines.</h2>
        <p class="lede">Keep scrolling: the calendar moves with you.</p>
      </div>
      <div ref="rail" class="rail" data-scroll="pin">
        <div class="rail-pin">
          <div ref="track" class="rail-track">
            <div class="today"><span>Today</span><b>{{ short(data.builtOn) }}</b></div>
            <a v-for="a in upcoming" :key="a.id" :class="['date', { near: days(a.effectiveDate) <= 14 }]" :href="a.url">
              <span class="when">{{ short(a.effectiveDate) }} · {{ inDays(a.effectiveDate) }}</span>
              <b>{{ a.provider }}</b>
              <span class="what">{{ a.title }}</span>
              <span :class="['badge', a.severity === 'critical' ? 'bad' : a.severity === 'high' ? 'soon' : 'wait']"><i></i>{{ a.severity }}</span>
            </a>
            <a class="date all" :href="withBase('/advisories')"><b>All {{ data.total }} API changes →</b><span class="what">Open data you can use and contribute to.</span></a>
          </div>
          <div class="rail-line"><i></i></div>
        </div>
      </div>
    </section>

    <section class="block">
      <div class="wrap split">
        <div class="rise" data-scroll="enter">
          <div class="eyebrow">What a fix looks like</div>
          <h2>A pull request<br /><span class="dim">with its proof attached.</span></h2>
        </div>
        <ul class="checks">
          <li v-for="(c, i) in proof" :key="i" data-scroll="enter"><b>{{ c.b }}</b>{{ c.t }}</li>
        </ul>
      </div>
    </section>

    <section class="block band">
      <div class="wrap center rise" data-scroll="enter">
        <div class="eyebrow center">Pricing</div>
        <h2>Free to start.</h2>
      </div>
      <div class="wrap price">
        <div data-scroll="enter">
          <h4>Free</h4>
          <p>Public repositories and one private repository. Scans, checks, fix pull requests and Slack alerts included.</p>
        </div>
        <div data-scroll="enter">
          <h4>More private repositories</h4>
          <p>A monthly price per repository, announced before it starts. SHAPI asks before anything is charged. Free during early access.</p>
        </div>
      </div>
    </section>

    <section class="block">
      <div class="wrap split">
        <div class="rise" data-scroll="enter">
          <div class="eyebrow">Your code stays yours</div>
          <h2>Read-only,<br /><span class="dim">and nothing kept.</span></h2>
          <p class="lede small">
            Read <a :href="withBase('/security')">security and code handling</a>, the <a :href="withBase('/legal/privacy')">privacy policy</a> and the
            <a :href="withBase('/legal/subprocessors')">subprocessors</a>.
          </p>
        </div>
        <ul class="checks">
          <li data-scroll="enter"><b>Read-only tokens:</b> each scan can only read that one repository, and the token expires within an hour.</li>
          <li data-scroll="enter"><b>Source isn't kept:</b> only the map of API calls and the findings are stored.</li>
          <li data-scroll="enter"><b>Fixes run in a fresh microVM,</b> with the network off before any of your code runs.</li>
          <li data-scroll="enter"><b>Claude is off by default.</b></li>
        </ul>
      </div>
    </section>

    <section class="wrap cta" data-scroll="enter">
      <svg class="join" viewBox="-40 -40 156 156" aria-hidden="true">
        <path class="piece left" d="M0 0 H48 C48 40 28 36 28 76 H0 Z" />
        <path class="piece right" d="M56 0 H76 V76 H36 C36 36 56 40 56 0 Z" />
      </svg>
      <h2>Know before it breaks.</h2>
      <p class="lede">Your code and the APIs it calls, kept in step. Install it on one repository: it takes a minute and needs no code changes.</p>
      <div class="actions">
        <a class="pill solid" :href="INSTALL">Install the GitHub App</a>
        <a class="pill ghost" :href="withBase('/advisories')">See the API changes</a>
      </div>
    </section>
  </div>
</template>
