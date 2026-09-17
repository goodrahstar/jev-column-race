// Bring-your-own-key races, against mocked TypeSafe and Gemini. No real keys, no paid calls.
// Checks: fixed endpoints only, the visitor's key is used and never echoed or recorded, owner keys stay unused.
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.mjs";
import { mockProviders } from "./mock-providers.mjs";
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

const VISITOR_TS = "apikey_visitor_typesafe_0123456789abcdef";
const VISITOR_GEMINI = "AIzaVisitorGeminiKey0123456789abcdefg";
const OWNER_TS = "apikey_owner_must_never_be_used_987654321";
const { fetchImpl: mockFetch, calls, state } = mockProviders();

const runsDir = mkdtempSync(join(tmpdir(), "column-race-byok-"));
// Deployment shape: owner keys present in env, but live disabled, so only visitor keys may be used.
const app = createApp({ runsDir, fetchImpl: mockFetch, live: false, byok: true, env: { TYPESAFE_API_KEY: OWNER_TS, LLM_API_KEY: "owner-llm", LLM_MODEL: "x" } }).listen(0, "127.0.0.1");
await new Promise((r) => app.once("listening", r));
const base = `http://127.0.0.1:${app.address().port}`;
const post = async (body, raw) => {
  const res = await fetch(`${base}/api/race`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ?? JSON.stringify(body) });
  const text = await res.text();
  const events = res.headers.get("content-type")?.includes("event-stream") ? text.split("\n\n").filter(Boolean).map((l) => JSON.parse(l.slice(6))) : null;
  return { status: res.status, text, events };
};
const noKeys = (text) => ![VISITOR_TS, VISITOR_GEMINI, OWNER_TS, VISITOR_TS.slice(-12), VISITOR_GEMINI.slice(-12)].some((k) => text.includes(k));

try {
  const config = await (await fetch(`${base}/api/config`)).json();
  if (!config.byok || config.byok.llm_model !== "gemini-3.8-flash" || config.jev.live || config.llm.live) fail(`config ${JSON.stringify(config)}`);

  // Jev lane with the visitor's key; a smuggled URL must be ignored.
  const jev = await post({ side: "jev", n: 60, keys: { typesafe: VISITOR_TS }, baseUrl: "http://evil.example" });
  if (jev.events.at(-1).type !== "done" || jev.events.at(-1).totals.rows !== 60) fail(`jev run ${jev.text.slice(0, 300)}`);
  // Gemini lane with the visitor's key.
  const llm = await post({ side: "llm", n: 40, keys: { gemini: VISITOR_GEMINI, typesafe: VISITOR_TS } });
  if (llm.events.at(-1).type !== "done" || llm.events.at(-1).totals.rows !== 40) fail(`llm run ${llm.text.slice(0, 300)}`);
  if (!noKeys(jev.text) || !noKeys(llm.text)) fail("a key was sent back in a stream");

  const hosts = new Set(calls.map((c) => new URL(c.url).host));
  if ([...hosts].sort().join() !== "api.typesafe.ai,generativelanguage.googleapis.com") fail(`unexpected hosts ${[...hosts]}`);
  if (calls.some((c) => c.url.includes("typesafe") && c.auth !== `Bearer ${VISITOR_TS}`)) fail("Jev call did not use the visitor's TypeSafe key");
  if (calls.some((c) => c.url.includes("google") && (c.auth !== `Bearer ${VISITOR_GEMINI}` || c.model !== "gemini-3.8-flash" || c.extra !== "none"))) fail("Gemini call used the wrong key, model or settings");
  if (calls.some((c) => c.auth.includes(OWNER_TS) || c.auth.includes("owner-llm"))) fail("owner key was used");
  if (readdirSync(runsDir).length) fail("visitor run was recorded");

  // Missing or malformed keys: error event, no provider call.
  const before = calls.length;
  for (const keys of [{}, { typesafe: "short" }, { typesafe: "has space in the key 123" }]) {
    const r = await post({ side: "jev", n: 20, keys });
    if (r.events?.[0]?.type !== "error" || !/TypeSafe API key/.test(r.events[0].message)) fail(`bad key accepted: ${JSON.stringify(keys)} -> ${r.text}`);
  }
  if (calls.length !== before) fail("provider called without a valid key");

  // Provider error that echoes the key: it must be scrubbed.
  state.echoKey = true;
  const echoed = await post({ side: "llm", n: 20, keys: { gemini: VISITOR_GEMINI } });
  state.echoKey = false;
  const err = echoed.events.find((e) => e.type === "error");
  if (!err || !noKeys(echoed.text) || !/\[your key\]/.test(err.message)) fail(`provider error not scrubbed: ${echoed.text.slice(0, 300)}`);

  // Oversized and invalid bodies.
  if ((await post(null, JSON.stringify({ side: "jev", pad: "x".repeat(5000) }))).status !== 413) fail("oversized body not rejected");
  if ((await post(null, "{not json")).status !== 400) fail("invalid JSON not rejected");
  // Owner-key live race over GET stays disabled.
  const get = await (await fetch(`${base}/api/race?side=jev&mode=live&n=10`)).text();
  if (!/disabled on this deployment/.test(get)) fail(`GET live not disabled: ${get}`);

  // BYOK switched off: POST refused.
  const off = createApp({ runsDir, fetchImpl: mockFetch, live: false, byok: false, env: {} }).listen(0, "127.0.0.1");
  await new Promise((r) => off.once("listening", r));
  const refused = await fetch(`http://127.0.0.1:${off.address().port}/api/race`, { method: "POST", body: JSON.stringify({ side: "jev", keys: { typesafe: VISITOR_TS } }) });
  off.close();
  if (refused.status !== 403) fail(`byok:false returned ${refused.status}`);

  console.log(`provider_calls=${calls.length} hosts=${[...hosts].join(",")} recorded_files=${readdirSync(runsDir).length}`);
  console.log("BYOK OK");
} finally {
  app.close();
}
