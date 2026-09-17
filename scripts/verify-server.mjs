// Starts the real app with the real .env and checks that no response body contains the API key.
import { readFileSync } from "node:fs";
import { createApp, loadEnv } from "../server.mjs";
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
loadEnv();
const key = process.env.TYPESAFE_API_KEY;
if (!key || key.length < 20) fail("TYPESAFE_API_KEY missing from .env (positive control)");
if (!readFileSync(new URL("../.env", import.meta.url), "utf8").includes(key)) fail("key not read from .env");
const leaks = (body) => body.includes(key) || body.includes(key.slice(-24));
if (!leaks(`x${key}x`)) fail("leak detector does not detect a planted key (positive control)");
const server = createApp().listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const checks = [["/", "Start race"], ["/app.js", "EventSource"], ["/style.css", "--jev"], ["/api/config", '"reviews":1000'], ["/api/reviews", "source_row"]];
  for (const [path, marker] of checks) {
    const res = await fetch(base + path);
    const body = await res.text();
    if (!res.ok) fail(`${path} -> HTTP ${res.status}`);
    if (!body.includes(marker)) fail(`${path} missing ${marker}`);
    if (leaks(body)) fail(`${path} leaks the API key`);
  }
  const reviews = await (await fetch(base + "/api/reviews")).json();
  if (reviews.length !== 1000) fail(`reviews endpoint returned ${reviews.length}`);
  const replay = await (await fetch(base + "/api/race?side=jev&mode=replay&n=1000")).text();
  if (leaks(replay)) fail("replay stream leaks the API key");
  const traversal = await fetch(base + "/..%2f.env");
  if (leaks(await traversal.text())) fail(".env reachable over HTTP");
  console.log("SERVER OK");
} finally {
  server.close();
}
