# PB-85: Candidate, then confirmed: one flaky probe drafts nothing (execution plan CN-03)

## Why

Until now, a canary probe drafted an advisory on the first response whose shape differed from the one before. A single odd answer turned into a draft for a person to review: a degraded replica, a proxy error page, or a field that is briefly missing.

## What changes

- **A new shape is a candidate.** The probe result says `changed`, with the diff, but nothing is drafted.
- **It is confirmed when the next cycle sees the same new shape.** That probe's result says `confirmed`, and the draft is made from the shape before the change. A shape that flips back is never confirmed.
- **The canary job** stores drafts as before; they now come only from confirmed changes.
- **Docs:** "How SHAPI works" says so.

**Detection takes one more probe cycle (an hour on the hourly schedule).** Confirming through a second account or region would remove that delay. It needs a second set of test accounts, which is the founder's (see CN-02).

## Verified

- **Canary test, one flaky response:** 204, then a single 200, then 204. Each change is a candidate, and nothing is confirmed or drafted.
- **Canary test, a change that holds:** 200 twice in a row. The second cycle confirms it, with the diff 204 → 200 and a draft whose trigger is `statusCodes: [204]`. A third cycle with the same shape is neither a change nor a new confirmation.
- **The existing canary tests pass unchanged.**
