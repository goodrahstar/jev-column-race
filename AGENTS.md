# Jev Column Race

Read README.md before editing. Keep the race small: reviews -> batches -> two lanes -> validated rows -> page.

- Both lanes must do the same work: same reviews, batch size, concurrency, clock, and column definitions. Change `lib/columns.mjs` for both sides, never one.
- Never send star ratings to a model. They are the independent check on sentiment.
- Validate every answer. Count every LLM retry in requests, tokens, and cost.
- Keep API keys server-side. The browser gets rows, totals, and model names only. Never put a key in `runs/`, `public/`, logs, or docs.
- Never commit `.env`. Only `.env.example`, with empty values, is tracked.
- Tests and checks make no paid API calls. Use recorded runs and the local mock. Never start a live race from a check.
- Replays are never sped up. Re-emit recorded events on their original timestamps and label them "replay · 1×".
- Keep README.md and docs/ numbers consistent with `runs/jev.json` and `runs/llm.json`. If you re-record, re-record both lanes in the same session and update every number.
- Keep zero npm dependencies and Node 20 compatibility.
- Do not commit or push unless the user asks.

Checks: npm run check (node scripts/verify-*.mjs; verify-browser needs Chrome, verify-server needs TYPESAFE_API_KEY in .env as a leak-test control).
