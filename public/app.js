const $ = (selector, root = document) => root.querySelector(selector);
const SIDES = ["jev", "llm"];
const TABLE_LIMIT = 100;
const TOPIC_LABELS = { bug: "Bug", pricing: "Pricing", usability: "Usability", feature_request: "Feature req", praise: "Praise", other: "Other" };

let config;
let reviews = [];
const lanes = {};

const fmtInt = (n) => n.toLocaleString("en-US");
const fmtTime = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}s`);
const fmtCost = (c) => (c < 0.01 ? `$${c.toFixed(4)}` : c < 1 ? `$${c.toFixed(3)}` : `$${c.toFixed(2)}`);
const fmtRatio = (x) => (x >= 10 ? `${Math.round(x)}×` : `${x.toFixed(1)}×`);

function sentimentColor(v) {
  // red -> amber -> green
  const stops = [[255, 77, 94], [255, 197, 61], [61, 220, 132]];
  const [a, b, t] = v < 0.5 ? [stops[0], stops[1], v / 0.5] : [stops[1], stops[2], (v - 0.5) / 0.5];
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(",")})`;
}

function spearman(xs, ys) {
  const rank = (values) => {
    const order = values.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const ranks = new Array(values.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) ranks[order[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

const KEY_STORE = "columnRaceKeys";

function visitorKeys() {
  return { typesafe: $("#keyTypesafe").value.trim(), gemini: $("#keyGemini").value.trim() };
}

// A lane runs on the visitor's key when the server has no key of its own for it.
function usesVisitorKey(side) {
  return $("#mode").value === "live" && !config[side].live && Boolean(config.byok);
}

function hasVisitorKey(side) {
  const key = visitorKeys()[side === "jev" ? "typesafe" : "gemini"];
  return key.length >= 10;
}

function laneAvailable(side) {
  const mode = $("#mode").value;
  if (mode === "replay") return Boolean(config[side].recorded);
  return config[side].live || (usesVisitorKey(side) && hasVisitorKey(side));
}

function laneLabel(side) {
  return usesVisitorKey(side) && side === "llm" ? config.byok.llm : config[side].label;
}

function rememberKeys() {
  try {
    if ($("#rememberKeys").checked) localStorage.setItem(KEY_STORE, JSON.stringify(visitorKeys()));
    else localStorage.removeItem(KEY_STORE);
  } catch {
    // Storage can be blocked (private windows); keys then live only in this page.
  }
}

function restoreKeys() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY_STORE) || "null");
    if (!saved) return false;
    $("#keyTypesafe").value = saved.typesafe || "";
    $("#keyGemini").value = saved.gemini || "";
    $("#rememberKeys").checked = true;
    return Boolean(saved.typesafe || saved.gemini);
  } catch {
    return false;
  }
}

function updateKeyPanel() {
  const needsKeys = $("#mode").value === "live" && Boolean(config.byok) && SIDES.some((s) => !config[s].live);
  $("#keys").hidden = !needsKeys;
  $("#start").disabled = !SIDES.some(laneAvailable) || SIDES.some((s) => lanes[s]?.running);
}

