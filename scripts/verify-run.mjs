import { readFileSync, existsSync } from "node:fs";
import { TOPICS } from "../lib/columns.mjs";
const side = process.argv[2];
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const file = new URL(`../runs/${side}.json`, import.meta.url);
if (!existsSync(file)) fail(`no recorded ${side} run at runs/${side}.json`);
const run = JSON.parse(readFileSync(file));
const rows = run.events.filter((e) => e.type === "rows").flatMap((e) => e.rows);
const done = run.events.at(-1);
if (run.events[0].type !== "start" || done.type !== "done") fail("run is not start..done");
const ids = new Set(rows.map((r) => r.id));
if (rows.length !== 1000 || ids.size !== 1000 || Math.max(...ids) !== 999 || Math.min(...ids) !== 0) fail(`rows=${rows.length} unique=${ids.size}`);
for (const r of rows) {
  const unit = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
  if (!unit(r.sentiment) || !unit(r.bug) || !unit(r.churn) || !(r.topic in TOPICS)) fail(`invalid row ${JSON.stringify(r)}`);
}
let prev = -1;
for (const e of run.events) { if (e.t < prev) fail("timestamps not monotonic"); prev = e.t; }
const totals = done.totals;
if (totals.rows !== 1000 || !(totals.requests >= 50) || !(totals.input_tokens > 0) || !(totals.cost > 0)) fail(`bad totals ${JSON.stringify(totals)}`);
if (side === "jev") {
  // Recompute cost independently from tokens at the published $0.042 per million input tokens.
  const expected = (totals.input_tokens * 0.042) / 1e6;
  if (Math.abs(expected - totals.cost) > 1e-9) fail(`cost ${totals.cost} != ${expected}`);
}
if (run.ms !== done.t || run.rows !== 1000) fail("run summary does not match events");
console.log(`model=${run.model} ms=${done.t} requests=${totals.requests} input_tokens=${totals.input_tokens} cost=$${totals.cost.toFixed(6)} recorded_at=${run.recorded_at}`);
console.log(`RUN OK ${side}`);
