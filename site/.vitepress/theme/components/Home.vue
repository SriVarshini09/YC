<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { withBase } from "vitepress";
import { data } from "../../advisories.data";

// The landing page (site/index.md). Numbers and deadlines come from the advisories loader, so
// nothing here goes stale; the docs workflow rebuilds daily, which moves "in N days" along.

const INSTALL = "https://github.com/apps/shapi-by-srivarshini/installations/new";
const days = (d: string) => Math.ceil((Date.parse(d) - Date.parse(data.builtOn)) / 86400000);
const inDays = (d: string) => (days(d) === 1 ? "tomorrow" : `in ${days(d)} days`);
const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
// From tomorrow on: changes that take effect today are no longer "coming up".
const ahead = data.upcoming.filter((a) => days(a.effectiveDate) >= 1);
const upcoming = ahead.slice(0, 8);
const ticker = ahead.slice(0, 12);

const problems = [
  { title: "Your tests mock the API as it was.", body: "They keep passing while the provider changes a status code, renames a field or adds a new value." },
  { title: "Deadlines hide in changelogs.", body: "A version is retired on a date announced months ago, in a post nobody on your team read." },
  { title: "You find out in production.", body: "From an error report, a failed payment or an unhappy customer, not from your own checks.", red: "production." },
];

const steps = [
  { name: "Map", body: `Finds every call your code makes to GitHub, Stripe, HubSpot and dozens more APIs, and what each call relies on: a status code, a field, a value. It reads your code; it never runs it to scan.` },
  { name: "Match", body: `Checks those calls against ${data.total} researched API changes and deadlines, and tells apart code that breaks from code that only calls the same endpoint.` },
  { name: "Fix", body: "Where a fix recipe exists (TypeScript and JavaScript), it writes a test that fails on the change, applies the fix, and opens a pull request only once the test passes." },
  { name: "Watch", body: "Every push is scanned again, and new changes are checked against code it already mapped. The next change reaches you as a pull request or a Slack alert, not an incident." },
];

// The story card: the code works, GitHub changes, the line breaks, SHAPI fixes it. Loops.
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

let alive = true;
let observer: IntersectionObserver | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function story() {
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

onMounted(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  ready.value = !reduce;
  observer = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), observer!.unobserve(e.target))),
    { threshold: 0.35 },
  );
  document.querySelectorAll(".home .fade, .home .reveal").forEach((el) => (reduce ? el.classList.add("in") : observer!.observe(el)));
  if (!reduce) story();
});
onBeforeUnmount(() => {
  alive = false;
  observer?.disconnect();
});
</script>

<template>
  <div :class="['home', { motion: ready }]">
    <section class="wrap hero">
      <div class="fade">
        <div class="eyebrow">For teams that call other people's APIs</div>
        <h1>APIs change.<br /><span class="dim">Your code keeps working.</span></h1>
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

      <div class="story fade" role="img" aria-label="An API change breaks a line of code, and SHAPI fixes it">
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

    <section class="wrap stats fade">
      <div><strong>{{ data.total }}</strong><span>researched API changes</span></div>
      <div><strong>{{ ahead.length }}</strong><span>deadlines still ahead</span></div>
      <div><strong>{{ data.providers.length }}</strong><span>providers</span></div>
      <div><strong>{{ data.withFix }}</strong><span>with an automatic fix</span></div>
    </section>

    <section class="block">
      <div class="wrap center">
        <div class="eyebrow center fade">The problem</div>
        <h2 class="fade">Your tests pass.<br /><span class="dim">The real API already moved on.</span></h2>
      </div>
      <div class="wrap problems">
        <div v-for="(p, i) in problems" :key="i" class="problem">
          <div class="n">0{{ i + 1 }}</div>
          <div>
            <h3 class="reveal">
              <span v-for="(w, j) in words(p.title)" :key="j" :class="['w', { red: w.trim() === p.red }]" :style="{ transitionDelay: `${j * 70}ms` }">{{ w }}</span>
            </h3>
            <p>{{ p.body }}</p>
          </div>
        </div>
      </div>
    </section>

    <section class="block tight" id="how">
      <div class="wrap center">
        <div class="eyebrow center fade">How it works</div>
        <h2 class="fade">Four steps, all automatic.</h2>
      </div>
      <div class="wrap">
        <div class="how fade">
          <div v-for="(s, i) in steps" :key="s.name"><span class="n">0{{ i + 1 }}</span><h4>{{ s.name }}</h4><p>{{ s.body }}</p></div>
        </div>
        <p class="more fade"><a :href="withBase('/guide/how-it-works')">How SHAPI works, in detail →</a></p>
      </div>
    </section>

    <section class="block tight">
      <div class="wrap split">
        <div class="fade">
          <div class="eyebrow">See it on your code</div>
          <h2>One command.<br /><span class="dim">No account needed.</span></h2>
          <p class="lede small">
            Run it in any TypeScript, JavaScript or Python repository. This is SHAPI's demo project; <code>npx shapi-cli fix . --write</code> fixes all
            three, each with a test that failed before and passes after.
          </p>
          <a class="pill ghost" :href="withBase('/guide/quickstart')">Read the quickstart</a>
        </div>
        <div class="term fade">
          <div class="bar"><span class="file">terminal</span></div>
          <pre><span class="cmd">$ npx shapi-cli scan .</span>

