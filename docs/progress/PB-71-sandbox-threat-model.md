# PB-71: Sandbox threat model (execution plan SC-02)

## Why

SHAPI runs code it didn't write (customer code and tests, dependency install scripts, Claude's fixes) to prove each fix. Customers' security reviews will ask how. SC-02 asks for a written threat model, reviewed.

## What changes

- **`docs/security/sandbox-threat-model.md`** covers:
  - assets, trust boundaries and the data flow of a fix job, step by step;
  - eleven threats, each with today's control, the residual risk and a recommendation;
  - scanning;
  - open items;
  - a sign-off line for the founder.
- **Every claim points at the code:**
  - the Firecracker microVM per job;
  - registry-only egress during install, then no network;
  - no SHAPI secret inside the sandbox;
  - the lifetimes and output caps;
  - `safeRelative` and `shellQuote`;
  - the local provider refused in production.

## Findings

- **T3, high:** the whole repository is in the sandbox while dependency install scripts run with the npm registries reachable. The registry can accept uploads, so a malicious `postinstall` could exfiltrate the source. Recommended fix: install from the manifests and lockfiles alone, cut the network, then write the rest.
- **T4, to verify:** whether DNS lookups for denied names leave the VM during install.
- **T2:** committed `.env` files are copied into the sandbox with the code.

## Status

The document is written; the founder's review is still needed. SC-02 is ticked once it's signed off.
