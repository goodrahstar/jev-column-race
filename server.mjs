// Zero-dependency local server. API keys stay here; the browser only receives results.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { jevRacer, llmRacer } from "./lib/racers.mjs";

const ROOT = new URL(".", import.meta.url).pathname;

export function loadEnv(file = join(ROOT, ".env")) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

// Bring-your-own-key races always use these fixed endpoints and models. Visitors supply keys only,
// never URLs, so the function cannot be pointed at arbitrary hosts.
export const BYOK_LLM = {
  label: "Gemini 3.8 Flash",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  model: "gemini-3.8-flash",
  priceInput: 0.75,
  priceOutput: 3.75,
  reasoning: JSON.stringify({ reasoning_effort: "none" }),
};
const KEY_PATTERN = /^[\x21-\x7e]{10,256}$/;
const MAX_BODY_BYTES = 4096;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

// `live: false` means the server's own keys are never loaded, so no paid call happens on its account.
// `byok: true` lets a visitor run a live race with their own TypeSafe and Gemini keys (POST /api/race).
export function createApp({ env = process.env, fetchImpl = fetch, runsDir = join(ROOT, "runs"), live = true, byok = true } = {}) {
  const reviews = JSON.parse(readFileSync(join(ROOT, "data/reviews.json"), "utf8"));
  const batchSize = Number(env.BATCH_SIZE || 20);
  const concurrency = Number(env.CONCURRENCY || 8);
  // Label the right lane by name even when no LLM env is configured (e.g. a replay-only deployment).
  const llmLabel = () => env.LLM_LABEL || env.LLM_MODEL || (recorded("llm")?.model === BYOK_LLM.model ? BYOK_LLM.label : recorded("llm")?.model) || "LLM";

  const racers = !live ? { jev: null, llm: null } : {
    jev: env.TYPESAFE_API_KEY ? jevRacer({ key: env.TYPESAFE_API_KEY, model: env.TYPESAFE_MODEL || "jev-latest", fetchImpl }) : null,
    llm:
      env.LLM_API_KEY && env.LLM_MODEL
        ? llmRacer({
            key: env.LLM_API_KEY,
            baseUrl: env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
            model: env.LLM_MODEL,
            priceInput: Number(env.LLM_PRICE_INPUT || 0),
            priceOutput: Number(env.LLM_PRICE_OUTPUT || 0),
            reasoning: env.LLM_EXTRA_BODY,
            fetchImpl,
          })
        : null,
  };
  const runFile = (side) => join(runsDir, `${side}.json`);
  const recorded = (side) => (existsSync(runFile(side)) ? JSON.parse(readFileSync(runFile(side), "utf8")) : null);

  function config() {
    const side = (name, label) => {
      const run = recorded(name);
      return {
        live: Boolean(racers[name]),
        label,
        model: racers[name]?.model ?? run?.model ?? null,
        recorded: run ? { rows: run.rows, ms: run.ms, cost: run.cost, model: run.model, at: run.recorded_at } : null,
      };
    };
    return {
      reviews: reviews.length,
      batch_size: batchSize,
      concurrency,
      live_enabled: live,
      byok: byok ? { jev: "Jev", llm: BYOK_LLM.label, llm_model: BYOK_LLM.model } : null,
      jev: side("jev", "Jev"),
      llm: side("llm", llmLabel()),
    };
  }

  async function readBody(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { status: 413 });
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      throw Object.assign(new Error("Body must be JSON"), { status: 400 });
    }
  }

  // Builds a one-off racer from a visitor's key. The key lives only in this request's closure.
  function visitorRacer(side, keys) {
    const key = side === "jev" ? keys?.typesafe : keys?.gemini;
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) return { error: side === "jev" ? "Add your TypeSafe API key to race Jev live." : `Add your Gemini API key to race ${BYOK_LLM.label} live.` };
    const racer =
      side === "jev"
        ? jevRacer({ key, model: "jev-latest", fetchImpl })
        : llmRacer({ key, baseUrl: BYOK_LLM.baseUrl, model: BYOK_LLM.model, priceInput: BYOK_LLM.priceInput, priceOutput: BYOK_LLM.priceOutput, reasoning: BYOK_LLM.reasoning, fetchImpl });
    return { racer, key };
  }

  async function streamRace(request, response, url) {
    let body = {};
    if (request.method === "POST") {
      if (!byok) return send(response, 403, { error: "Bring-your-own-key races are disabled on this deployment." });
      try {
        body = await readBody(request);
      } catch (error) {
        return send(response, error.status || 400, { error: error.message });
      }
    }
    const param = (name) => (request.method === "POST" ? body[name] : url.searchParams.get(name));
    const side = param("side");
    const mode = request.method === "POST" ? "live" : param("mode") || "live";
    const n = Math.min(reviews.length, Math.max(1, Math.floor(Number(param("n") || reviews.length)) || reviews.length));
    if (!["jev", "llm"].includes(side)) return send(response, 400, { error: "side must be jev or llm" });
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    const controller = new AbortController();
    // Abort only if the client goes away before we finish. (A request "close" can fire as soon as a
    // host runtime consumes the empty GET body, which would silently cut the stream on Vercel.)
    response.on("close", () => response.writableFinished || controller.abort());
    const write = (event) => !controller.signal.aborted && response.write(`data: ${JSON.stringify(event)}\n\n`);

    if (mode === "replay") {
      const run = recorded(side);
      if (!run) {
        write({ type: "error", message: `No recorded ${side} run yet. Run it live once first.` });
        return response.end();
      }
      // Re-emit the recorded events on their original timestamps: a 1x replay, never sped up.
      const start = performance.now();
      write({ ...run.events[0], replay: true, model: run.model, recorded_at: run.recorded_at });
      for (const event of run.events.slice(1)) {
        const wait = event.t - (performance.now() - start);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        if (controller.signal.aborted) return;
        write(event);
      }
      return response.end();
    }

    let racer = racers[side];
    let visitorKey = null;
    if (request.method === "POST") {
      const visitor = visitorRacer(side, body.keys);
      if (visitor.error) {
        write({ type: "error", message: visitor.error });
        return response.end();
      }
      racer = visitor.racer;
      visitorKey = visitor.key;
    }
    // Provider errors can echo request details; never send a visitor's key back, even to themselves.
    const scrub = (message) => (visitorKey ? String(message).split(visitorKey).join("[your key]").split(visitorKey.slice(-12)).join("[key]") : message);
    if (!racer) {
      write({
        type: "error",
        message: !live ? "Live mode is disabled on this deployment. Use replay." : side === "llm" ? "Add LLM_API_KEY and LLM_MODEL to .env" : "Add TYPESAFE_API_KEY to .env",
      });
      return response.end();
    }
    const events = [];
    try {
      await racer.run({
        reviews: reviews.slice(0, n),
        batchSize,
        concurrency,
        signal: controller.signal,
        emit(event) {
          events.push(event);
          write(event.type === "start" ? { ...event, model: racer.model } : event);
        },
      });
      const done = events.at(-1);
      // Visitor runs are never recorded: the published replays stay the measured demo runs.
      if (done?.type === "done" && !controller.signal.aborted && !visitorKey) {
        const record = { side, model: racer.model, recorded_at: new Date().toISOString(), rows: done.totals.rows, ms: done.t, cost: done.totals.cost, batch_size: batchSize, concurrency, events };
        try {
          mkdirSync(runsDir, { recursive: true });
          writeFileSync(runFile(side), JSON.stringify(record));
        } catch (error) {
          // Read-only filesystem (e.g. a Vercel function): the race itself still succeeded.
          console.warn(`Could not record ${side} run: ${error.message}`);
        }
      }
    } catch (error) {
      write({ type: "error", message: scrub(error.message) });
    }
    response.end();
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (url.pathname === "/api/config") return send(response, 200, config());
      if (url.pathname === "/api/reviews") return send(response, 200, reviews);
      if (url.pathname === "/api/race") return await streamRace(request, response, url);
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = join(ROOT, "public", path);
      if (!file.startsWith(join(ROOT, "public")) || !existsSync(file)) return send(response, 404, { error: "not found" });
      response.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      response.end(readFileSync(file));
    } catch (error) {
      if (!response.headersSent) send(response, 500, { error: error.message });
      else response.end();
    }
  });
}

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

// Vercel entry point. Vercel imports this module (so the listen() block below never runs) and needs a
// default export that is a function or server. The app is built lazily on the first request.
// The owner's keys are used only if ALLOW_LIVE_RACE=1: a public URL must not spend them for anyone who opens it.
// Visitors can still race live with their own keys (disable with ALLOW_BYOK=0) or watch the recorded replays.
let vercelApp;
export default function handler(request, response) {
  vercelApp ??= createApp({ live: process.env.ALLOW_LIVE_RACE === "1", byok: process.env.ALLOW_BYOK !== "0" });
  vercelApp.emit("request", request, response);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  const port = Number(process.env.PORT || 8777);
  createApp().listen(port, "127.0.0.1", () => console.log(`Column Race on http://127.0.0.1:${port}`));
}
