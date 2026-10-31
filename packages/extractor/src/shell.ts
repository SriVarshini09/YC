import { getProvider, pathUnresolved, type CallSite, type HttpMethod, type NameValue, type Surface } from "@shapi/core";
import { parseUrl, providerOf } from "./callsites";

// Shell call sites: `curl` and `gh api` in shell scripts and in the `run:` steps of GitHub Actions workflows.
// Line-based, no shell parser: a command is read up to the end of its line (after `\` continuations), its
// URL from literal assignments and `env:` values in the file, and the status codes it depends on from a
// variable the command's output is assigned to (`STATUS="$(curl -w "%{http_code}" …)"`) and the
// comparisons that follow (`[[ "$STATUS" != "204" ]]`). Found in real breakages SHAPI missed on
// APIBreak-Replay (refracta/df-translations, kikujizo/ai-harness).

/** A script's lines, keeping each one's line number in the file. */
interface Line {
  n: number;
  text: string;
}

/** Shell scripts by extension; workflow files by where they live. */
export const SHELL_FILE = /\.(sh|bash)$/;
export const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** Every curl and gh api call in a shell script or a workflow file (`rel` is the repository-relative path). */
export function extractShell(text: string, rel: string): CallSite[] {
  const lines = text.split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t }));
  const env = WORKFLOW_FILE.test(rel) ? workflowEnv(lines) : new Map<string, string>();
  const scripts = WORKFLOW_FILE.test(rel) ? runBlocks(lines) : [lines];
  return scripts.flatMap((script) => scriptCalls(script, rel, env));
}

/** `run:` steps: a block scalar (`run: |`) with its indented lines, or the command on the same line. */
function runBlocks(lines: Line[]): Line[][] {
  const out: Line[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]!.text);
    if (!m) continue;
    const indent = m[1]!.length;
    const rest = m[2]!.trim();
    if (!/^[|>][-+]?\d*$/.test(rest)) {
      if (rest) out.push([{ n: lines[i]!.n, text: rest.replace(/^["']|["']$/g, "") }]);
      continue;
    }
    const block: Line[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.text;
      if (t.trim() && t.length - t.trimStart().length <= indent) break;
      block.push(lines[j]!);
    }
    out.push(block);
  }
  return out;
}

/**
 * `KEY: value` entries of every `env:` mapping in the workflow. An expression stays a placeholder named for its
 * last part: `${{ steps.guard.outputs.target_repo }}` is `{target_repo}`.
 */
function workflowEnv(lines: Line[]): Map<string, string> {
  const env = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)env:\s*$/.exec(lines[i]!.text);
    if (!m) continue;
    const indent = m[1]!.length;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.text;
      if (t.trim() && t.length - t.trimStart().length <= indent) break;
      const kv = /^\s*([A-Za-z_][\w]*):\s*(.+?)\s*$/.exec(t);
      if (!kv || env.has(kv[1]!)) continue;
      env.set(kv[1]!, unquote(kv[2]!).replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_m, e: string) => `{${e.split(/[.\s]/).pop()}}`));
    }
  }
  return env;
}

