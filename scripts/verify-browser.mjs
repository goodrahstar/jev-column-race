// Drives a real headless Chrome through a replayed race: checks rendering, frame smoothness, finish card,
// and re-rank speed, and saves screenshots to shots/. Needs runs/jev.json recorded.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../server.mjs";
import { mockProviders } from "./mock-providers.mjs";

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Serve the real app (recorded runs only, no keys) on a free port so this check is self-contained.
const app = createApp({ env: {} }).listen(0, "127.0.0.1");
await new Promise((r) => app.once("listening", r));
const PAGE = `http://127.0.0.1:${app.address().port}/?mode=replay`;
const fail = (m) => { console.error("FAIL:", m); cleanup(); process.exit(1); };
const profile = mkdtempSync(join(tmpdir(), "column-race-chrome-"));
const shots = new URL("../shots/", import.meta.url).pathname;
mkdirSync(shots, { recursive: true });

const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1600,900", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
function cleanup() { chrome.kill(); app.close(); try { rmSync(profile, { recursive: true, force: true }); } catch {} }

const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error("Chrome did not start")), 15000);
});
const port = new URL(wsUrl).port;
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => { const msg = JSON.parse(e.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name) => {
  await evaluate("(window.__shots ||= []).push([performance.now(), Infinity])");
  await captureTo(name);
  await evaluate("window.__shots.at(-1)[1] = performance.now()");
};
const captureTo = async (name) => writeFileSync(join(shots, (process.env.VIEWPORT ? process.env.VIEWPORT + "-" : "") + name), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));

