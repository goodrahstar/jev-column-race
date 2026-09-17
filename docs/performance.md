# Measurements

The recorded pair labels the same 1,000 reviews. **Jev finished in 4.576 s for $0.0225. Gemini 3.8 Flash finished in 18.781 s for $0.1576.** That is 4.10× faster and 6.99× cheaper, which the page rounds to 4.1× and 7.0×.

Every number here is recomputed from [`runs/jev.json`](../runs/jev.json), [`runs/llm.json`](../runs/llm.json), and [`data/reviews.json`](../data/reviews.json). The exceptions are the earlier run pair, which is not kept, and the earlier re-rank timings from GATES.md.

[Design](design.md) · [Screenshot](verdict.png) · [Questions](../lib/columns.mjs)

## Setup

| | Jev | Gemini 3.8 Flash |
| --- | --- | --- |
| Model | `jev-1.13.0` (requested `jev-latest`) | `gemini-3.8-flash` |
| Endpoint | TypeSafe `/v1/systemone` | Gemini OpenAI-compatible `/chat/completions` |
| Request | 20 reviews, 80 typed questions | 20 reviews, JSON mode, `reasoning_effort: "none"` |
| Batching | 50 requests, concurrency 8 | 50 requests, concurrency 8 |
| Recorded at (finish) | 2026-09-17 10:17:13.819 UTC | 2026-09-17 10:17:28.041 UTC |

Both lanes started in the same browser tick. The finish times are 14.22 s apart, which matches the 14.205 s difference in run time, so the two lanes ran at the same time. Both ran from one machine over the public internet.

## What the clock measures

Each lane's clock is `performance.now()` on the server. It starts inside the race function, immediately before the first batch is dispatched. It stops when the last batch has come back, been parsed and validated, and been emitted as rows.

**Inside the clock:** network round trips to the provider, provider queueing and generation, JSON parsing, validation, JSON retries, and any HTTP backoff.

**Outside the clock:** initial page load, fetching the config and 1,000 reviews into the page, opening the local event stream, and browser rendering. While the race runs, the on-screen timer counts from when the page receives `start`. At the finish, the page shows the server's final `t`.

## Time

| | Jev | Gemini 3.8 Flash |
| --- | ---: | ---: |
| **Total** | **4,576 ms** | **18,781 ms** |
| First batch back | 1,090 ms | 1,940 ms |
| Median request latency | 528 ms | 2,353 ms |
| 90th percentile (nearest rank) | 1,146 ms | 4,401 ms |
| Fastest / slowest request | 307 / 1,516 ms | 1,634 / 8,256 ms |
| Throughput | 219 rows/s | 53 rows/s |
| Rows done when Jev finished | 1,000 | 200 |
| JSON retries | n/a | 0 |

With 8 workers and 50 requests, total time is set by per-request latency and the slowest requests near the end. Seven Gemini requests took more than 4 s, and none of Jev's took more than 1.6 s.

Timings vary run to run. An earlier pair measured **3.4 s vs 18.6 s**. Its files are not kept in `runs/`.

## Tokens and cost

Token counts are the providers' reported usage, summed over all 50 requests.

| | Jev | Gemini 3.8 Flash |
| --- | ---: | ---: |
| Input tokens | 536,872 | 64,489 |
| Input tokens per request | 10,737 | 1,290 |
| Output tokens | 120,422 (not billed) | 29,126 |
| Input price, $ per million | 0.042 | 0.75 |
| Output price, $ per million | free | 3.75 |
| Input cost | $0.022549 | $0.048367 |
| Output cost | $0 | $0.109223 |
| **Total** | **$0.022549** | **$0.157589** |

- **Jev:** 536,872 × $0.042 / 1M = **$0.022549**. Output tokens are free. `verify-run.mjs jev` recomputes this from the token count.
- **Gemini:** 64,489 × $0.75 / 1M + 29,126 × $3.75 / 1M = $0.048367 + $0.109223 = **$0.157589**. The prices are the standard paid tier for Gemini 3.8 Flash, valid through 2026-12-31. Output is counted as `total_tokens − prompt_tokens`, so any thinking tokens are billed as output.