/** One command per logical line: `\` continuations joined, the first line's number kept. */
function logical(script: Line[]): Line[] {
  const out: Line[] = [];
  let cur: Line | undefined;
  for (const l of script) {
    const t = l.text.replace(/\s+$/, "");
    if (cur) cur.text += ` ${t.trim()}`;
    else cur = { n: l.n, text: t };
    if (t.endsWith("\\")) cur.text = cur.text.slice(0, -1);
    else {
      out.push(cur);
      cur = undefined;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function scriptCalls(script: Line[], file: string, env: Map<string, string>): CallSite[] {
  const commands = logical(script);
  const vars = new Map(env);
  const out: CallSite[] = [];
  for (const [i, cmd] of commands.entries()) {
    const text = cmd.text.trim();
    if (text.startsWith("#")) continue;
    // NAME="literal" (no command substitution): used in later URLs.
    const assign = /^(?:export\s+)?([A-Za-z_]\w*)=("[^"$`]*"|'[^']*'|[^\s"'$`;|&()]+)$/.exec(text);
    if (assign) vars.set(assign[1]!, unquote(assign[2]!));
    for (const m of text.matchAll(/(?:^|[\s"'`(;|&])(curl|gh\s+api)(?=\s)/g)) {
      const start = (m.index ?? 0) + m[0].length - m[1]!.length;
      const call = m[1] === "curl" ? curlCall(text.slice(start + 4), vars) : ghApiCall(text.slice(start + m[1]!.length), vars);
      if (!call) continue;
      // STATUS="$(curl … -w "%{http_code}" …)" / HTTP_CODE="$(gh api -i … | head -n 1 | awk '{print $2}')"
      const target = /^(?:export\s+|local\s+)?([A-Za-z_]\w*)=/.exec(text)?.[1];
      const statusVar = target && (call.writesStatus || call.includesHeaders) ? target : undefined;
      const surface = emptySurface();
      surface.headers = call.headers;
      if (statusVar) for (const later of commands.slice(i + 1)) for (const code of comparedCodes(later.text, statusVar)) if (!surface.statusCodes.includes(code)) surface.statusCodes.push(code);
      surface.statusCodes.sort((a, b) => a - b);
      // gh api and curl -f exit non-zero on an error status: the script treats any 2xx as success.
      surface.checksOk = surface.statusCodes.length === 0 && call.failsOnError;
      const { host, path, query, runtimeHost } = parseUrl(call.url);
      surface.query = query;
      const provider = call.client === "gh" ? "github" : providerOf(host, path, runtimeHost);
      // Scripts curl installers, artifacts and their own services: only known APIs are call sites here.
      if (!provider) continue;
      out.push({
        file,
        line: cmd.n,
        column: Math.max(0, script.find((l) => l.n === cmd.n)?.text.search(/\S/) ?? 0) + 1,
        provider,
        kind: "http",
        client: call.client,
        method: call.method,
        host: call.client === "gh" ? (getProvider("github")?.hosts[0] ?? "api.github.com") : host,
        endpoint: path,
        resolved: Boolean(provider && path) && !pathUnresolved(path ?? ""),
        surface,
      });
    }
  }
  return out;
}

interface ShellCall {
  client: "curl" | "gh";
  method: HttpMethod;
  url: string | undefined;
  headers: NameValue[];
  /** `-w "%{http_code}"`: the command prints the status. */
  writesStatus: boolean;
  /** `gh api -i` / `curl -i`: the status line is in the output. */
  includesHeaders: boolean;
  /** `gh api` always, `curl -f`/`--fail`: an error status makes the command fail. */
  failsOnError: boolean;
}

/** Shell words up to the end of the command (an unquoted `|`, `;`, `&&`, `)` or redirection ends it). */
function words(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "$" && s[i + 1] === "(") depth++;
    if (c === ")" && depth > 0) depth--;
    else if (depth === 0 && (c === "|" || c === ";" || c === ")" || c === ">" || c === "<" || (c === "&" && s[i + 1] === "&"))) break;
    if (/\s/.test(c) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** `$NAME`, `${NAME}`, `${NAME:-x}` and `${{ … }}` in a word: known literals substituted, the rest as {NAME}. */
function expand(word: string, vars: Map<string, string>): string {
  return word
    .replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_m, e: string) => `{${e.split(/[.\s]/).pop()}}`)
    .replace(/\$\{([A-Za-z_]\w*)(?::?[-=?+][^}]*)?\}|\$([A-Za-z_]\w*)/g, (_m, a?: string, b?: string) => {
      const name = (a ?? b)!;
      return vars.get(name) ?? `{${name}}`;
    });
}

const CURL_VALUE = new Set(["-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-F", "--form", "-o", "--output", "-w", "--write-out", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-m", "--max-time", "--connect-timeout", "--retry", "-b", "--cookie", "-c", "--cookie-jar", "-T", "--upload-file", "--url", "--cacert", "--cert", "--key", "-K", "--config", "--retry-delay", "--retry-max-time", "-x", "--proxy"]);

function curlCall(rest: string, vars: Map<string, string>): ShellCall | undefined {
  const w = words(rest);
  let method: HttpMethod | undefined;
  let url: string | undefined;
  let data = false;
  let writesStatus = false;
  let includesHeaders = false;
  let failsOnError = false;
  const headers: NameValue[] = [];
  for (let i = 0; i < w.length; i++) {
    const a = w[i]!;
    if (a.startsWith("--") || (a.startsWith("-") && a.length > 1)) {
      const value = CURL_VALUE.has(a) ? w[++i] : undefined;
      if (a === "-X" || a === "--request") method = value?.toUpperCase() as HttpMethod;
      else if (a === "-H" || a === "--header") {
        const h = value ? expand(value, vars) : "";
        const colon = h.indexOf(":");
        if (colon > 0) headers.push({ name: h.slice(0, colon).trim().toLowerCase(), value: h.slice(colon + 1).trim() || null });
      } else if (/^(-d|--data.*|--json|-F|--form|-T|--upload-file)$/.test(a)) data = true;
      else if (a === "-w" || a === "--write-out") writesStatus ||= /http_code|response_code/.test(value ?? "");
      else if (a === "--url") url = value;
      else if (a === "--fail" || a === "--fail-with-body") failsOnError = true;
      else if (a === "--include") includesHeaders = true;
      else if (/^-[a-zA-Z]+$/.test(a)) {
        // combined short flags: -fsSL, -sSf, -i
        if (a.includes("f")) failsOnError = true;
        if (a.includes("i")) includesHeaders = true;
      }
      continue;
    }
    url ??= a;
  }
  if (!url) return undefined;
  return { client: "curl", method: method ?? (data ? "POST" : "GET"), url: expand(url, vars), headers, writesStatus, includesHeaders, failsOnError };
}

const GH_VALUE = new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache", "-p", "--preview"]);

function ghApiCall(rest: string, vars: Map<string, string>): ShellCall | undefined {
  const w = words(rest);
  let method: HttpMethod | undefined;
  let endpoint: string | undefined;
  let fields = false;
  let includesHeaders = false;
  const headers: NameValue[] = [];
  for (let i = 0; i < w.length; i++) {
    const a = w[i]!;
    if (a.startsWith("-") && a.length > 1) {
      const value = GH_VALUE.has(a) ? w[++i] : undefined;
      if (a === "-X" || a === "--method") method = value?.toUpperCase() as HttpMethod;
      else if (a === "-f" || a === "--raw-field" || a === "-F" || a === "--field" || a === "--input") fields = true;
      else if (a === "-i" || a === "--include") includesHeaders = true;
      else if (a === "-H" || a === "--header") {
        const colon = value?.indexOf(":") ?? -1;
        if (value && colon > 0) headers.push({ name: value.slice(0, colon).trim().toLowerCase(), value: value.slice(colon + 1).trim() || null });
      }
      continue;
    }
    endpoint ??= a;
  }
  // `gh api graphql` is not a REST path.
  if (!endpoint || endpoint === "graphql") return undefined;
  const path = expand(endpoint, vars);
  const url = /^https?:\/\//.test(path) ? path : `https://api.github.com/${path.replace(/^\/+/, "")}`;
  return { client: "gh", method: method ?? (fields ? "POST" : "GET"), url, headers, writesStatus: false, includesHeaders, failsOnError: true };
}

/** Status codes `$NAME` is compared with on a line: `"$STATUS" != "204"`, `$CODE -eq 200`, `(( CODE == 204 ))`. */
function comparedCodes(line: string, name: string): number[] {
  const v = `(?:\\$\\{${name}(?::-[^}]*)?\\}|\\$${name}\\b|\\b${name}\\b)`;
  const op = `(?:==|!=|=|-eq|-ne)`;
  const code = `"?'?([1-5]\\d\\d)\\b`;
  const out: number[] = [];
  for (const m of line.matchAll(new RegExp(`${v}"?'?\\s*${op}\\s*${code}`, "g"))) out.push(Number(m[1]));
  for (const m of line.matchAll(new RegExp(`\\b([1-5]\\d\\d)"?'?\\s*${op}\\s*"?'?${v}`, "g"))) out.push(Number(m[1]));
  return out;
}

function unquote(s: string): string {
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

function emptySurface(): Surface {
  return { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] };
}