Affected call sites (3)
  <span class="crit">CRITICAL</span>  src/deploy.ts:13
            workflow_dispatch returns 200 with a body
            instead of 204
  <span class="high">HIGH</span>      src/accounting.ts:7
            Minor versions below 75 are silently
            answered as minor version 75
  <span class="high">HIGH</span>      src/crm.ts:6
            Pipelines API v1 retired on 2026-12-04</pre>
        </div>
      </div>
    </section>

    <section class="block tight">
      <div class="wrap center">
        <div class="eyebrow center fade">Coming up</div>
        <h2 class="fade">The next API deadlines.</h2>
      </div>
      <div class="wrap">
        <div class="deadlines fade">
          <a v-for="a in upcoming" :key="a.id" class="row" :href="a.url">
            <span :class="['when', { near: days(a.effectiveDate) <= 14 }]">{{ short(a.effectiveDate) }}<small>{{ inDays(a.effectiveDate) }}</small></span>
            <span class="what"><b>{{ a.provider }}</b>{{ a.title }}</span>
            <span :class="['badge', a.severity === 'critical' ? 'bad' : a.severity === 'high' ? 'soon' : 'wait']"><i></i>{{ a.severity }}</span>
          </a>
        </div>
        <p class="more fade">All {{ data.total }} are on the <a :href="withBase('/advisories')">API changes page</a>, as open data you can use and contribute to.</p>
      </div>
    </section>

    <section class="block tight">
      <div class="wrap split">
        <div class="fade">
          <div class="eyebrow">What a fix looks like</div>
          <h2>A pull request<br /><span class="dim">with its proof attached.</span></h2>
        </div>
        <ul class="checks fade">
          <li><b>One pull request per change,</b> covering every affected place in the repository.</li>
          <li><b>The change itself,</b> for example <code>minorversion=65</code> → <code>75</code>.</li>
          <li><b>A contract test per call,</b> with its run before and after the fix.</li>
          <li><b>The evidence:</b> the provider's notice, the severity and the sources.</li>
          <li><b>No noise:</b> at most 2 new pull requests an hour, and one you closed stays closed.</li>
        </ul>
      </div>
    </section>

    <section class="block tight">
      <div class="wrap center">
        <div class="eyebrow center fade">Pricing</div>
        <h2 class="fade">Free to start.</h2>
      </div>
      <div class="wrap price fade">
        <div>
          <h4>Free</h4>
          <p>Public repositories and one private repository. Scans, checks, fix pull requests and Slack alerts included.</p>
        </div>
        <div>
          <h4>More private repositories</h4>
          <p>A monthly price per repository, announced before it starts. SHAPI asks before anything is charged. Free during early access.</p>
        </div>
      </div>
    </section>

    <section class="block tight">
      <div class="wrap split">
        <div class="fade">
          <div class="eyebrow">Your code stays yours</div>
          <h2>Read-only,<br /><span class="dim">and nothing kept.</span></h2>
          <p class="lede small">
            Read <a :href="withBase('/security')">security and code handling</a>, the <a :href="withBase('/legal/privacy')">privacy policy</a> and the
            <a :href="withBase('/legal/subprocessors')">subprocessors</a>.
          </p>
        </div>
        <ul class="checks fade">
          <li><b>Read-only tokens:</b> each scan can only read that one repository, and the token expires within an hour.</li>
          <li><b>Source isn't kept:</b> only the map of API calls and the findings are stored.</li>
          <li><b>Fixes run in a fresh microVM,</b> with the network off before any of your code runs.</li>
          <li><b>Claude is off by default.</b></li>
        </ul>
      </div>
    </section>

    <section class="wrap cta">
      <h2 class="fade">Know before it breaks.</h2>
      <p class="lede fade">Install it on one repository. It takes a minute and needs no code changes.</p>
      <div class="actions fade">
        <a class="pill solid" :href="INSTALL">Install the GitHub App</a>
        <a class="pill ghost" :href="withBase('/advisories')">See the API changes</a>
      </div>
    </section>
  </div>
</template>
