// The four AI columns, shared by both racers so they answer the same questions.

export const TOPICS = {
  bug: "Something is broken: crashes, errors, freezes, a feature that stopped working.",
  pricing: "Cost, ads, subscriptions, in-app purchases, paywalls, refunds.",
  usability: "Design, layout, ease of use, confusing settings, performance feel.",
  feature_request: "Asks for something the app does not do yet.",
  praise: "Mainly says the app is good, useful, or loved, with no specific problem.",
  other: "None of the above.",
};

export const SENTIMENT = [
  "Very negative: angry, calls the app useless or garbage.",
  "Negative: disappointed, main point is a problem.",
  "Mixed or neutral: balanced good and bad, or purely factual.",
  "Positive: likes the app, maybe with a small complaint.",
  "Very positive: enthusiastic, loves the app.",
];

export const CHURN = [
  "No sign of leaving: happy or neutral user.",
  "Annoyed but staying: complains without suggesting they will leave.",
  "At risk: threatens to uninstall, switch, or lower their rating unless fixed.",
  "Gone: says they already uninstalled, switched, or want a refund.",
];

export const BUG = "The review reports a bug, crash, error, freeze, or a feature that stopped working.";

// Jev: one request for a batch. Each review gets four independent questions over the shared state.
export function jevRequest(batch, model) {
  const questions = {};
  batch.forEach((review, i) => {
    const text = `\`reviews[${i}].text\``;
    questions[`sentiment_${review.id}`] = {
      type: "score",
      instructions: `How does the writer of ${text} feel about the app overall?`,
      criteria: SENTIMENT,
    };
    questions[`topic_${review.id}`] = {
      type: "choice",
      instructions: `What is the main topic of ${text}?`,
      criteria: TOPICS,
    };
    questions[`bug_${review.id}`] = {
      type: "noul",
      instructions: `Does ${text} report a bug, crash, error, freeze, or a feature that stopped working?`,
      criteria: { true: BUG, false: "No malfunction is reported." },
    };
    questions[`churn_${review.id}`] = {
      type: "score",
      instructions: `How likely is the writer of ${text} to stop using the app?`,
      criteria: CHURN,
    };
  });
  // Star ratings are deliberately excluded: they are the independent check on sentiment.
  return { model, state: { reviews: batch.map((r) => ({ app: r.app, text: r.text })) }, questions };
}

export function parseJev(batch, answers) {
  return batch.map((review) => {
    const s = answers[`sentiment_${review.id}`];
    const t = answers[`topic_${review.id}`];
    const b = answers[`bug_${review.id}`];
    const c = answers[`churn_${review.id}`];
    const ok =
      s?.type === "score" && Number.isFinite(s.score) &&
      t?.type === "choice" && t.choice in TOPICS &&
      b?.type === "noul" && Number.isFinite(b.noul) &&
      c?.type === "score" && Number.isFinite(c.score);
    if (!ok) throw new Error(`Invalid Jev answer for review ${review.id}`);
    return {
      id: review.id,
      sentiment: s.score / (SENTIMENT.length - 1),
      topic: t.choice,
      topic_confidence: t.confidence,
      bug: b.noul,
      churn: c.score / (CHURN.length - 1),
    };
  });
}

// LLM: same four columns, same batch, JSON output.
export const LLM_SYSTEM = `You label app reviews. For every review return one JSON object in "results" with:
- "id": the review id
- "sentiment": integer 0-4. ${SENTIMENT.map((s, i) => `${i} = ${s}`).join(" ")}
- "topic": one of ${Object.entries(TOPICS).map(([k, v]) => `"${k}" (${v})`).join(", ")}
- "bug": number 0-1, probability that ${BUG.toLowerCase()}
- "churn": integer 0-3. ${CHURN.map((s, i) => `${i} = ${s}`).join(" ")}
Return only {"results": [...]} with one entry per review, no commentary.`;

export function llmMessages(batch) {
  return [
    { role: "system", content: LLM_SYSTEM },
    { role: "user", content: JSON.stringify(batch.map((r) => ({ id: r.id, app: r.app, text: r.text }))) },
  ];
}

export function parseLlm(batch, content) {
  const text = String(content ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  const results = JSON.parse(text).results;
  const byId = new Map(results.map((r) => [Number(r.id), r]));
  return batch.map((review) => {
    const r = byId.get(review.id);
    const sentiment = Number(r?.sentiment);
    const churn = Number(r?.churn);
    const bug = Number(r?.bug);
    const ok =
      r && Number.isFinite(sentiment) && sentiment >= 0 && sentiment <= 4 &&
      r.topic in TOPICS && Number.isFinite(bug) && bug >= 0 && bug <= 1 &&
      Number.isFinite(churn) && churn >= 0 && churn <= 3;
    if (!ok) throw new Error(`Invalid LLM answer for review ${review.id}`);
    return { id: review.id, sentiment: sentiment / 4, topic: r.topic, topic_confidence: null, bug, churn: churn / 3 };
  });
}
