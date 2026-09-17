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

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

export function createApp({ env = process.env, fetchImpl = fetch, runsDir = join(ROOT, "runs") } = {}) {
  const reviews = JSON.parse(readFileSync(join(ROOT, "data/reviews.json"), "utf8"));
  const batchSize = Number(env.BATCH_SIZE || 20);
  const concurrency = Number(env.CONCURRENCY || 8);
  const llmLabel = env.LLM_LABEL || env.LLM_MODEL || "LLM";

  const racers = {
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
      jev: side("jev", "Jev"),
      llm: side("llm", llmLabel),
    };
  }

  async function streamRace(request, response, url) {
    const side = url.searchParams.get("side");
    const mode = url.searchParams.get("mode") || "live";
    const n = Math.min(reviews.length, Math.max(1, Number(url.searchParams.get("n") || reviews.length)));
    if (!["jev", "llm"].includes(side)) return send(response, 400, { error: "side must be jev or llm" });
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    const controller = new AbortController();
    request.on("close", () => controller.abort());
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

    const racer = racers[side];
    if (!racer) {
      write({ type: "error", message: side === "llm" ? "Add LLM_API_KEY and LLM_MODEL to .env" : "Add TYPESAFE_API_KEY to .env" });
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
      if (done?.type === "done" && !controller.signal.aborted) {
        mkdirSync(runsDir, { recursive: true });
        writeFileSync(
          runFile(side),
          JSON.stringify({
            side,
            model: racer.model,
            recorded_at: new Date().toISOString(),
            rows: done.totals.rows,
            ms: done.t,
            cost: done.totals.cost,
            batch_size: batchSize,
            concurrency,
            events,
          }),
        );
      }
    } catch (error) {
      write({ type: "error", message: error.message });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  const port = Number(process.env.PORT || 8777);
  createApp().listen(port, "127.0.0.1", () => console.log(`Column Race on http://127.0.0.1:${port}`));
}
