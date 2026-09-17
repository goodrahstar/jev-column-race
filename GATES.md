# Gates: Jev Column Race demo

OWNS: **

Scope: A local, recordable web demo where Jev fills four AI columns (sentiment, topic, bug report, churn risk) over 1,000 real app reviews, racing an OpenAI-compatible LLM side by side with live time/cost counters, plus instant re-ranking from stored probabilities.

- [x] G1: data/reviews.json holds 1,000 real app reviews with text and star rating
  CHECK: node scripts/verify-data.mjs
  EXPECT: DATA OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/rahulkumar/Desktop/Experiments/jev-column-race; path=f328f008affb/20 entries; output=apps=17 stars={"1":313,"2":89,"3":99,"4":94,"5":405} | DATA OK

- [x] G2: the server serves the page and 1,000 reviews, and never sends the API key to the browser
  CHECK: node scripts/verify-server.mjs
  EXPECT: SERVER OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/rahulkumar/Desktop/Experiments/jev-column-race; path=f328f008affb/20 entries; output=SERVER OK

- [x] G3: a recorded live Jev run covers all 1,000 rows with valid typed answers, timings, tokens and cost
  CHECK: node scripts/verify-run.mjs jev
  EXPECT: RUN OK jev
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/rahulkumar/Desktop/Experiments/jev-column-race; path=f328f008affb/20 entries; output=model=jev-1.13.0 ms=4414 requests=50 input_tokens=536872 cost=$0.022549 recorded_at=2026-09-17T07:35:40.594Z | RUN OK jev

- [x] G4: Jev sentiment agrees with the independent star ratings (Spearman >= 0.6)
  CHECK: node scripts/verify-quality.mjs
  EXPECT: QUALITY OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/rahulkumar/Desktop/Experiments/jev-column-race; path=f328f008affb/20 entries; output=spearman(sentiment, stars)=0.800 bug_rate_1star=0.56 bug_rate_5star=0.08 topics={"usability":124,"bug":348,"praise":330,"feature_request":83,"other":103,"pricing":12} | QUALITY OK

- [x] G5: the LLM racer pipeline works end to end against a mock OpenAI-compatible server (parsing, retries on bad JSON, cost math)
  CHECK: node scripts/verify-llm-mock.mjs
  EXPECT: LLM MOCK OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/rahulkumar/Desktop/Experiments/jev-column-race; path=f328f008affb/20 entries; output=calls=6 retries=1 cost=$0.021000 rows=100 | LLM MOCK OK

- [x] G6: replay mode re-emits a recorded run with its original timestamps
  CHECK: node scripts/verify-replay.mjs
  EXPECT: REPLAY OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/rahulkumar/Desktop/Experiments/jev-column-race; path=f328f008affb/20 entries; output=start@0->0ms rows@400->400ms rows@900->899ms done@1300->1304ms | REPLAY OK

- [x] G7: all browser JavaScript parses
  CHECK: node --check public/app.js && node --check server.mjs && node --check lib/racers.mjs && echo SYNTAX OK
  EXPECT: SYNTAX OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/rahulkumar/Desktop/Experiments/jev-column-race; path=f328f008affb/20 entries; output=SYNTAX OK

- [x] G8: in real headless Chrome the replayed race renders mid-race, finishes with the card, has no frame freeze over 400 ms, and slider re-ranks are correct and under 150 ms
  CHECK: node scripts/verify-browser.mjs
  EXPECT: BROWSER OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/rahulkumar/Desktop/Experiments/jev-column-race; path=f328f008affb/20 entries; output={"mid":{"pct":"180 / 1,000","time":"1.5s","lit":180},"finish":{"text":"FINISHED\n4.4s\n1,000 rows · $0.023\nsentiment vs. star rating ρ = 0.80","filled":1000,"maxGap":49.900000000000546,"frames":302},"rerank":{"times":[126,75,73,28,25,28],"

- [x] G10: screenshots of mid-race, finish and re-rank (landscape and 720x1280 portrait) reviewed by eye for layout and legibility
  EVIDENCE: 2026-09-17 reviewed shots/1-mid-race.png (180/1,000, rows flash as filled), shots/2-finish.png (finish card 4.4s · $0.023 · ρ 0.80, full sentiment mosaic, table kept in race order), shots/3-rerank.png and shots/720x1280-3-rerank.png (bug≥80% filter, 1-star bug reports on top, "Re-ranked 1,000 rows in 33.7 ms · 0 model calls"); portrait stacks lanes with no horizontal overflow. Fixed during review: frozen tab from per-row forced reflow, 2 s re-rank from interleaved FLIP reads, white bug outlines swamping heat squares, auto re-sort hiding the race result.

- [x] G9: a real LLM run is recorded for the right-hand side (needs the comparison model key from the user)
  CHECK: node scripts/verify-run.mjs llm
  EXPECT: RUN OK llm
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/rahulkumar/Desktop/Experiments/jev-column-race; path=f328f008affb/20 entries; output=model=gemini-3.8-flash ms=18781 requests=50 input_tokens=64489 cost=$0.157589 recorded_at=2026-09-17T10:17:28.041Z | RUN OK llm
