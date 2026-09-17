// Both racers: split reviews into batches, run them with the same concurrency, emit timestamped events.
import { jevRequest, llmMessages, parseJev, parseLlm } from "./columns.mjs";

export const JEV_PRICE_INPUT = 0.042; // $ per million input tokens; output tokens are free (docs.typesafe.ai/models)

function batches(reviews, size) {
  const out = [];
  for (let i = 0; i < reviews.length; i += size) out.push(reviews.slice(i, i + size));
  return out;
}

async function postJson(fetchImpl, url, key, body, extraHeaders = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    });
    if ([429, 500, 502, 503, 529].includes(response.status) && attempt < 4) {
      const wait = Number(response.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  }
}

// Runs every batch through `work` with a fixed concurrency and reports rows as they land.
async function race({ reviews, batchSize, concurrency, work, emit, signal }) {
  const started = performance.now();
  const queue = batches(reviews, batchSize);
  const totals = { rows: 0, requests: 0, input_tokens: 0, output_tokens: 0, cost: 0, retries: 0 };
  const at = () => Math.round(performance.now() - started);
  emit({ type: "start", t: 0, total: reviews.length, batch_size: batchSize, concurrency });
  let next = 0;
  async function lane() {
    while (next < queue.length && !signal?.aborted) {
      const batch = queue[next++];
      const sent = at();
      const result = await work(batch);
      totals.rows += result.rows.length;
      totals.requests += 1 + result.retries;
      totals.retries += result.retries;
      totals.input_tokens += result.input_tokens;
      totals.output_tokens += result.output_tokens;
      totals.cost += result.cost;
      emit({ type: "rows", t: at(), latency_ms: at() - sent, rows: result.rows, totals: { ...totals } });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, lane));
  emit({ type: "done", t: at(), totals: { ...totals } });
}

export function jevRacer({ key, model = "jev-latest", fetchImpl = fetch }) {
  const racer = {
    name: "Jev",
    model,
    run: (options) =>
      race({
        ...options,
        async work(batch) {
          const json = await postJson(fetchImpl, "https://api.typesafe.ai/v1/systemone", key, jevRequest(batch, model));
          if (json.model) racer.model = json.model; // record the versioned model that answered, not the alias
          const input = json.usage?.input_tokens ?? 0;
          return {
            rows: parseJev(batch, json.answers),
            retries: 0,
            input_tokens: input,
            output_tokens: json.usage?.output_tokens ?? 0,
            cost: (input * JEV_PRICE_INPUT) / 1e6,
          };
        },
      }),
  };
  return racer;
}

// Any OpenAI-compatible chat endpoint: OpenAI, OpenRouter, Gemini's OpenAI endpoint, DeepSeek, Groq...
export function llmRacer({ key, baseUrl, model, priceInput, priceOutput, reasoning, fetchImpl = fetch }) {
  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";
  const racer = {
    name: model,
    model,
    run: (options) =>
      race({
        ...options,
        async work(batch) {
          let retries = 0, input = 0, output = 0, cost = 0;
          for (;;) {
            const body = {
              model,
              messages: llmMessages(batch),
              response_format: { type: "json_object" },
              ...(reasoning ? JSON.parse(reasoning) : {}),
            };
            const json = await postJson(fetchImpl, url, key, body);
            if (json.model) racer.model = json.model;
            const i = json.usage?.prompt_tokens ?? 0;
            // Output includes any thinking tokens, which are billed as output (total - prompt covers them).
            const o = Number.isFinite(json.usage?.total_tokens) ? json.usage.total_tokens - i : json.usage?.completion_tokens ?? 0;
            input += i;
            output += o;
            // Prefer the provider's billed cost (OpenRouter reports usage.cost); otherwise use configured prices.
            cost += Number.isFinite(json.usage?.cost) ? json.usage.cost : (i * priceInput + o * priceOutput) / 1e6;
            try {
              return { rows: parseLlm(batch, json.choices?.[0]?.message?.content), retries, input_tokens: input, output_tokens: output, cost };
            } catch (error) {
              // Invalid JSON or a missing row costs a full retry, exactly as it would in production.
              if (++retries > 2) throw error;
            }
          }
        },
      }),
  };
  return racer;
}
