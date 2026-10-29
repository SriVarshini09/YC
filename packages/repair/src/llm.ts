import Anthropic from "@anthropic-ai/sdk";
import type { Advisory, LockedCallSite } from "@shapi/core";
import { z } from "zod";

export interface FixRequest {
  advisory: Advisory;
  callSite: LockedCallSite;
  /** The file holding the call site, as it is now. */
  file: { path: string; content: string };
  /** The generated contract test the fix must make pass. It is not to be edited. */
  test: { path: string; content: string };
  /** Vitest output from the failing run. */
  failingOutput: string;
}

export type FixProposal =
  | { status: "proposed"; files: { path: string; content: string }[]; explanation: string; model: string }
  | { status: "declined"; reason: string };

/** Anything that can propose a fix; Claude in production, a stub in tests. */
export interface LlmFixer {
  fix(request: FixRequest): Promise<FixProposal>;
}

/**
 * Model calls the fixes of one scan (all its fix job's attempts, retries included) or one `shapi fix` run may
 * make: each is a high-effort request carrying a whole file. SHAPI_LLM_CALLS_PER_JOB overrides it.
 */
export const DEFAULT_LLM_CALLS_PER_JOB = 20;

/** Larger files go to no model: the fix needs the whole file back, so the prompt would be all of it. */
export const MAX_LLM_FILE_BYTES = 200_000;

/**
 * `llm`, declining every call after the first `max`, so big scans cannot run up the bill. `take` counts one
 * call and returns how many there have been, this one included: the fix job keeps the count on the scan, so
 * a retried job shares the budget. By default calls are counted in memory, for this budget only.
 */
export function withCallBudget(llm: LlmFixer, max = callsPerJob(), take?: () => Promise<number>): LlmFixer {
  let calls = 0;
  const next = take ?? (async () => ++calls);
  return {
    async fix(req) {
      if ((await next()) > max) return { status: "declined", reason: `the ${max} LLM calls allowed are used up (SHAPI_LLM_CALLS_PER_JOB)` };
      return llm.fix(req);
    },
  };
}

function callsPerJob(): number {
  const n = Number(process.env.SHAPI_LLM_CALLS_PER_JOB);
  return Number.isInteger(n) && n >= 0 && process.env.SHAPI_LLM_CALLS_PER_JOB !== "" ? n : DEFAULT_LLM_CALLS_PER_JOB;
}

/** The model the plan names for the repair agent; SHAPI_REPAIR_MODEL overrides it. */
export const DEFAULT_REPAIR_MODEL = "claude-fable-5-1";

const ProposalSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1),
  explanation: z.string(),
});

const SUBMIT_FIX: Anthropic.Beta.BetaTool = {
  name: "submit_fix",
  description:
    "Submit the corrected files. Each entry is a repo-relative path and the file's complete new content (not a diff). " +
    "Include only files you changed. Never include the contract test.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      explanation: { type: "string", description: "One or two sentences on what changed and why, for the pull request." },
    },
    required: ["files", "explanation"],
    additionalProperties: false,
  },
};

const SYSTEM = `You repair third-party API integrations after the provider changed its behavior.
You get a breaking-change advisory, the call site that depends on the old behavior, the file around it, and a contract test that calls the code with the old response and with the new one. The test currently fails on the new response.
Make the smallest change that lets the code handle both responses. Keep its behavior for the old response, keep the file's style, and do not touch unrelated code. Do not edit the test.
When done, call submit_fix with the complete content of each file you changed. If no safe change exists, explain why in text and do not call the tool.`;

/** Claude-backed fixer. Credentials come from the environment (ANTHROPIC_API_KEY or an `ant auth login` profile). */
export function claudeFixer(opts: { client?: Anthropic; model?: string } = {}): LlmFixer {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? process.env.SHAPI_REPAIR_MODEL ?? DEFAULT_REPAIR_MODEL;
  return {
    async fix(req) {
      const size = Buffer.byteLength(req.file.content);
      if (size > MAX_LLM_FILE_BYTES) return { status: "declined", reason: `${req.file.path} is too large to send to the model (${Math.round(size / 1000)} kB, limit ${MAX_LLM_FILE_BYTES / 1000} kB)` };
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: 16000,
          // Thinking is always on for this model; effort sets its depth.
          output_config: { effort: "high" },
          // On a safety-classifier decline, retry server-side on Anthropic's recommended fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: SYSTEM,
          tools: [SUBMIT_FIX],
          tool_choice: { type: "auto" },
          messages: [{ role: "user", content: prompt(req) }],
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) return { status: "declined", reason: "Claude API authentication failed (set ANTHROPIC_API_KEY)" };
        if (err instanceof Anthropic.RateLimitError) return { status: "declined", reason: "Claude API rate limit reached; retry later" };
        if (err instanceof Anthropic.APIError) return { status: "declined", reason: `Claude API error ${err.status ?? ""}: ${err.message}`.trim() };
        throw err;
      }

      if (response.stop_reason === "refusal") {
        return { status: "declined", reason: `model declined (${response.stop_details?.category ?? "no category"})` };
      }
      if (response.stop_reason === "max_tokens") return { status: "declined", reason: "response hit max_tokens before finishing" };
      const call = response.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === "submit_fix");
      if (!call) {
        const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");
        return { status: "declined", reason: text.trim() || "model did not submit a fix" };
      }
      const parsed = ProposalSchema.safeParse(call.input);
      if (!parsed.success) return { status: "declined", reason: `fix did not match the submit_fix schema: ${z.prettifyError(parsed.error)}` };
      return { status: "proposed", ...parsed.data, model: response.model };
    },
  };
}

function prompt(req: FixRequest): string {
  const { advisory, callSite } = req;
  return `<advisory>
${JSON.stringify(
  {
    id: advisory.id,
    provider: advisory.provider,
    title: advisory.title,
    summary: advisory.summary,
    endpoint: advisory.endpoint,
    changeClass: advisory.changeClass,
    trigger: advisory.trigger,
    migrationNote: advisory.migrationNote,
  },
  null,
  2,
)}
</advisory>

<call_site>${callSite.file}:${callSite.line}:${callSite.column} ${callSite.method ?? "?"} ${callSite.endpoint ?? "?"}</call_site>

<file path="${req.file.path}">
${req.file.content}
</file>

<contract_test path="${req.test.path}">
${req.test.content}
</contract_test>

<failing_test_output>
${req.failingOutput.slice(-6000)}
</failing_test_output>`;
}