try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  const [vw, vh] = (process.env.VIEWPORT || "1600x900").split("x").map(Number);
  await cdp("Emulation.setDeviceMetricsOverride", { width: vw, height: vh, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: PAGE });
  await evaluate(`new Promise(r => { const iv = setInterval(() => { if (document.querySelector('#lane-jev tbody tr')) { clearInterval(iv); r(); } }, 50); })`);
  const visibility = await evaluate("document.visibilityState");
  if (visibility !== "visible") fail(`page is ${visibility}`);

  // Measure frame gaps during the race: a smooth recording needs no multi-second freezes.
  await evaluate(`window.__frames = []; (() => { let last = performance.now(); const f = (t) => { window.__frames.push([t, t - last]); last = t; if (!window.__stopFrames) requestAnimationFrame(f); }; requestAnimationFrame(f); })(); document.querySelector('#start').click(); 'ok'`);
  await new Promise((r) => setTimeout(r, 1500));
  const mid = await evaluate(`({ pct: document.querySelector('#lane-jev .pct').textContent, time: document.querySelector('#lane-jev .time').textContent, lit: document.querySelectorAll('#lane-jev .heat i[style]').length })`);
  await shot("1-mid-race.png");
  await evaluate(`new Promise(r => { const iv = setInterval(() => { if (!document.querySelector('#lane-jev .finish').hidden) { clearInterval(iv); r(); } }, 50); })`);
  await new Promise((r) => setTimeout(r, 700));
  await shot("2-finish.png");
  const finish = await evaluate(`({ text: document.querySelector('#lane-jev .finish').innerText, filled: document.querySelectorAll('#lane-jev .bugpct').length })`);
  // When a comparison run is recorded, wait for it too and check the verdict banner.
  const hasLlm = await evaluate(`!document.querySelector('#lane-llm .table-wrap').hidden`);
  let verdict = null;
  if (hasLlm) {
    await evaluate(`new Promise((r, j) => { const t0 = Date.now(); const iv = setInterval(() => { if (!document.querySelector('#verdict').hidden) { clearInterval(iv); r(); } else if (Date.now() - t0 > 120000) { clearInterval(iv); j(new Error('verdict never shown')); } }, 100); })`);
    await new Promise((r) => setTimeout(r, 900));
    await shot("4-verdict.png");
    verdict = await evaluate(`({ text: document.querySelector('#verdict').innerText, llmFilled: document.querySelectorAll('#lane-llm .bugpct').length, llmFinish: document.querySelector('#lane-llm .finish').innerText })`);
  }
  Object.assign(finish, await evaluate(`(() => { const inShot = (end, gap) => (window.__shots || []).some(([a, b]) => end - gap < b + 50 && end > a); const real = window.__frames.slice(2).filter(([end, gap]) => !inShot(end, gap)); return { maxGap: Math.max(...real.map(([, g]) => g)), frames: window.__frames.length, excludedForScreenshots: window.__frames.length - 2 - real.length }; })()`));
  await evaluate("window.__stopFrames = true");

  // Re-rank: move sliders and time each full update (sort + filter + DOM reorder + layout).
  const rerank = await evaluate(`(async () => {
    document.querySelectorAll('.finish').forEach((f) => (f.hidden = true));
    const times = [];
    const set = async (sel, v) => { const el = document.querySelector(sel); el.value = v; const t = performance.now(); el.dispatchEvent(new Event('input')); document.body.offsetHeight; times.push(performance.now() - t); await new Promise(r => setTimeout(r, 120)); };
    await set('#wBug', 100); await set('#wChurn', 0); await set('#wNeg', 0);
    const topBugs = [...document.querySelectorAll('#lane-jev tbody tr:not(.hidden-row)')].slice(0, 10).map(tr => parseInt(tr.children[5].textContent));
    await set('#minBug', 80);
    const shown = document.querySelectorAll('#lane-jev tbody tr:not(.hidden-row)').length;
    const minShownBug = Math.min(...[...document.querySelectorAll('#lane-jev tbody tr:not(.hidden-row)')].map(tr => parseInt(tr.children[5].textContent)));
    await set('#wBug', 20); await set('#wChurn', 100);
    return { times, topBugs, shown, minShownBug, stat: document.querySelector('#rerankStat').textContent };
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  await shot("3-rerank.png");

  // Bring-your-own-key panel: this server has no keys, so live mode must ask the visitor for theirs.
  await cdp("Page.navigate", { url: PAGE.replace("mode=replay", "mode=live") });
  await evaluate(`new Promise(r => { const iv = setInterval(() => { if (document.querySelector('#lane-jev .offline')) { clearInterval(iv); r(); } }, 50); })`);
  const byok = await evaluate(`(async () => {
    const before = { panel: !document.querySelector('#keys').hidden, start: document.querySelector('#start').disabled,
      jevMsg: document.querySelector('#lane-jev .offline').innerText, llmMsg: document.querySelector('#lane-llm .offline').innerText,
      llmName: document.querySelector('#lane-llm .name').textContent };
    const input = document.querySelector('#keyTypesafe');
    input.value = 'apikey_browser_check_not_a_real_key';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 300));
    return { before, after: { start: document.querySelector('#start').disabled, jevTable: !document.querySelector('#lane-jev .table-wrap').hidden,
      jevRows: document.querySelectorAll('#lane-jev tbody tr').length, llmStillLocked: !document.querySelector('#lane-llm .offline').hidden,
      keyInUrl: location.href.includes('apikey_browser') } };
  })()`);
  await captureTo("5-byok.png");

  // Full visitor-key race in the browser against mocked providers: POST streaming, both lanes, verdict.
  const mocks = mockProviders({ delayMs: 40 });
  const mockApp = createApp({ env: {}, live: false, byok: true, fetchImpl: mocks.fetchImpl, runsDir: profile }).listen(0, "127.0.0.1");
  await new Promise((r) => mockApp.once("listening", r));
  await cdp("Page.navigate", { url: `http://127.0.0.1:${mockApp.address().port}/?mode=live&rows=100` });
  await evaluate(`new Promise(r => { const iv = setInterval(() => { if (document.querySelector('#lane-jev .offline')) { clearInterval(iv); r(); } }, 50); })`);
  const byokRace = await evaluate(`(async () => {
    for (const [sel, key] of [['#keyTypesafe', 'apikey_browser_mock_typesafe_key'], ['#keyGemini', 'AIzaBrowserMockGeminiKey0123456']]) {
      const el = document.querySelector(sel); el.value = key; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change'));
    }
    document.querySelector('#start').click();
    await new Promise((r, j) => { const t0 = Date.now(); const iv = setInterval(() => { if (!document.querySelector('#verdict').hidden) { clearInterval(iv); r(); } else if (Date.now() - t0 > 30000) { clearInterval(iv); j(new Error('byok race never finished: ' + document.querySelector('#lane-jev .pct').textContent + ' / ' + document.querySelector('#lane-llm .pct').textContent + ' ' + document.querySelector('#lane-llm .finish').innerText)); } }, 100); });
    return { jev: document.querySelector('#lane-jev .pct').textContent, llm: document.querySelector('#lane-llm .pct').textContent,
      verdict: document.querySelector('#verdict').innerText.split(String.fromCharCode(10)).slice(0, 2).join(' '), keyInUrl: location.href.includes('Mock') };
  })()`);
  mockApp.close();
  const mockHosts = [...new Set(mocks.calls.map((c) => new URL(c.url).host))].sort().join();

  console.log(JSON.stringify({ mid, finish, verdict, byok, byokRace, mockHosts, rerank: { ...rerank, times: rerank.times.map((t) => Math.round(t)) } }));
  const b = byok.before, a = byok.after;
  if (!b.panel || !b.start || !/Paste your TypeSafe API key/.test(b.jevMsg) || !/Paste your Gemini API key/.test(b.llmMsg) || b.llmName !== "Gemini 3.8 Flash") fail(`byok panel before key: ${JSON.stringify(b)}`);
  if (byokRace.jev !== "100 / 100" || byokRace.llm !== "100 / 100" || !/faster/.test(byokRace.verdict) || byokRace.keyInUrl) fail(`byok browser race: ${JSON.stringify(byokRace)}`);
  if (mockHosts !== "api.typesafe.ai,generativelanguage.googleapis.com" || mocks.calls.some((c) => !c.auth.includes("BrowserMock") && !c.auth.includes("browser_mock"))) fail(`byok browser race used wrong hosts or keys: ${mockHosts}`);
  if (a.start || !a.jevTable || a.jevRows !== 1000 || !a.llmStillLocked || a.keyInUrl) fail(`byok panel after key: ${JSON.stringify(a)}`);
  if (hasLlm && (!/faster/.test(verdict.text) || !/cheaper/.test(verdict.text) || verdict.llmFilled !== 1000 || !/FINISHED/.test(verdict.llmFinish))) fail(`verdict: ${JSON.stringify(verdict)}`);
  const midRows = parseInt(mid.pct.replace(/,/g, ""));
  if (!(midRows > 0 && midRows < 1000)) fail(`mid-race screenshot not mid-race: ${mid.pct}`);
  if (!/FINISHED/.test(finish.text) || !/1,000 rows/.test(finish.text)) fail(`finish card: ${finish.text}`);
  if (finish.filled !== 1000) fail(`filled rows ${finish.filled}`);
  if (finish.maxGap > 400) fail(`frame freeze of ${Math.round(finish.maxGap)} ms during the race`);
  if (rerank.topBugs.some((b, i) => i > 0 && b > rerank.topBugs[i - 1] + 1)) fail(`bug-only ranking not descending: ${rerank.topBugs}`);
  if (rerank.minShownBug < 79 || rerank.shown >= 1000 || rerank.shown < 1) fail(`bug filter: shown=${rerank.shown} min=${rerank.minShownBug}`);
  // The first move also clears the race's 2,000 flash animations once; every later move is a pure re-rank.
  if (rerank.times[0] > 300 || Math.max(...rerank.times.slice(1)) > 150) fail(`re-rank too slow: ${rerank.times.map(Math.round)}`);
  console.log("BROWSER OK");
} catch (error) {
  fail(error.message);
}
ws.close();
cleanup();
