import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { leaderboardTable, scoreSubmission, scoredIds, shapiSubmission, submissionProblems, type Dataset, type Submission } from "../src/index";

// Execution plan P-15: a leaderboard that accepts other tools' results.
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(path.join(pkg, "datasets", "apibreak-v0.json"), "utf8");
const dataset = JSON.parse(raw) as Dataset;
const target = { name: dataset.name, hash: createHash("sha256").update(raw).digest("hex").slice(0, 12), scored: scoredIds(dataset) };
const grep = JSON.parse(readFileSync(path.join(pkg, "submissions", "grep-baseline.json"), "utf8")) as Submission;

describe("leaderboard (P-15)", () => {
  it("accepts the grep baseline's submission and scores it like SHAPI's run", () => {
    expect(target.scored).toHaveLength(14);
    expect(submissionProblems(grep, target)).toEqual([]);
    const row = scoreSubmission(grep);
    expect(row.recall).toMatchObject({ k: 14, n: 14 });
    expect(row.fixedStatePrecision).toMatchObject({ k: 4, n: 14 });
    const run = JSON.parse(readFileSync(path.join(pkg, "results", "0.3.1", `${target.hash}.json`), "utf8"));
    const shapi = scoreSubmission(shapiSubmission(run, target.scored));
    expect([shapi.recall?.k, shapi.fixedStatePrecision?.k]).toEqual([run.summary.flagRecall.k, run.summary.fixedStatePrecision.k]);
    expect(leaderboardTable([shapi, row]).split("\n")[2]).toMatch(/^\| \[grep baseline\]/);
  });

  it("rejects a submission that misses an instance, adds one, uses another dataset or an unknown verdict", () => {
    const [first, ...rest] = grep.results;
    expect(submissionProblems({ ...grep, results: rest }, target)).toEqual([`${first!.id}: missing`]);
    expect(submissionProblems({ ...grep, results: [...grep.results, { id: "x__y__z", base: "flagged", fix: "clear" }] }, target)).toEqual(["x__y__z: not a scored instance"]);
    expect(submissionProblems({ ...grep, datasetHash: "000000000000" }, target)[0]).toMatch(/^scored against/);
    expect(submissionProblems({ ...grep, results: [{ ...first!, base: "maybe" as never }, ...rest] }, target)).toEqual([`${first!.id}: base and fix must each be flagged, clear or error`]);
    expect(submissionProblems({ ...grep, url: "http://example.com", tool: "" }, target)).toEqual(["tool is missing", "url must be https"]);
  });
});
