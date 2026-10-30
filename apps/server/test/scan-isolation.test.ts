import { describe, expect, it } from "vitest";
import { ScanTooLargeError, lockInProcess } from "../src/jobs/scan";

// Execution plan I-01: each scan runs in its own memory-capped process, so a repository too large for memory
// fails alone, with a message for the user, instead of crashing the worker.
const deploy = `export async function deploy(token: string) {
  const res = await fetch("https://api.github.com/repos/acme/web/actions/workflows/ci.yml/dispatches", {
    method: "POST",
    headers: { authorization: \`Bearer \${token}\` },
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.status !== 204) throw new Error("dispatch failed");
}
`;

describe("lockInProcess", () => {
  it("scans in a separate process and returns the api.lock", async () => {
    const lock = await lockInProcess([{ path: "src/deploy.ts", content: deploy }]);
    expect(lock.callSites.map((s) => `${s.method} ${s.endpoint}`)).toEqual(["POST /repos/acme/web/actions/workflows/ci.yml/dispatches"]);
  }, 60_000);

  it("refuses a repository whose source is over the size limit, before scanning it", async () => {
    const big = [{ path: "src/a.ts", content: "x".repeat(2000) }, { path: "README.md", content: "y".repeat(1_000_000) }];
    await expect(lockInProcess(big, { maxSourceBytes: 1000 })).rejects.toThrow(ScanTooLargeError);
    await expect(lockInProcess(big, { maxSourceBytes: 1000 })).rejects.toThrow(/2\.0 KB|0\.0 MB of TypeScript, JavaScript and Python source/);
    // Files that are not source do not count.
    await expect(lockInProcess([{ path: "README.md", content: "y".repeat(5000) }], { maxSourceBytes: 1000 })).resolves.toMatchObject({ callSites: [] });
  }, 60_000);

  it("turns a scan that runs out of memory into ScanTooLargeError, and this process carries on", async () => {
    const many = Array.from({ length: 4000 }, (_, i) => `export const f${i} = () => fetch("https://api.github.com/repos/acme/r${i}/pulls");`).join("\n");
    const err = await lockInProcess([{ path: "src/many.ts", content: many }], { heapMb: 24 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScanTooLargeError);
    expect((err as Error).message).toMatch(/needed more than 24 MB of memory/);
    // The test runner is the "worker" here: it is still running and can scan again.
    await expect(lockInProcess([{ path: "src/deploy.ts", content: deploy }])).resolves.toMatchObject({ callSites: [expect.anything()] });
  }, 120_000);
});