function buildLane(side, n) {
  const section = $(`#lane-${side}`);
  section.replaceChildren($("#lane-template").content.cloneNode(true));
  section.classList.remove("running");
  const info = config[side];
  const mode = $("#mode").value;
  $(".name", section).textContent = mode === "replay" ? info.label : laneLabel(side);
  $(".model", section).textContent =
    (mode === "replay" ? info.recorded?.model : usesVisitorKey(side) ? (side === "llm" ? config.byok.llm_model : "jev-latest") : info.model) || "";
  $(".replay-tag", section).hidden = mode !== "replay";
  const lane = (lanes[side] = { side, section, n, results: new Map(), rowEls: [], heatEls: [], frontier: 0, running: false, done: false });
  $(".pct", section).textContent = `0 / ${fmtInt(n)}`;

  if (!laneAvailable(side)) {
    $(".heat", section).hidden = true;
    $(".table-wrap", section).hidden = true;
    const offline = $(".offline", section);
    offline.hidden = false;
    // One wrapper element: .offline is a centring grid, so bare text and <b> would each become a row.
    offline.innerHTML = "<div></div>";
    offline.firstChild.innerHTML =
      mode === "replay"
        ? `No recorded ${info.label} run yet.<br>Run a live race once, then replay it.`
        : usesVisitorKey(side)
          ? `Paste your ${side === "jev" ? "TypeSafe" : "Gemini"} API key above to race this lane live.<br>Or choose <b>Replay recorded run</b> to watch the measured race.`
          : config.live_enabled === false
          ? `Live API calls are disabled on this deployment.<br>Choose <b>Replay recorded run</b>.`
          : side === "llm"
            ? `Comparison model not configured.<br>Add <code>LLM_API_KEY</code> and <code>LLM_MODEL</code> to <code>.env</code><br>(any OpenAI-compatible endpoint) and restart.`
            : `Add <code>TYPESAFE_API_KEY</code> to <code>.env</code> and restart.`;
    lane.unavailable = true;
    return;
  }

  const heat = $(".heat", section);
  heat.style.setProperty("--cols", n >= 500 ? 100 : 50);
  const tbody = $("tbody", section);
  const heatFrag = document.createDocumentFragment();
  const rowFrag = document.createDocumentFragment();
  for (const review of reviews.slice(0, n)) {
    const cell = document.createElement("i");
    cell.title = `#${review.id + 1}`;
    lane.heatEls.push(cell);
    heatFrag.append(cell);
    const tr = document.createElement("tr");
    tr.dataset.id = review.id;
    tr.innerHTML =
      `<td class="num">${review.id + 1}</td><td class="stars">${review.stars}</td><td class="text"></td>` +
      `<td class="cell"><span class="pending"></span></td><td class="cell"><span class="pending"></span></td>` +
      `<td class="cell"><span class="pending"></span></td><td class="cell"><span class="pending"></span></td>`;
    tr.children[2].textContent = review.text;
    tr.children[2].title = review.text;
    lane.rowEls.push(tr);
    rowFrag.append(tr);
  }
  heat.append(heatFrag);
  tbody.append(rowFrag);
}

function fillRow(lane, result) {
  const tr = lane.rowEls[result.id];
  if (!tr) return;
  const [, , , sentiment, topic, bug, churn] = tr.children;
  sentiment.innerHTML = `<div class="meter"><b style="width:${Math.max(6, result.sentiment * 100)}%;background:${sentimentColor(result.sentiment)}"></b></div>`;
  topic.innerHTML = `<span class="chip ${result.topic}">${TOPIC_LABELS[result.topic]}</span>`;
  const pct = Math.round(result.bug * 100);
  bug.innerHTML = `<span class="bugpct" style="color:${result.bug >= 0.5 ? "var(--bad)" : "var(--muted)"}">${pct}%</span>`;
  churn.innerHTML = `<div class="meter"><b style="width:${Math.max(6, result.churn * 100)}%;background:var(--churn);opacity:${0.35 + result.churn * 0.65}"></b></div>`;
  // Each row fills once per race, so adding the class is enough to play the flash (no forced reflow).
  tr.classList.add("filled");
  const cell = lane.heatEls[result.id];
  cell.style.backgroundColor = sentimentColor(result.sentiment);
  cell.classList.add("lit");
}

function updateStats(lane, totals, elapsed) {
  const s = lane.section;
  $(".cost", s).textContent = fmtCost(totals.cost);
  $(".reqs", s).textContent = fmtInt(totals.requests);
  $(".rate", s).textContent = elapsed > 0 ? fmtInt(Math.round(totals.rows / (elapsed / 1000))) : "0";
  $(".bar", s).style.width = `${(totals.rows / lane.n) * 100}%`;
  $(".pct", s).textContent = `${fmtInt(totals.rows)} / ${fmtInt(lane.n)}`;
}

