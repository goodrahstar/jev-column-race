// Mock TypeSafe and Gemini (OpenAI-compatible) endpoints for offline tests. Records every call.
import { TOPICS } from "../lib/columns.mjs";

export function mockProviders({ delayMs = 0 } = {}) {
  const calls = [];
  const state = { echoKey: false };
  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    const auth = init.headers.Authorization;
    calls.push({ url, auth, model: body.model, extra: body.reasoning_effort });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const reply = (status, json) => new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
    if (state.echoKey) return reply(401, { error: { message: `API key not valid: ${auth}` } });
    if (url === "https://api.typesafe.ai/v1/systemone") {
      const answers = {};
      for (const [id, q] of Object.entries(body.questions)) {
        if (q.type === "score") answers[id] = { type: "score", score: 1, confidence: 0.9, probabilities: {} };
        else if (q.type === "choice") answers[id] = { type: "choice", choice: Object.keys(TOPICS)[0], confidence: 0.9, probabilities: {} };
        else answers[id] = { type: "noul", noul: 0.7 };
      }
      return reply(200, { model: "jev-mock", answers, usage: { input_tokens: 1000, output_tokens: 10 } });
    }
    if (url === "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions") {
      const batch = JSON.parse(body.messages[1].content);
      const content = JSON.stringify({ results: batch.map((r) => ({ id: r.id, sentiment: 2, topic: "praise", bug: 0.1, churn: 1 })) });
      return reply(200, { model: body.model, choices: [{ message: { content } }], usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 } });
    }
    return reply(404, { error: `unexpected host ${url}` });
  }
  return { fetchImpl, calls, state };
}
