# Okapi head-to-head

Okapi (okapi.bot, GitHub App `okapi-agent`) opens pull requests that move code off retired models and APIs. This page compares SHAPI with every public PR Okapi had opened by 2026-10-29: **14 PRs in 9 repositories**, 1 of them merged. The plan's "14 repositories" was 14 PRs; five of them are in one repository.

It's a scan-only comparison on public history:

- For each PR, SHAPI scans the commit the PR is based on, with the advisories in this repository at the commit named below.
- Nothing in the repositories is run, and **no pull request, issue or comment was opened anywhere**.
- The dataset is [`datasets/okapi-prs.json`](datasets/okapi-prs.json): each PR's base commit, the files and lines Okapi changed, and hand-checked fields for what SHAPI has on the same change.

Run it again with `pnpm --filter @shapi/bench bench:okapi`.

## Columns

- **SHAPI advisory:** whether SHAPI's advisory database covers the change Okapi's PR is about. This was checked by hand.
- **SHAPI verdict:** SHAPI's strongest finding for those advisories at the base commit.
  - `missed` means SHAPI has the advisory but found no call site.
  - `no advisory` means SHAPI has no advisory for this change.
  - `not scanned` means every file Okapi changed is in a language SHAPI does not scan (Kotlin here).
- **Fix agreement:** whether SHAPI's advisory moves the code to the same target as Okapi's diff. The target comes from the advisory's fix, or from the model or version its migration note names.
  - This compares targets only. SHAPI did not generate a fix here, because that would mean running repair on someone else's repository.
- **Other SHAPI findings in Okapi's files:** affected call sites for other advisories, in the files Okapi changed, that Okapi's PR does not mention.

## Results

- **Languages:** 9 of the 14 PRs change TypeScript, JavaScript or Python. The 5 PumpWatch3 PRs change Kotlin, which SHAPI does not scan. They are also bug fixes in how the app reads crypto APIs (Gate, GoPlus, dRPC, Helius, Solana RPC), not announced API changes.
- **Coverage:** SHAPI has advisories for 3 of the 14 changes. For all 3, its advisory names the same target as Okapi's diff: `gemini-3.6-flash`, `gemini-3.8-flash-tts` and Graph `v26.0`.
- **Found:** SHAPI found 1 of those 3. studymind-ai's `gemini-2.0-flash` call is flagged at `src/api/gemini.js:141`, in the file Okapi changed.
- **Missed:** 2 of the 3, both extractor gaps:
  - **tugpt (Graph v21.0).** The version is a constant that the client copies into a class field in its constructor (`this.graphVersion = config.graphVersion || DEFAULT_GRAPH_VERSION`) and puts in the URL in another method. SHAPI does not follow values through class fields.
  - **MoneyPrinterTurbo (Gemini 2.5 preview TTS).** The call is `client.models.generate_content(model="gemini-2.5-flash-preview-tts")` on a client bound with `with genai.Client(...) as client:`. SHAPI's Python extractor does not recognize a client bound by `with … as`.
- **No advisory:** 6 changes in scanned languages have no SHAPI advisory:
  - 4 model retirements: Groq `llama-3.3-70b-versatile`, Gemini `gemini-1.5-flash`, Anthropic `claude-3-5-sonnet-latest` and DeepSeek `deepseek-chat`;
  - 2 parameter rejections: `effort` on Claude Haiku 4.5, and `thinking_level` on Gemini 3.
  - These are the long tail of model catalogs that Okapi covers broadly. SHAPI's advisories go deeper on fewer APIs.
- **Found beyond Okapi:** 1. In youtube, the file Okapi changed (`topic-picker.ts`) also fetches `reddit.com/r/<sub>/top.json` without signing in. SHAPI flags that against its Reddit advisory (logged-out `.json` returns 403); Okapi's PR does not mention it.

## What this shows

- **Different coverage.** Okapi's 14 PRs are mostly model retirements and single-call bugs, found by testing calls live. SHAPI's advisory database covered 3 of them, with the same replacement each time.
- **What to fix in SHAPI.** The two misses are concrete extractor work: values held in class fields, and Python `with … as` clients. Both apply well beyond these repositories.
- **Model catalogs.** The model retirements SHAPI has no advisory for are the slice the plan covers by ingesting models.dev and provider deprecation pages.
- **Limits.**
  - The sample is small (14 PRs) and made of hobby repositories, so treat it as a description, not a rate.
  - The reverse direction (does Okapi know the changes in APIBreak-Replay) is not measured here.

## Table

<!-- table:start -->
Run on 2026-10-30 with SHAPI 0.3.1 (git d569bbe), dataset `e6adcfbdc994`. Results: [results/okapi/0.3.1/e6adcfbdc994.json](results/okapi/0.3.1/e6adcfbdc994.json).

