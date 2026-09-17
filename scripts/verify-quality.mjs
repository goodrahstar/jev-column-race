import { readFileSync } from "node:fs";
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const reviews = JSON.parse(readFileSync(new URL("../data/reviews.json", import.meta.url)));
const run = JSON.parse(readFileSync(new URL("../runs/jev.json", import.meta.url)));
const rows = run.events.filter((e) => e.type === "rows").flatMap((e) => e.rows).sort((a, b) => a.id - b.id);
function rank(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = [];
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return ranks;
}
function spearman(x, y) {
  const rx = rank(x), ry = rank(y), n = x.length;
  const mx = rx.reduce((a, b) => a + b) / n, my = ry.reduce((a, b) => a + b) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
// Control: the statistic must be ~1 for identical rankings and ~-1 for reversed ones.
if (spearman([1, 2, 3, 4], [10, 20, 30, 40]) < 0.999 || spearman([1, 2, 3, 4], [4, 3, 2, 1]) > -0.999) fail("spearman control");
const stars = rows.map((r) => reviews[r.id].stars);
const rho = spearman(rows.map((r) => r.sentiment), stars);
const bugRate = (s) => { const g = rows.filter((r) => reviews[r.id].stars === s); return g.filter((r) => r.bug >= 0.5).length / g.length; };
const topics = {}; rows.forEach((r) => (topics[r.topic] = (topics[r.topic] || 0) + 1));
console.log(`spearman(sentiment, stars)=${rho.toFixed(3)} bug_rate_1star=${bugRate(1).toFixed(2)} bug_rate_5star=${bugRate(5).toFixed(2)} topics=${JSON.stringify(topics)}`);
if (rho < 0.6) fail(`spearman ${rho.toFixed(3)} < 0.6`);
if (!(bugRate(1) > bugRate(5))) fail("1-star reviews should report bugs more often than 5-star");
console.log("QUALITY OK");
