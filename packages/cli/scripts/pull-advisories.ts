// Refreshes advisories/ (bundled into shapi-cli and used by the tests) from the public advisory repository:
//   pnpm advisories:pull
// The public repository is the source of truth; edit advisories there, then pull.
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, type ReadEntry } from "tar";
import { AdvisorySchema } from "../../core/dist/index.js";

const REPO = process.env.SHAPI_ADVISORIES_REPO ?? "SriVarshini09/shapi-advisories";
const dir = fileURLToPath(new URL("../../../advisories", import.meta.url));

const res = await fetch(`https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`);
if (!res.ok) throw new Error(`could not download ${REPO}: ${res.status}`);
const archive = Buffer.from(await res.arrayBuffer());

const files = new Map<string, string>();
await new Promise<void>((resolve, reject) => {
  const parser = new Parser({
    onReadEntry: (entry: ReadEntry) => {
      const rel = entry.path.split("/").slice(1).join("/");
      if (entry.type !== "File" || !/^advisories\/[^/]+\.json$/.test(rel)) return void entry.resume();
      const chunks: Buffer[] = [];
      entry.on("data", (c: Buffer) => chunks.push(c));
      entry.on("end", () => files.set(path.basename(rel), Buffer.concat(chunks).toString("utf8")));
    },
  });
  parser.on("error", reject);
  parser.on("end", () => resolve());
  parser.end(archive);
});
if (!files.size) throw new Error(`${REPO} has no advisories/*.json`);

for (const [name, text] of files) {
  const parsed = AdvisorySchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${name} is not a valid advisory: ${parsed.error.message}`);
  if (`${parsed.data.id}.json` !== name) throw new Error(`${name} must be named ${parsed.data.id}.json`);
}

// Replace the published advisories; keep the local drafts/ folder and README.
const removed = readdirSync(dir).filter((f) => f.endsWith(".json") && !files.has(f));
for (const f of removed) rmSync(path.join(dir, f));
for (const [name, text] of files) writeFileSync(path.join(dir, name), text.endsWith("\n") ? text : `${text}\n`);
console.log(`pulled ${files.size} advisories from ${REPO}${removed.length ? `; removed ${removed.join(", ")}` : ""}`);