| Okapi PR | Change | Base commit | SHAPI advisory | SHAPI verdict | Fix agreement | Other SHAPI findings in Okapi's files |
|---|---|---|---|---|---|---|
| [abdellahsinaoui1-lang/Fire-Ai-bot#1](https://github.com/abdellahsinaoui1-lang/Fire-Ai-bot/pull/1) | retirement: fix(groq): move chat and parser off llama-3.3-70b-versatile | [`dc69de9`](https://github.com/abdellahsinaoui1-lang/Fire-Ai-bot/tree/dc69de9bef6e8c2358cffc7c74e82af521ab21b3) | no | no advisory | no SHAPI advisory | none |
| [ajayma7339-code/youtube#1](https://github.com/ajayma7339-code/youtube/pull/1) | retirement: fix(gemini): move calls to gemini-3.8-flash, gemini-1.5-flash is retired | [`ad4cbff`](https://github.com/ajayma7339-code/youtube/tree/ad4cbff73780c9e461b558e9fa7a53c666a425bf) | no | no advisory | no SHAPI advisory | `yt-automation/yt-automation/src/topic-picker.ts:49 reddit-logged-out-json-403` |
| [alyawiguna310-blip/LUMI#2](https://github.com/alyawiguna310-blip/LUMI/pull/2) | retirement: fix(anthropic): move default model off claude-3-5-sonnet-latest | [`9204f0d`](https://github.com/alyawiguna310-blip/LUMI/tree/9204f0d70d1f2ff54b7073c1aeb24c62953e9dbf) | no | no advisory | no SHAPI advisory | none |
| [basilll007/MedPerturb#1](https://github.com/basilll007/MedPerturb/pull/1) | parameter: fix(anthropic): remove the effort parameter Haiku 4.5 rejects | [`78baa1b`](https://github.com/basilll007/MedPerturb/tree/78baa1bec4a7bedf34076806fa83c7435ec75392) | no | no advisory | no SHAPI advisory | none |
| [basilll007/MedPerturb#2](https://github.com/basilll007/MedPerturb/pull/2) | parameter: fix(gemini): send thinking_level and drop temperature on Gemini 3.x | [`78baa1b`](https://github.com/basilll007/MedPerturb/tree/78baa1bec4a7bedf34076806fa83c7435ec75392) | no | no advisory | no SHAPI advisory | none |
| [coderxp1/tugpt#7](https://github.com/coderxp1/tugpt/pull/7) | retirement: fix(facebook): default WhatsApp media client to Graph v26.0 | [`440dcae`](https://github.com/coderxp1/tugpt/tree/440dcaec9ecc87bf6c6488332e3bb2815a5bc03d) | yes: `meta-graph-v21-sunset` | missed | same target (SHAPI v26.0, Okapi v26.0) | none |
| [hasanaskaryan1983/PumpWatch3#1](https://github.com/hasanaskaryan1983/PumpWatch3/pull/1) | response: fix(gate): read create_time_ms as the string Gate sends | [`7a2ba0e`](https://github.com/hasanaskaryan1983/PumpWatch3/tree/7a2ba0e09ddf33db4bb10dd44369afcaad0f90a9) | no | not scanned | no SHAPI advisory | none |
| [hasanaskaryan1983/PumpWatch3#2](https://github.com/hasanaskaryan1983/PumpWatch3/pull/2) | response: fix(goplus): read Solana authority flags and EVM LP locks as GoPlus returns them | [`7a2ba0e`](https://github.com/hasanaskaryan1983/PumpWatch3/tree/7a2ba0e09ddf33db4bb10dd44369afcaad0f90a9) | no | not scanned | no SHAPI advisory | none |
| [hasanaskaryan1983/PumpWatch3#3](https://github.com/hasanaskaryan1983/PumpWatch3/pull/3) | retirement: fix(solana): drop the keyless dRPC endpoint, which no longer serves Solana | [`7a2ba0e`](https://github.com/hasanaskaryan1983/PumpWatch3/tree/7a2ba0e09ddf33db4bb10dd44369afcaad0f90a9) | no | not scanned | no SHAPI advisory | none |
| [hasanaskaryan1983/PumpWatch3#4](https://github.com/hasanaskaryan1983/PumpWatch3/pull/4) | bug: fix(helius): send the personal API key on every request | [`7a2ba0e`](https://github.com/hasanaskaryan1983/PumpWatch3/tree/7a2ba0e09ddf33db4bb10dd44369afcaad0f90a9) | no | not scanned | no SHAPI advisory | none |
| [hasanaskaryan1983/PumpWatch3#5](https://github.com/hasanaskaryan1983/PumpWatch3/pull/5) | bug: fix(solana): use getTransaction, getParsedTransaction is not an RPC method | [`7a2ba0e`](https://github.com/hasanaskaryan1983/PumpWatch3/tree/7a2ba0e09ddf33db4bb10dd44369afcaad0f90a9) | no | not scanned | no SHAPI advisory | none |
| [ismail-sha/studymind-ai#1](https://github.com/ismail-sha/studymind-ai/pull/1) | retirement: fix(gemini): move chat calls off gemini-2.0-flash before it shuts down | [`e9e7c16`](https://github.com/ismail-sha/studymind-ai/tree/e9e7c16c58842c4d0de291681da37a267c71c147) | yes: `google-gemini-2-0-flash-shutdown`, `google-gemini-2-0-flash-shutdown-sdk` | affected: `src/api/gemini.js:141 google-gemini-2-0-flash-shutdown` | same target (SHAPI gemini-3.6-flash, Okapi gemini-3.6-flash) | none |
| [saudmoto6868-oss/ai-trading-dashboard#7](https://github.com/saudmoto6868-oss/ai-trading-dashboard/pull/7) | retirement: fix(deepseek): move school review off deepseek-chat before it shuts down | [`29a68ff`](https://github.com/saudmoto6868-oss/ai-trading-dashboard/tree/29a68ffd43263172bc1e72852c5d33a05c93f297) | no | no advisory | no SHAPI advisory | none |
| [seanford/MoneyPrinterTurbo#2](https://github.com/seanford/MoneyPrinterTurbo/pull/2) | retirement: fix(gemini): move TTS to gemini-3.8-flash-tts before 2.5 preview shuts | [`c184fcc`](https://github.com/seanford/MoneyPrinterTurbo/tree/c184fccd05621d7a654b6e6ea34102a0a0de0657) | yes: `google-gemini-2-5-preview-tts-shutdown`, `google-gemini-2-5-preview-tts-shutdown-sdk` | missed | same target (SHAPI gemini-3.8-flash-tts, Okapi gemini-3.8-flash-tts) | none |
<!-- table:end -->
