// Fetch 1,000 real Android app reviews (sealuzh/app_reviews on Hugging Face) spread across many apps.
import { writeFileSync, mkdirSync } from "node:fs";

const TOTAL_ROWS = 288065;
const PAGES = 25;
const PER_PAGE = 40;
const ROWS_API = "https://datasets-server.huggingface.co/rows?dataset=sealuzh/app_reviews&config=default&split=train";

const reviews = [];
const seen = new Set();
for (let page = 0; page < PAGES; page++) {
  let offset = Math.floor((page * TOTAL_ROWS) / PAGES) + 137;
  let taken = 0;
  // Keep reading forward from this spot until the page has enough usable reviews.
  while (taken < PER_PAGE) {
    const response = await fetch(`${ROWS_API}&offset=${offset}&length=100`);
    if (!response.ok) throw new Error(`HTTP ${response.status} at offset ${offset}`);
    const { rows } = await response.json();
    if (!rows.length) throw new Error(`No rows at offset ${offset}`);
    for (const { row_idx, row } of rows) {
      const text = (row.review || "").replace(/\s+/g, " ").trim();
      if (text.length < 50 || text.length > 420 || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      reviews.push({ id: reviews.length, source_row: row_idx, app: row.package_name, stars: row.star, text });
      if (++taken === PER_PAGE) break;
    }
    offset += rows.length;
  }
}
mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
writeFileSync(new URL("../data/reviews.json", import.meta.url), JSON.stringify(reviews, null, 1));
console.log(`Saved ${reviews.length} reviews from ${new Set(reviews.map((r) => r.app)).size} apps`);