function followFrontier(lane) {
  // Scroll with the first still-empty row, so the table fills top to bottom on screen.
  while (lane.frontier < lane.n && lane.results.has(lane.frontier)) lane.frontier++;
  const now = performance.now();
  if (now - (lane.lastScroll || 0) < 220) return;
  lane.lastScroll = now;
  const wrap = $(".table-wrap", lane.section);
  const target = lane.rowEls[Math.min(lane.frontier, lane.n - 1)];
  const top = target.offsetTop - wrap.clientHeight * 0.7;
  if (top > wrap.scrollTop + 4) wrap.scrollTo({ top, behavior: "smooth" });
}

function qualityVsStars(lane) {
  const ids = [...lane.results.keys()];
  return spearman(ids.map((id) => lane.results.get(id).sentiment), ids.map((id) => reviews[id].stars));
}

function showFinish(lane, ms, totals, errorMessage) {
  const box = $(".finish", lane.section);
  box.hidden = false;
  if (errorMessage) {
    box.innerHTML = `<div class="flag">STOPPED</div><div class="fqual"></div>`;
    $(".fqual", box).textContent = errorMessage;
    return;
  }
  const rho = qualityVsStars(lane);
  box.innerHTML =
    `<div class="flag">FINISHED</div><div class="ftime">${fmtTime(ms)}</div>` +
    `<div class="fcost">${fmtInt(totals.rows)} rows · ${fmtCost(totals.cost)}</div>` +
    `<div class="fqual">sentiment vs. star rating ρ = ${rho.toFixed(2)}</div>`;
  box.addEventListener("click", () => (box.hidden = true), { once: true });
}

function startLane(side) {
  const lane = lanes[side];
  if (lane.unavailable) return;
  const mode = $("#mode").value;
  if (usesVisitorKey(side)) return streamWithVisitorKey(lane);
  const source = new EventSource(`/api/race?side=${side}&mode=${mode}&n=${lane.n}`);
  lane.source = source;
  source.onmessage = (message) => handleEvent(lane, JSON.parse(message.data));
  // EventSource reconnects by default; a reconnect would start a second race, so close instead.
  source.onerror = () => lane.running && stopLane(lane, "Connection closed before the run finished.");
}

// Visitor keys travel in a POST body, never in a URL, so they stay out of history and access logs.
async function streamWithVisitorKey(lane) {
  const controller = new AbortController();
  lane.source = { close: () => controller.abort() };
  const keys = visitorKeys();
  const body = { side: lane.side, n: lane.n, keys: lane.side === "jev" ? { typesafe: keys.typesafe } : { gemini: keys.gemini } };
  try {
    const response = await fetch("/api/race", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return stopLane(lane, error.error || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (chunk.startsWith("data: ")) handleEvent(lane, JSON.parse(chunk.slice(6)));
      }
    }
    if (!lane.done && !lane.failed) stopLane(lane, "Connection closed before the run finished.");
  } catch (error) {
    if (!controller.signal.aborted) stopLane(lane, error.message);
  }
}

function handleEvent(lane, event) {
  const source = lane.source;
  {
    if (event.type === "start") {
      lane.clientStart = performance.now();
      lane.running = true;
      lane.section.classList.add("running");
      if (event.model) $(".model", lane.section).textContent = event.model;
    } else if (event.type === "rows") {
      for (const row of event.rows) {
        lane.results.set(row.id, row);
        fillRow(lane, row);
      }
      lane.totals = event.totals;
      updateStats(lane, event.totals, performance.now() - lane.clientStart);
      lane.needsScroll = true;
    } else if (event.type === "done") {
      source.close();
      lane.running = false;
      lane.done = true;
      lane.ms = event.t;
      lane.totals = event.totals;
      lane.section.classList.remove("running");
      $(".time", lane.section).textContent = fmtTime(event.t);
      updateStats(lane, event.totals, event.t);
      showFinish(lane, event.t, event.totals);
      onLaneDone();
    } else if (event.type === "error") {
      stopLane(lane, event.message);
    }
  }
}

function stopLane(lane, message) {
  if (lane.failed || lane.done) return;
  lane.source?.close();
  lane.running = false;
  lane.failed = true;
  lane.section.classList.remove("running");
  showFinish(lane, 0, lane.totals, message);
  onLaneDone();
}

