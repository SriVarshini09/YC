# PB-92: A Go scanner, scan only (execution plan U-07)

## What changes

- **`packages/extractor/src/go.ts`** parses Go with tree-sitter (`tree-sitter-go`'s prebuilt wasm; its native binding isn't built). It finds `net/http` requests:
  - `http.Get`, `Head`, `Post` and `PostForm`;
  - `http.NewRequest` and `NewRequestWithContext`, sent with `client.Do(req)`.
- **URLs** are built from string literals, `+`, package constants, locals and `fmt.Sprintf`; unknown parts become `{name}`.
- **Request headers** come from `req.Header.Set` and `req.Header.Add`, and the method from a string or `http.MethodX`.
- **The response surface:**
  - status codes the code compares against (`==`, `!=`, `switch`, and the `http.StatusX` names);
  - range checks, which set `checksOk`;
  - the headers it reads (`resp.Header.Get`);
  - the JSON body's fields, taken from the struct the body is decoded into (`json.NewDecoder(resp.Body).Decode(&v)`, or `json.Unmarshal` of `io.ReadAll(resp.Body)`). That is the `json:"..."` names of the fields the code reads, through nested structs, slices and `range` loops, and the strings it compares them to (enums).
- **Scope of the scan:** `.go` files, not `_test.go` and not `vendor/`. The CLI, the worker and the npm bundle load the Go grammar next to the Python one. Go call sites are matched against the same advisories. Go gets no fixes yet.

## Verified

- **`packages/extractor/test/go.test.ts`**, on a Go fixture (`internal/github/client.go`), finds three GitHub calls:
  - a workflow dispatch, with its headers and the 204 check;
  - a list of workflows, with `workflows[].state` compared to `"active"`, 403 and 404 checked, and `X-RateLimit-Remaining` read;
  - `/user`, with `login` read from an inline struct.

  The test then builds an `api.lock` from them.
- **`shapi scan . --out api.lock`** on a copy of the fixture writes an api.lock with the three call sites. It also flags the dispatch call with the `github-workflow-dispatch-204-to-200` advisory: "compares the response status to 204".