**Jev reads 8.3× more input tokens.** Every question carries its own instructions and criteria, and each batch has 80 questions. Gemini reads one shared prompt per batch. Jev is still 7.0× cheaper, because its input price is 17.9× lower and its output costs nothing. Most of Gemini's bill (69%) is output.

These are list prices applied to reported usage, not invoices.

## Quality

Star ratings are never sent to either model. Spearman rank correlation between each model's sentiment and the star rating, with ties given average ranks:

| | Jev | Gemini 3.8 Flash |
| --- | ---: | ---: |
| Sentiment vs stars, ρ | 0.803 | **0.822** |
| Bug probability ≥ 0.5, 1-star reviews | 56% | 52% |
| Bug probability ≥ 0.5, 5-star reviews | 7% | 5% |
| Reviews flagged as bugs | 355 | 315 |

**Gemini is marginally better on the star correlation.** Both models flag bugs far more often in 1-star reviews than in 5-star ones.

Topic counts:

| Topic | Jev | Gemini |
| --- | ---: | ---: |
| bug | 346 | 309 |
| praise | 335 | 320 |
| usability | 121 | 164 |
| other | 101 | 116 |
| feature_request | 85 | 74 |
| pricing | 12 | 17 |

## Agreement between the models

| Measure | Value |
| --- | ---: |
| Same topic | 84.4% |
| Same bug call (both ≥ 0.5 or both < 0.5) | 92.6% |
| Sentiment rank correlation, Jev vs Gemini | ρ 0.94 |
| Bug probability rank correlation | ρ 0.88 |
| Churn rank correlation | ρ 0.84 |

Agreement is not accuracy. No human labelled topics, bugs, or churn, so these numbers show how often two models agree, not which one is right.

## Re-rank and ties

The re-rank sorts stored answers in the browser. It makes no model call and no network request.

| Distinct values across 1,000 rows | Jev | Gemini |
| --- | ---: | ---: |
| Sentiment | 332 | 5 |
| Bug probability | 95 | 19 |
| Churn | 204 | 4 |
| Default priority (0.5 bug + 0.3 churn + 0.2 negativity) | 673 | 44 |
| Largest group of rows tied on default priority | 11 | 299 |
| Largest group tied on bug probability | 65 | 527 |

Jev's scores come back as continuous values on the level scale, so a ranking rarely has to fall back on the tie-breaker. The tie-breaker is review id.

`scripts/verify-browser.mjs` times six slider moves in headless Chrome at 1600×900. Each time runs from dispatching the input event to a forced layout, and covers the sort, filter, DOM reorder, and layout of both lanes. It excludes the 450 ms row animation.

| Run | Six slider moves |
| --- | --- |
| Check with both lanes recorded (screenshots in this repo) | 109, 36, 36, 43, 47, 47 ms |
| Earlier check ([GATES.md](../GATES.md)) | 126, 75, 73, 28, 25, 28 ms |

The first move is usually the slowest, because it also clears the fill animations from the race. The check fails above 150 ms or on a frame gap over 400 ms during the race.

## Limits

- **One task, one dataset, one run pair.** The network is live, and timings vary. Re-record both lanes in the same session before quoting new numbers.
- **One setting per lane.** Batch size 20 and concurrency 8 were not tuned for either model. Either model might do better with other settings. Thinking was off for Gemini, which is its fastest setting.
- **Stars are a weak proxy for sentiment.** 718 of the 1,000 reviews are 1 or 5 stars, so star ranks tie heavily, and a star rating is not a sentiment label.
- **Agreement is not ground truth.** See above.
- **Prices change.** Costs use list prices on 2026-09-17 and reported token counts.
