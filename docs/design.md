# Two lanes, one workload

The demo answers one question: given the same labelling job, how long does each model take and what does it cost? Everything that is not the model is shared. Both lanes use the same reviews, batch size, concurrency, clock, validation rules, and output shape.

## Data

`data/reviews.json` holds 1,000 Android app reviews from Hugging Face [`sealuzh/app_reviews`](https://huggingface.co/datasets/sealuzh/app_reviews). `scripts/fetch-data.mjs` regenerates the file. It reads 25 evenly spaced positions in the 288,065-row training split and takes 40 usable reviews from each. A review is usable if it has 50–420 characters after whitespace is collapsed and is not a case-insensitive duplicate. Each row keeps its source row index, package name, star rating, and text. The result covers 17 apps, and its ratings split 313 / 89 / 99 / 94 / 405 from 1 to 5 stars.

Stars are never sent to a model. Both request builders send only the app name and the review text (plus an id for Gemini). The page shows stars next to each row, and they stay the independent check on sentiment.

## Lanes and batching

`lib/racers.mjs` runs both lanes through the same `race()` function. It splits the reviews into batches of 20. It then starts 8 workers that pull the next batch from a shared queue, so a slow request holds one worker and never blocks the others. 1,000 reviews make 50 batches.

Each finished batch emits a `rows` event with its timestamp, its latency, the validated rows, and running totals: rows, requests, retries, input tokens, output tokens, and cost. `start` opens the stream at `t = 0`, and `done` closes it when every worker has drained the queue. The server forwards events to the browser as server-sent events.

In the page, **Start race** opens both lanes' event streams in the same tick. The two lanes therefore run at the same time, from the same machine and network.

`BATCH_SIZE`, `CONCURRENCY`, and `PORT` come from `.env`, with defaults 20, 8, and 8777. Changing them changes both lanes.

## Questions

`lib/columns.mjs` defines the four columns once. Both lanes are built from the same definitions.

| Column | Definition | Jev type | Gemini field |
| --- | --- | --- | --- |
| Sentiment | 5 described levels, very negative → very positive | `score` | `sentiment`: integer 0–4 |
| Topic | bug, pricing, usability, feature_request, praise, other, each with a description | `choice` | `topic`: one key |
| Bug report | "reports a bug, crash, error, freeze, or a feature that stopped working" | `noul` | `bug`: number 0–1 |
| Churn risk | 4 described levels, no sign of leaving → gone | `score` | `churn`: integer 0–3 |

**Jev.** One request to `https://api.typesafe.ai/v1/systemone` carries the batch as state (`reviews[i].app`, `reviews[i].text`) and four questions per review, so a batch of 20 carries 80 questions. Each question names its review by path and carries its own criteria. The questions are independent, and none of them reads another's answer. `TYPESAFE_MODEL` defaults to the `jev-latest` alias. The run records the versioned model from the response, which was `jev-1.13.0`.

**Gemini.** One request to the OpenAI-compatible `/chat/completions` endpoint. The system prompt lists the same level descriptions and topic definitions and asks for `{"results": [...]}` with one entry per review. The user message is the batch as JSON (`id`, `app`, `text`). The request sets `response_format: {"type": "json_object"}` and merges `LLM_EXTRA_BODY`. For the recorded run that was `{"reasoning_effort": "none"}`, which turns thinking off. It is 3.8 Flash's fastest and cheapest setting, and the model rejects `"minimal"`.

Any OpenAI-compatible endpoint works in the right lane: OpenAI, OpenRouter, DeepSeek, Groq, or others. If the response includes `usage.cost` (OpenRouter does), that billed cost is used. Otherwise cost comes from `LLM_PRICE_INPUT` and `LLM_PRICE_OUTPUT`.

## Validation

Both lanes normalise answers to the same row shape: `sentiment`, `bug`, and `churn` in [0, 1], plus a topic key.

- **Jev.** Every answer must have the expected type. A score or Noul must be a finite number, and a choice must be one of the six topics. Scores are divided by the top level (4 or 3). Jev's score is a continuous value on the level scale; one review scored 0.99 on 0–4. An invalid answer stops the lane with an error. Jev's choice confidence is kept as `topic_confidence`.
- **Gemini.** Code fences are stripped, then the content is parsed as JSON and rows are matched by `id`. Sentiment, churn, and bug must be finite and in range, and the topic must be a known key. Any failure retries the whole batch, up to two times, and then stops the lane. Every attempt adds to requests, tokens, and cost, as it would in production.

Transport retries are separate. HTTP 429, 500, 502, 503, and 529 back off (`retry-after`, or 500 ms doubling) up to four times. That time counts toward the batch's latency, but the extra attempts are not added to the request count.

## Recording and replay

When a live lane finishes without being aborted, the server writes `runs/<side>.json`. The file holds the side, the answering model, `recorded_at`, rows, total milliseconds, cost, batch size, concurrency, and every event. It does not hold request bodies, headers, or keys.

**Replay** re-emits a recorded file over the same event stream. It sends `start` immediately, then waits until each later event's original `t` before sending it. Replay is 1× by construction: there is no speed parameter. The lane shows "replay · 1×" and the recorded model name. `scripts/verify-replay.mjs` checks that events arrive on their recorded offsets, within −25 / +200 ms.

Replay needs no keys, so the recorded race can be re-filmed for free. Timers in the page show the server's `t` at finish, so replayed finish times match the recording.

## Re-rank

When the race is over and Jev's lane has finished, four sliders and a topic filter re-rank the rows in the browser. Priority is `w_bug · bug + w_churn · churn + w_neg · (1 − sentiment)`, ties are broken by review id, and rows can be filtered by minimum bug probability and topic. Only the top 100 matching rows stay in table layout. Rows on screen animate to their new positions. The re-rank reads stored answers only, so it makes no network request and no model call.

## Key handling

- `server.mjs` reads `.env` into `process.env` at startup. Keys are used only in `Authorization` headers on outbound requests from the server.
- `/api/config` exposes whether each lane is live, its label and model name, and the recorded run summary. It never exposes keys, base URLs, or prices.
- Static files are served only from `public/`, and path traversal is rejected. The server listens on `127.0.0.1`.
- `scripts/verify-server.mjs` starts the app with the real `.env`. It checks that no page, API response, or replay stream contains the TypeSafe key or its last 24 characters. It also tries `/..%2f.env`. The detector is tested against a planted key first.
- `.env` is ignored by git and excluded from Vercel uploads (`.vercelignore`, `vercel.json` `excludeFiles`). `.env.example` has empty values.
- **Hosted deployments.** The Vercel entry (`export default handler`) builds the app with the owner's keys disabled unless `ALLOW_LIVE_RACE=1`, so a public URL cannot spend them.
- **Visitor keys.** `POST /api/race` accepts `{ side, n, keys }` (body capped at 4 KB). The key must be 10–256 printable characters. It builds a one-off racer against fixed endpoints and models (`api.typesafe.ai` with `jev-latest`; Gemini's OpenAI-compatible endpoint with `gemini-3.8-flash`, thinking off). Any URL in the body is ignored. The key lives only in that request's closure. Provider error messages are scrubbed of it before streaming. Visitor runs are never written to `runs/`. The page sends only the key the lane needs and keeps keys in memory unless the visitor ticks "Remember in this browser" (localStorage).
- `scripts/verify-byok.mjs` runs both lanes against mocked providers. It checks hosts, `Authorization` headers, model and settings, that the owner key is never used, that nothing is recorded, that malformed keys make no provider call, and that a provider error echoing the key is scrubbed. The scrub check was confirmed to fail with scrubbing disabled. `verify-browser.mjs` runs a full visitor-key race in headless Chrome against the same mocks.

## Boundaries

This is a demo of one labelling workload, not a benchmark harness. There is one dataset, one prompt design per lane, and one batch size and concurrency. It does not tune either side's batch size or prompt, and it does not measure human-labelled accuracy. A different batch size, provider region, network, or time of day will change the timings. A different model in the right lane may change the verdict.