function tick() {
  for (const lane of Object.values(lanes)) {
    if (lane.running) $(".time", lane.section).textContent = fmtTime(performance.now() - lane.clientStart);
    if (lane.needsScroll) {
      lane.needsScroll = false;
      followFrontier(lane);
    }
  }
  requestAnimationFrame(tick);
}

function onLaneDone() {
  const active = SIDES.map((s) => lanes[s]).filter((l) => !l.unavailable);
  if (active.some((l) => !l.done && !l.failed)) return;
  $("#start").disabled = false;
  const jev = lanes.jev, llm = lanes.llm;
  if (jev.done) {
    // Keep the race order on screen; the re-rank starts when a slider moves.
    $("#rerank").hidden = false;
    showSliderValues();
    $("#rerankStat").textContent = "Drag a slider: the stored probabilities re-rank every row without calling a model.";
  }
  const verdict = $("#verdict");
  if (jev.done && llm.done) {
    const shared = [...jev.results.keys()].filter((id) => llm.results.has(id));
    const agree = (fn) => Math.round((100 * shared.filter((id) => fn(jev.results.get(id), llm.results.get(id))).length) / shared.length);
    verdict.innerHTML =
      `<div class="item"><span class="big">${fmtRatio(llm.ms / jev.ms)} faster</span><span class="small">${fmtTime(jev.ms)} vs ${fmtTime(llm.ms)}</span></div>` +
      `<div class="item"><span class="big">${fmtRatio(llm.totals.cost / jev.totals.cost)} cheaper</span><span class="small">${fmtCost(jev.totals.cost)} vs ${fmtCost(llm.totals.cost)}</span></div>` +
      `<div class="item"><span class="big">${agree((a, b) => a.topic === b.topic)}%</span><span class="small">same topic</span></div>` +
      `<div class="item"><span class="big">${agree((a, b) => (a.bug >= 0.5) === (b.bug >= 0.5))}%</span><span class="small">same bug call</span></div>` +
      `<div class="item"><span class="big">ρ ${qualityVsStars(jev).toFixed(2)} / ${qualityVsStars(llm).toFixed(2)}</span><span class="small">sentiment vs. stars (${$(".name", jev.section).textContent} / ${$(".name", llm.section).textContent})</span></div>`;
    verdict.hidden = false;
  }
}

function showSliderValues() {
  for (const input of document.querySelectorAll(".sliders input")) input.nextElementSibling.value = `${input.value}${input.id === "minBug" ? "%" : ""}`;
}

