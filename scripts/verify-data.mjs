import { readFileSync } from "node:fs";
const reviews = JSON.parse(readFileSync(new URL("../data/reviews.json", import.meta.url)));
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
if (reviews.length !== 1000) fail(`expected 1000 reviews, got ${reviews.length}`);
reviews.forEach((r, i) => {
  if (r.id !== i) fail(`id ${r.id} at index ${i}`);
  if (typeof r.text !== "string" || r.text.length < 50) fail(`review ${i} text too short`);
  if (![1, 2, 3, 4, 5].includes(r.stars)) fail(`review ${i} stars ${r.stars}`);
  if (!Number.isInteger(r.source_row) || typeof r.app !== "string") fail(`review ${i} missing provenance`);
});
if (new Set(reviews.map((r) => r.text.toLowerCase())).size !== 1000) fail("duplicate texts");
const stars = {}; reviews.forEach((r) => (stars[r.stars] = (stars[r.stars] || 0) + 1));
console.log(`apps=${new Set(reviews.map((r) => r.app)).size} stars=${JSON.stringify(stars)}`);
console.log("DATA OK");
