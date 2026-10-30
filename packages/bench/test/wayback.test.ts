import { describe, expect, it } from "vitest";
import { cdxUrl, firstCapture, parseCdx, waybackTime } from "@shapi/bench";

// Execution plan P-13: the Wayback Machine's earliest capture of each advisory source.
const URL_ = "https://docs.github.com/en/rest/actions/workflows";

describe("Wayback captures (P-13)", () => {
  it("asks the CDX API for the earliest capture that answered 200", () => {
    const q = new URL(cdxUrl(URL_));
    expect(q.origin + q.pathname).toBe("https://web.archive.org/cdx/search/cdx");
    expect(Object.fromEntries(q.searchParams)).toEqual({ url: URL_, output: "json", limit: "1", fl: "timestamp,original,statuscode", filter: "statuscode:200" });
  });

  it("reads a capture, or says there is none", () => {
    expect(waybackTime("20220421100952")).toBe("2022-04-21T10:09:52Z");
    expect(() => waybackTime("2022")).toThrow();
    expect(parseCdx(URL_, [["timestamp", "original", "statuscode"], ["20220421100952", URL_, "200"]])).toEqual({
      url: URL_,
      firstCaptured: "2022-04-21T10:09:52Z",
      captureUrl: `https://web.archive.org/web/20220421100952/${URL_}`,
    });
    expect(parseCdx(URL_, [])).toEqual({ url: URL_, firstCaptured: null, note: "no capture in the Wayback Machine" });
  });

  it("retries a busy archive, and records a lookup that keeps failing instead of throwing", async () => {
    let calls = 0;
    const busyThenOk = (async () => {
      calls++;
      return calls === 1 ? new Response("slow down", { status: 429 }) : new Response(JSON.stringify([["timestamp", "original", "statuscode"], ["20240101000000", URL_, "200"]]));
    }) as typeof fetch;
    expect((await firstCapture(URL_, { fetch: busyThenOk, retryDelayMs: 0 })).firstCaptured).toBe("2024-01-01T00:00:00Z");
    expect(calls).toBe(2);
    const down = (async () => new Response("", { status: 503 })) as typeof fetch;
    expect(await firstCapture(URL_, { fetch: down, retryDelayMs: 0 })).toEqual({ url: URL_, firstCaptured: null, note: "lookup failed (HTTP 503); run again" });
    // An empty body is no capture, not an error.
    const empty = (async () => new Response("")) as typeof fetch;
    expect((await firstCapture(URL_, { fetch: empty, retryDelayMs: 0 })).note).toBe("no capture in the Wayback Machine");
  });
});