function applyRerank() {
  const started = performance.now();
  const w = {
    bug: Number($("#wBug").value) / 100,
    churn: Number($("#wChurn").value) / 100,
    neg: Number($("#wNeg").value) / 100,
    minBug: Number($("#minBug").value) / 100,
  };
  const topic = $("#topicFilter").value;
  showSliderValues();
  let shown = 0, total = 0;
  for (const lane of SIDES.map((s) => lanes[s]).filter((l) => l.done)) {
    const priority = (r) => w.bug * r.bug + w.churn * r.churn + w.neg * (1 - r.sentiment);
    const ordered = [...lane.results.values()].sort((a, b) => priority(b) - priority(a) || a.id - b.id);
    const wrap = $(".table-wrap", lane.section);
    const tbody = $("tbody", lane.section);
    // The race is over: drop the fill flashes so moving rows does not restart 2,000 CSS animations.
    if (!lane.settled) {
      lane.settled = true;
      for (const tr of lane.rowEls) tr.classList.remove("filled");
      for (const cell of lane.heatEls) cell.classList.remove("lit");
    }
    // FLIP, limited to rows on screen: read positions, reorder, read again, then animate (no read/write interleaving).
    const viewTop = wrap.scrollTop - 40, viewBottom = wrap.scrollTop + wrap.clientHeight + 40;
    const before = new Map();
    for (const tr of lane.rowEls) {
      const top = tr.offsetTop;
      if (top >= viewTop && top <= viewBottom && !tr.classList.contains("hidden-row")) before.set(tr, top - wrap.scrollTop);
    }
    const rows = document.createDocumentFragment();
    const heat = document.createDocumentFragment();
    let listed = 0;
    for (const r of ordered) {
      const visible = r.bug >= w.minBug && (!topic || r.topic === topic);
      // Only the top rows stay in table layout; laying out 1,000 rows per slider tick makes dragging choppy.
      const inTable = visible && listed++ < TABLE_LIMIT;
      lane.rowEls[r.id].classList.toggle("hidden-row", !inTable);
      lane.heatEls[r.id].style.opacity = visible ? "" : "0.12";
      rows.append(lane.rowEls[r.id]);
      heat.append(lane.heatEls[r.id]);
      if (lane.side === "jev") {
        total++;
        shown += visible;
      }
    }
    tbody.append(rows);
    $(".heat", lane.section).append(heat);
    wrap.scrollTop = 0;
    const moves = [];
    for (const r of ordered) {
      const tr = lane.rowEls[r.id];
      if (tr.classList.contains("hidden-row")) continue;
      const top = tr.offsetTop;
      if (top > wrap.clientHeight + 40) break;
      moves.push([tr, before.has(tr) ? before.get(tr) - top : wrap.clientHeight - top]);
    }
    for (const [tr, delta] of moves) {
      if (delta) tr.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], { duration: 450, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }
  const ms = performance.now() - started;
  $("#rerankStat").textContent =
    `Re-ranked ${fmtInt(total)} rows in ${ms.toFixed(1)} ms · 0 model calls · $0 · ${fmtInt(shown)} match` +
    (shown > TABLE_LIMIT ? ` · table shows top ${TABLE_LIMIT}` : "");
}

function reset() {
  for (const lane of Object.values(lanes)) lane.source?.close();
  const replay = $("#mode").value === "replay";
  // A replay re-emits the recorded run as it happened, so it always shows that run's row count.
  const recordedRows = config.jev.recorded?.rows ?? config.llm.recorded?.rows;
  if (replay && recordedRows) $("#rows").value = String(recordedRows);
  $("#rows").disabled = replay;
  const n = Number($("#rows").value);
  $("#rowCount").textContent = fmtInt(n);
  for (const side of SIDES) buildLane(side, n);
  $("#verdict").hidden = true;
  $("#rerank").hidden = true;
  updateKeyPanel();
}

async function init() {
  [config, reviews] = await Promise.all([fetch("/api/config").then((r) => r.json()), fetch("/api/reviews").then((r) => r.json())]);
  const topicSelect = $("#topicFilter");
  for (const [key, label] of Object.entries(TOPIC_LABELS)) topicSelect.add(new Option(label, key));
  $("#rows").addEventListener("change", reset);
  $("#mode").addEventListener("change", reset);
  $("#reset").addEventListener("click", reset);
  $("#start").addEventListener("click", () => {
    reset();
    $("#start").disabled = true;
    // Both lanes start in the same tick.
    for (const side of SIDES) startLane(side);
    if (SIDES.every((s) => lanes[s].unavailable)) $("#start").disabled = false;
  });
  for (const input of document.querySelectorAll(".sliders input, #topicFilter")) input.addEventListener("input", applyRerank);
  const params = new URLSearchParams(location.search);
  if (params.get("rows")) $("#rows").value = params.get("rows");
  const restored = config.byok ? restoreKeys() : false;
  if (params.get("mode")) $("#mode").value = params.get("mode");
  else if (config.live_enabled === false && !restored) $("#mode").value = "replay";
  for (const input of ["#keyTypesafe", "#keyGemini"]) {
    $(input).addEventListener("input", () => {
      rememberKeys();
      updateKeyPanel();
    });
    // Rebuild the lanes once a key is complete, so an unlocked lane shows its table.
    $(input).addEventListener("change", reset);
  }
  $("#rememberKeys").addEventListener("change", rememberKeys);
  reset();
  requestAnimationFrame(tick);
  if (params.has("autostart")) $("#start").click();
}

init();
