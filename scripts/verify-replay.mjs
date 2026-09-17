// Replay must re-emit events on their recorded timestamps (1x), not faster.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.mjs";
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const runsDir = mkdtempSync(join(tmpdir(), "column-race-replay-"));
const events = [
  { type: "start", t: 0, total: 2 },
  { type: "rows", t: 400, rows: [{ id: 0, sentiment: 1, topic: "praise", bug: 0, churn: 0 }], totals: { rows: 1, cost: 0.1, requests: 1 } },
  { type: "rows", t: 900, rows: [{ id: 1, sentiment: 0, topic: "bug", bug: 1, churn: 1 }], totals: { rows: 2, cost: 0.2, requests: 2 } },
  { type: "done", t: 1300, totals: { rows: 2, cost: 0.2, requests: 2 } },
];
writeFileSync(join(runsDir, "jev.json"), JSON.stringify({ side: "jev", model: "jev-test", recorded_at: "2026-09-17T00:00:00Z", rows: 2, ms: 1300, cost: 0.2, events }));
const app = createApp({ runsDir, env: {} }).listen(0, "127.0.0.1");
await new Promise((r) => app.once("listening", r));
try {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/race?side=jev&mode=replay`);
  const decoder = new TextDecoder();
  const arrivals = [];
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      arrivals.push({ event: JSON.parse(buffer.slice(6, index)), at: performance.now() - started });
      buffer = buffer.slice(index + 2);
    }
  }
  if (arrivals.length !== 4) fail(`got ${arrivals.length} events`);
  if (!arrivals[0].event.replay || arrivals[0].event.model !== "jev-test") fail("start event not tagged as replay");
  const firstAt = arrivals[0].at;
  for (const { event, at } of arrivals) {
    const offset = at - firstAt;
    if (offset < event.t - 25 || offset > event.t + 200) fail(`event t=${event.t} arrived at ${offset.toFixed(0)}ms`);
  }
  console.log(arrivals.map(({ event, at }) => `${event.type}@${event.t}->${(at - firstAt).toFixed(0)}ms`).join(" "));
  console.log("REPLAY OK");
} finally {
  app.close();
}
