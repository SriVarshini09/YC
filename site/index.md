---
layout: home

hero:
  name: SHAPI
  text: Your code, when the API changes
  tagline: Find every call site that breaks when a third-party API changes its behavior, and fix it test-first.
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: How it works
      link: /guide/how-it-works
    - theme: alt
      text: GitHub
      link: https://github.com/SriVarshini09/YC

features:
  - title: Maps what your code depends on
    details: SHAPI reads your TypeScript, JavaScript and Python and lists every third-party API call, the endpoint it hits, and what the code relies on in the response, such as a status code, a field or an enum. The result is your api.lock.
  - title: Knows what changed
    details: An open advisory database of real API behavior changes, including silent ones like GitHub's workflow_dispatch answering 200 instead of 204, says which call sites are affected and which are only exposed.
  - title: Fixes it test-first
    details: For each affected call site SHAPI writes a contract test that fails on the new response, applies a deterministic fix, and keeps the change only if the test passes.
---

## Try it in one command

```sh
npx shapi-cli scan .
```

It reads your code and runs none of it. You get the affected call sites, why each one breaks, and the deadlines coming up. See the [quickstart](/guide/quickstart).
