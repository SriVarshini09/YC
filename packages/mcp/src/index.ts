import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SEVERITY_RANK, loadAdvisories, type Advisory, type Finding } from "@shapi/core";
import { createTwoFilesPatch } from "diff";
import { DEFAULT_ADVISORIES, VERSION, fix, preparePython, scan, type FixOutcome } from "shapi";
import { z } from "zod";

export interface ServerOptions {
  /** Directory paths resolve against (the editor's project root). */
  cwd?: string;
  advisoriesDir?: string;
  /** Canary shape store, checked before bundled recordings when fixing. */
  db?: string;
  /** Injected for tests: replaces GitHub delivery when apply_fix runs in "pr" mode. */
  deliver?: Parameters<typeof fix>[2]["deliver"];
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Plain text for the agent: a short summary, then the details as JSON. */
function result(summary: string, data: unknown): ToolResult {
  return { content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] };
}

function failure(err: unknown): ToolResult {
  return { content: [{ type: "text", text: `shapi: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
}

const pathArg = z.string().optional().describe("Repository directory to work on. Defaults to the project root the editor started the server in.");

export function createServer(opts: ServerOptions = {}): McpServer {
  const cwd = opts.cwd ?? process.cwd();
  const advisoriesDir = opts.advisoriesDir ?? process.env.SHAPI_ADVISORIES ?? DEFAULT_ADVISORIES;
  const db = opts.db ?? process.env.SHAPI_DB ?? path.join(cwd, ".shapi", "shapes.db");
  const resolve = (p?: string) => path.resolve(cwd, p ?? ".");
  const server = new McpServer({ name: "shapi", version: VERSION });

  server.registerTool(
    "scan",
    {
      title: "Scan third-party API dependencies",
      description:
        "Map every third-party API call site in a repository (provider, endpoint, file:line, and what the code depends on: status codes, fields, enums, headers, query params) " +
        "and match them against SHAPI's breaking-change advisories. Returns affected call sites, exposed ones, and provider deadlines in the next 90 days. Read-only.",
      inputSchema: { path: pathArg, repo: z.string().optional().describe("A git URL to clone and scan instead of a local directory.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: p, repo }) => {
      try {
        const o = scan(repo ? undefined : resolve(p), { repo, advisories: advisoriesDir, failOn: "none" });
        const affected = o.match.affected.map(findingView);
        const summary = [
          `Scanned ${o.label}: ${o.filesScanned} files, ${o.lock.callSites.length} call sites, ${o.lock.providers.length} providers (${o.lock.providers.map((x) => x.id).join(", ") || "none"}).`,
          affected.length
            ? `${affected.length} affected call site(s):\n${affected.map((a) => `- ${a.severity.toUpperCase()} ${a.file}:${a.line} ${a.method} ${a.endpoint} — ${a.title} [${a.advisory}] (${a.reasons.join("; ")})`).join("\n")}`
            : "No affected call sites.",
          o.match.upcoming.length
            ? `Deadlines in 90 days: ${o.match.upcoming.map((u) => `${u.advisory.effectiveDate} ${u.advisory.provider}: ${u.advisory.title}`).join("; ")}`
            : "No provider deadlines in the next 90 days.",
        ].join("\n");
        return result(summary, {
          target: o.label,
          providers: o.lock.providers,
          callSites: o.lock.callSites.length,
          unresolved: o.lock.callSites.filter((c) => !c.resolved).length,
          affected,
          exposed: o.match.exposed.map(findingView),
          upcoming: o.match.upcoming.map((u) => ({ advisory: u.advisory.id, provider: u.advisory.provider, title: u.advisory.title, effectiveDate: u.advisory.effectiveDate, daysUntil: u.daysUntil, callSites: u.callSites })),
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "advisories",
    {
      title: "List breaking-change advisories",
      description:
        "List SHAPI's advisories: provider API changes that break integrations (status codes, removed fields, new enum values, version sunsets, scope and auth changes), " +
        "with severity, effective date, migration note, and whether a deterministic fix recipe exists. Filter by provider or by deadlines coming up. Read-only.",
      inputSchema: {
        provider: z.string().optional().describe("Provider id, for example github, stripe, quickbooks."),
        upcomingWithinDays: z.number().int().positive().optional().describe("Only advisories taking effect within this many days from today."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ provider, upcomingWithinDays }) => {
      try {
        const today = Date.parse(new Date().toISOString().slice(0, 10));
        const list = loadAdvisories(advisoriesDir)
          .filter((a) => !provider || a.provider === provider)
          .filter((a) => {
            if (upcomingWithinDays === undefined) return true;
            const days = (Date.parse(a.effectiveDate) - today) / 86_400_000;
            return days >= 0 && days <= upcomingWithinDays;
          })
          .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.effectiveDate.localeCompare(b.effectiveDate));
        const summary = list.length
          ? `${list.length} advisor${list.length === 1 ? "y" : "ies"}:\n${list.map((a) => `- [${a.id}] ${a.severity} ${a.provider}: ${a.title} (effective ${a.effectiveDate}${a.recipeId ? ", auto-fix recipe" : ""})`).join("\n")}`
          : "No advisories match.";
        return result(summary, list.map(advisoryView));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "impact",
    {
      title: "Impact of one advisory on a repository",
      description:
        "For one advisory, list every call site in the repository that calls the changed endpoint: affected ones (the code depends on exactly what changed, with the reason) " +
        "and exposed ones (calls the endpoint but does not depend on the change). Use it to explain why a call site breaks before fixing it. Read-only.",
      inputSchema: { path: pathArg, advisoryId: z.string().describe("Advisory id, as returned by scan or advisories.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path: p, advisoryId }) => {
      try {
        const advisory = loadAdvisories(advisoriesDir).find((a) => a.id === advisoryId);
        if (!advisory) return failure(`unknown advisory ${advisoryId}`);
        const o = scan(resolve(p), { advisories: advisoriesDir, failOn: "none" });
        const affected = o.match.affected.filter((f) => f.advisory.id === advisoryId).map(findingView);
        const exposed = o.match.exposed.filter((f) => f.advisory.id === advisoryId).map(findingView);
        const summary = [
          `${advisory.title} [${advisory.id}], ${advisory.severity}, ${advisory.provider} ${advisory.endpoint.method} ${advisory.endpoint.path}.`,
          `Affected: ${affected.length ? affected.map((a) => `${a.file}:${a.line} (${a.reasons.join("; ")})`).join(", ") : "none"}.`,
          `Exposed but not affected: ${exposed.length ? exposed.map((a) => `${a.file}:${a.line}`).join(", ") : "none"}.`,
          `Fix: ${advisory.migrationNote}${advisory.recipeId ? ` A deterministic recipe (${advisory.recipeId}) can apply it; call apply_fix.` : " No recipe; apply_fix with llm=true asks Claude, verified by a contract test."}`,
        ].join("\n");
        return result(summary, { advisory: advisoryView(advisory), affected, exposed });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "apply_fix",
    {
      title: "Fix affected call sites, test-first",
      description:
        "Repair affected call sites: generate a contract test from the provider's old and new response shapes, confirm it fails, apply the advisory's recipe " +
        "(or ask Claude when llm=true), and keep the change only if the test then passes. mode=dry-run (default) returns the diff without touching files; " +
        "mode=write writes the fix and the test into the repository; mode=pr opens a GitHub pull request. Ask the user before using write or pr.",
      inputSchema: {
        path: pathArg,
        advisoryId: z.string().optional().describe("Only fix call sites affected by this advisory."),
        mode: z.enum(["dry-run", "write", "pr"]).default("dry-run").describe("dry-run returns the diff; write edits the repo; pr opens a pull request."),
        llm: z.boolean().default(false).describe("Ask Claude when no recipe fixes the call site (needs ANTHROPIC_API_KEY; costs API usage)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ path: p, advisoryId, mode, llm }) => {
      try {
        const log: string[] = [];
        const outcomes = await fix(
          resolve(p),
          { advisory: advisoryId, advisories: advisoriesDir, db, llm, write: mode === "write", pr: mode === "pr" },
          { log: (l) => log.push(l), deliver: opts.deliver },
        );
        const views = outcomes.map(outcomeView);
        const fixed = views.filter((v) => v.status === "fixed").length;
        const summary = [
          outcomes.length === 0 ? "No affected call sites: nothing to fix." : `${fixed} of ${outcomes.length} affected call site(s) fixed (${mode}).`,
          ...log,
        ].join("\n");
        return result(summary, views);
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}

function findingView(f: Finding) {
  return {
    advisory: f.advisory.id,
    severity: f.advisory.severity,
    title: f.advisory.title,
    provider: f.advisory.provider,
    file: f.callSite.file,
    line: f.callSite.line,
    method: f.callSite.method,
    endpoint: f.callSite.endpoint,
    reasons: f.reasons,
    migrationNote: f.advisory.migrationNote,
  };
}

function advisoryView(a: Advisory) {
  return {
    id: a.id,
    provider: a.provider,
    title: a.title,
    severity: a.severity,
    changeClass: a.changeClass,
    endpoint: `${a.endpoint.method} ${a.endpoint.path}`,
    effectiveDate: a.effectiveDate,
    firstObserved: a.firstObserved,
    migrationNote: a.migrationNote,
    recipeId: a.recipeId ?? null,
    status: a.status,
    sources: a.sources,
  };
}

function outcomeView(o: FixOutcome) {
  const r = o.result;
  return {
    advisory: o.finding.advisory.id,
    callSite: `${o.finding.callSite.file}:${o.finding.callSite.line}`,
    status: r?.status ?? "skipped",
    method: r?.method ?? null,
    reason: r?.reason ?? o.skipped ?? null,
    shapeSource: o.shapeSource ?? null,
    attempts: r?.attempts.map((a) => ({ method: a.method, outcome: a.outcome, detail: a.detail })) ?? [],
    diff: r?.status === "fixed" ? r.changes.map((c) => createTwoFilesPatch(`a/${c.file}`, `b/${c.file}`, c.before, c.after, "", "", { context: 3 })).join("") : null,
    pullRequest: o.pr?.url ?? null,
  };
}

/** Serve over stdio (how Claude Code, Cursor and other editors launch MCP servers). */
export async function startStdio(opts: ServerOptions = {}): Promise<void> {
  await preparePython();
  await createServer(opts).connect(new StdioServerTransport());
}
