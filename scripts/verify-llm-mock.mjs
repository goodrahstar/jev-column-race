// Runs the real server's LLM lane against a local mock OpenAI-compatible endpoint. No paid calls.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.mjs";
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

let calls = 0, badSent = false, sawAuth = true, sawJsonMode = true;
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d)).on("end", () => {
    calls++;
    if (req.headers.authorization !== "Bearer mock-key") sawAuth = false;
    const request = JSON.parse(body);
    if (request.response_format?.type !== "json_object" || request.model !== "mock/model-1") sawJsonMode = false;
    const batch = JSON.parse(request.messages[1].content);
    let content;
    if (!badSent && batch[0].id === 40) {
      badSent = true;
      content = "Sure! Here are the labels: {not json"; // first attempt for this batch is invalid
    } else {
      content = JSON.stringify({ results: batch.map((r) => ({ id: r.id, sentiment: r.id % 5, topic: "bug", bug: 0.75, churn: r.id % 4 })) });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "mock/model-1", choices: [{ message: { content } }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1700 } }));
  });
}).listen(0, "127.0.0.1");
await new Promise((r) => mock.once("listening", r));

const runsDir = mkdtempSync(join(tmpdir(), "column-race-"));
const app = createApp({
  runsDir,
  env: {
    LLM_API_KEY: "mock-key",
    LLM_MODEL: "mock/model-1",
    LLM_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`,
    LLM_PRICE_INPUT: "1",
    LLM_PRICE_OUTPUT: "5",
    BATCH_SIZE: "20",
    CONCURRENCY: "4",
  },
}).listen(0, "127.0.0.1");
await new Promise((r) => app.once("listening", r));
try {
  const text = await (await fetch(`http://127.0.0.1:${app.address().port}/api/race?side=llm&mode=live&n=100`)).text();
  const events = text.split("\n\n").filter(Boolean).map((l) => JSON.parse(l.slice(6)));
  const errors = events.filter((e) => e.type === "error");
  if (errors.length) fail(`error events: ${JSON.stringify(errors)}`);
  const done = events.at(-1);
  if (done.type !== "done") fail("no done event");
  const rows = events.filter((e) => e.type === "rows").flatMap((e) => e.rows);
  if (rows.length !== 100 || new Set(rows.map((r) => r.id)).size !== 100) fail(`rows ${rows.length}`);
  const r41 = rows.find((r) => r.id === 41);
  if (r41.sentiment !== 1 / 4 || r41.churn !== 1 / 3 || r41.topic !== "bug" || r41.bug !== 0.75) fail(`normalisation ${JSON.stringify(r41)}`);
  const t = done.totals;
  // 5 batches + 1 retry = 6 calls, each 1000 in / 700 out (500 visible + 200 thinking) at $1 / $5 per million.
  if (calls !== 6 || t.requests !== 6 || t.retries !== 1) fail(`calls=${calls} requests=${t.requests} retries=${t.retries}`);
  if (t.output_tokens !== 6 * 700) fail(`thinking tokens not billed: output_tokens=${t.output_tokens}`);
  const expected = 6 * (1000 * 1 + 700 * 5) / 1e6;
  if (Math.abs(t.cost - expected) > 1e-12) fail(`cost ${t.cost} != ${expected}`);
  if (!sawAuth || !sawJsonMode) fail("request shape wrong");
  const recorded = join(runsDir, "llm.json");
  if (!existsSync(recorded) || JSON.parse(readFileSync(recorded)).rows !== 100) fail("run not recorded");
  // Negative control: an unconfigured LLM lane must report an error instead of racing.
  const bare = createApp({ runsDir, env: {} }).listen(0, "127.0.0.1");
  await new Promise((r) => bare.once("listening", r));
  const bareText = await (await fetch(`http://127.0.0.1:${bare.address().port}/api/race?side=llm&mode=live&n=10`)).text();
  bare.close();
  if (!bareText.includes('"type":"error"')) fail("unconfigured lane did not error");
  console.log(`calls=${calls} retries=${t.retries} cost=$${t.cost.toFixed(6)} rows=${rows.length}`);
  console.log("LLM MOCK OK");
} finally {
  app.close();
  mock.close();
}
