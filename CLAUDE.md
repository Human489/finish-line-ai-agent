# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

A Steam backlog agent built on [eve](https://www.npmjs.com/package/eve) (Vercel's agent framework) + AI SDK + Next.js + AI Elements. Point it at any public Steam profile; it reports how far through each owned game you are and how much work is left.

Read `node_modules/eve/docs/` before writing agent code — eve is preview-stage and its API is not in training data. Start with `getting-started.mdx`, `tools/overview.mdx`, `concepts/built-in-tools.md`.

## Running it

**Two processes, in this order.** This is not the default `withEve()` setup — see "The retry loop" below for why.

```bash
# terminal 1 — eve on a FIXED port, with the transport timeouts raised
WORKFLOW_LOCAL_BASE_URL=http://127.0.0.1:4278 WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS=600000 WORKFLOW_LOCAL_BODY_TIMEOUT_MS=600000   npx eve dev --no-ui --port 4278

# terminal 2
npm run dev

# terminal 3, once — pays the cold-start cost so your first question doesn't
npx tsx scripts/warm-eve.ts http://127.0.0.1:4278
```

**The two timeout vars are not optional if you care about latency** — see "Why the first turn is slow" below.

`.env.local` must contain `EVE_BASE_URL=http://127.0.0.1:4278` for Next to proxy to that process instead of spawning its own. **Never set `EVE_BASE_URL` in production** — it points at localhost.

It also needs `STEAM_WEB_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, and — for document search — `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_VECTORIZE_INDEX`. Without the `CF_*` three, `search_documents` reports itself unavailable rather than failing the turn.

Restart the eve process after changing any env var or `agent/**` file; it reads `.env.local` once at spawn.

## Checks

```bash
npx tsc --noEmit                          # types
npx eslint app agent scripts              # lint
npx eve info                              # agent surface + diagnostics; run after touching agent/tools/
```

`eve info` reporting `0 errors` is meaningful proof for `disableTool()` files — eve fails discovery on an unrecognised tool name rather than silently ignoring it.

### Tests

```bash
npx tsx scripts/test-logic.ts            # assertions over the deterministic logic; no keys, no network
```

The only script here that asserts rather than prints. It covers `scoring.ts` (category assignment, mode gating, the hours floor), `findUngroundedNumbers` and `pooledSettled`, and exits non-zero on failure — run it after touching any of them. There is no test framework; it is `node:assert` under `tsx`, deliberately, to avoid adding a dependency for one file.

It carries a regression case per bug fixed, and the false-positive cases for the grounding checker matter as much as the true positives: a false positive discards a *correct* sentence. One case asserts `templateReason()` never trips the checker, since it is the text that replaces rejected prose.

### Live scripts (no assertions; these hit real APIs)

```bash
npx tsx scripts/smoke.ts [vanityOrSteamID64]   # keyless APIs + scoring logic, no keys needed
npx tsx scripts/smoke-keys.ts                  # validates both API keys, ~86 tokens
npx tsx scripts/time-sweep.ts [profile]        # times each data source end to end
npx tsx scripts/warm-eve.ts [baseUrl]          # pays eve's cold-start cost up front
```

They default to a public test profile; override with `SMOKE_STEAM_PROFILE` / `SMOKE_STEAM_ID`.

## Why the first turn is slow

**Everything in this section is about `eve dev`. In production the cause was different, and is covered in "The fifteen seconds that were not a cold start" below — read that first if the deployed app is slow.**

Measured on a 597-game library, all four numbers from the same session:

| | |
| --- | --- |
| First turn in a fresh eve process | **59.1s** |
| Second turn, same process | **6.9s** |
| Gemini call, full instructions + all tool declarations | 0.9s |
| `sweep_achievements` across 137 games | 3.8s |

**It is not the model and not the data.** Both were timed independently and are fast. The ~50s is eve compiling the agent and its tools lazily on first use, and it is paid once per process. A per-step breakdown of a cold turn shows it precisely: the first step takes 22-52s, and every step after it takes 0.6-1.7s.

That cold start then cascades, which is what made it look like a networking bug:

1. `@workflow/world-local` POSTs each step to eve and gives up if response headers take longer than `WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS` — **default 30 000**.
2. A cold first step needs more than that, so the delivery is aborted and reported as `TypeError: fetch failed`.
3. world-local then sleeps a **hardcoded 5s** and redelivers, up to 256 times. The redelivery finds the step still running ("already in flight, awaiting its settlement") and waits, only to be cut off at 30s again.

So a slow-but-healthy step gets killed and retried repeatedly. Raising the two timeout vars in "Running it" stops that: retries went from 9 in a turn to **0**, and turn time from 98.8s to 60.2s. `scripts/warm-eve.ts` removes the rest by paying the compile cost before a person is waiting on it.

Two smaller contributors, both measured:

- **Stale run recovery.** world-local replays active runs on startup. With 21 run directories in `.eve` this added ~35s to the first turn; `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS=0` removes it, at the cost of not resuming interrupted runs after a restart.
- **Reasoning effort is not the cause.** `reasoning: "none"` was tried and made no measurable difference (59.1s vs 60.2s), so `low` was kept.

If turns feel slow again locally, check in this order: is the eve process fresh (cold start), are the timeout vars set, and only then look at the model.

## The fifteen seconds that were not a cold start

The section above sent me looking for a compile that production does not do. `eve build` compiles ahead of time and writes `.eve/compile/compiled-agent-manifest.json`; the lazy first-use compile is a `eve dev` behaviour. So "the agent is warming up" was the wrong explanation for a deployed app, and it was told to a player as though it were fact.

What it actually was, measured by instrumenting `fetch` in the browser and timestamping the event stream:

| Event | Arrived |
| --- | --- |
| `session.started`, `turn.started` | 0.1s |
| first `actions.requested` | **15.2s** |
| three more steps, the answer, `turn.completed` | 19.3s |

So the whole turn after the first step took four seconds, later steps ran 0.8-1.2s each, and the model itself benchmarks at 579ms. Fifteen seconds vanished before the first step did anything. Vercel's own logs agreed: the workflow step dispatches for a turn span about seven seconds.

The cause was `agent/agent.ts` passing the model through `defineDynamic` on `step.started`. From `dynamic-capabilities.md`: *"Dynamic models do not compile a default model or model metadata. When a resolver first selects a model, eve normalizes the selection and resolves any omitted context-window metadata from the AI Gateway catalog."* A network lookup, at runtime, on the first step of every session.

The comment justifying it claimed eve only accepts a live `LanguageModel` from the `step.started` scope. That is false of the static field — `agent-config.md`: *"To call a provider directly and configure the model in code, pass a provider-authored `LanguageModel`."* The `step.started` restriction applies to dynamic **resolvers**. Passing the model statically dropped the gap from 15.2s to 1.9s.

Two things worth keeping from the hunt. **Measure the stream, not the wall clock** — timestamping the raw SSE chunks is what separated "the work is slow" from "the delivery is slow", and Vercel's logs then confirmed the work was never slow. And eve has **no `maxSteps` and no `stopWhen`**; its only runtime limits are token-based per session, and the sole per-call gate is the `approval` hook, which parks the turn for a human. A per-turn call budget has to come from tool schemas.

## Architecture

### The determinism contract

The core design constraint, spanning `agent/lib/scoring.ts`, `agent/tools/score_backlog.ts` and `agent/instructions.md`:

**The model performs no arithmetic and chooses no verdict.** `scoring.ts` computes every number and assigns one of six fixed categories. The model receives that verdict as a fixed field and may only write a short sentence around it. `templateReason()` exists so the app still works correctly with zero useful LLM output — and `FallbackAnswer` in `app/page.tsx` actually renders it when the model says nothing, which for a long time it did not.

The contract is **enforced at render, not requested**. `GroundedText` in `app/page.tsx` runs `findUngroundedNumbers()` over the model's prose against the metrics of every game in that turn's `score_backlog` output, and swaps the whole sentence for `templateReason()` if anything fails. It has to live there: eve's hooks are observe-only, fire after the text is durably persisted and streaming, and can only throw (failing the entire turn) rather than substitute — so the render path is the first place holding both the prose and the full untrimmed tool output. The cost is that this guards **this UI only**; ungrounded text still sits in the durable transcript for any other consumer.

`findUngroundedNumbers` checks numbers **with their units** (`92%`, `5h`, `3 achievements`) and ignores bare digits on purpose — in this domain most bare digits are game titles ("Portal 2"), not claims. Checking the unit also catches a swap the value alone cannot: `achievementPercent` of 95 quoted as "95 hours left" is grounded on digits and nonsense in fact. Only the exact value and its rounding are accepted; floor/ceil were tried and dropped, because `ceil(1.1) = 2` let "about 2h" through for a 1.1h figure.

When adding a metric, add it to `scoring.ts` — never let the model derive one. Give its key a name containing `percent`, `rarity`, `hours` or `achievements`, or `unitFor()` will not know what unit it may be quoted in and will skip validating it.

**`facts.dataGaps` is model-visible.** `toModelOutput` forwards it verbatim as `caveats`, so a caveat that quotes a number hands that number to the model no matter what `quotableMetrics` strips. This was a real leak: the floor caveat used to read "the 1.1h figure assumes average difficulty and does not hold", which both re-fed the model the withheld value and printed it on the card immediately below the line that replaced it. Write caveats that describe the problem without citing the figure.

### Document retrieval (RAG)

The Steam tools answer *what is in this library*. A corpus of 12 Valve and ProtonDB documents answers *how any of this works* — why a game is missing, what Steam Families shares, how playtime is recorded, what Proton cannot run. Questions the agent used to decline.

`agent/lib/rag.ts` embeds the question with Cloudflare Workers AI and queries a Vectorize index; `agent/tools/search_documents.ts` is the tool. Needs `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_VECTORIZE_INDEX`.

**Ingestion is a separate, manual step** and lives outside this repo, in [gai-rag-skeleton](https://github.com/HamadaFMahdi/gai-rag-skeleton): put PDFs in its `corpus/`, `npm run ingest`. The agent only ever reads. Two things about it that cost real time:

- The skeleton reads `process.env` directly and **nothing loads its `.env`** — add `--env-file=.env` to its npm scripts or export the vars per shell. A missing `CF_VECTORIZE_INDEX` silently defaults to `my-rag-index`, so ingest fails with "index not found" rather than "you forgot a variable".
- Deleting a file from `corpus/` does **not** remove its vectors. Delete and recreate the index, and delete `ingest-log.jsonl` (ingest is resumable and skips anything logged).

`EMBED_MODEL` in `rag.ts` **must** match the model the corpus was ingested with. Mismatched models return confident nonsense rather than an error — the index's 768 dimensions exist because `@cf/baai/bge-base-en-v1.5` emits 768 numbers.

#### The relevance floor is the whole feature

`RELEVANCE_FLOOR = 0.75`, measured against this corpus rather than inherited from the 0.62 the brief suggested. A total miss sits at 0.58 (`bge` has a high similarity floor, so 0.58 is effectively zero, not "half relevant").

**Do not quote a comfortable range for real hits.** Most land 0.81–0.87, but the offline-playtime question is a genuine hit at **0.7512** — it clears the floor by 0.0012. Re-measure before repeating any range here; the numbers moved when the corpus was re-ingested at 200 words, and they moved *down* for that question. `rag.ts` carries the current measurements.

The number matters because of one case: **"what does the Borked rating mean?" retrieves Valve's Steam Deck compatibility docs at 0.64–0.74** — a different rating system from ProtonDB's, and nothing in the corpus defines ProtonDB's tiers because ProtonDB does not publish them. At 0.62 the agent answered it confidently and wrongly.

Two things that are easy to get wrong here:

- **Measure through the agent, not by querying the index.** The model rephrases the question before searching, and phrasing moves the score a long way — the same Borked question scored 0.6423 by hand and 0.7375 through the agent.
- **It gates the top score only**, deciding whether to answer at all. Filtering every chunk by it would be worse: two irrelevant chunks sit at 0.726 on the missing-games question, above any threshold that still admits the genuine secondary hits.

#### A weak search must not erase a good one

Observed live: search one cleared the floor with the right document, the model searched again, the second fell below, and it concluded the documents did not cover the question. The best search of a conversation is now kept in the session cache (`bestDocSearch`) and offered back whenever a later one finds nothing.

#### Prompting lessons, both learned the hard way

- Giving the model an **example refusal sentence** made it parrot that sentence identically for every question.
- Describing the qualities instead ("in your own words, do not reuse a stock phrase") made it **reason aloud about phrasing**, and that reasoning landed *inside* the final message where the render-time fix cannot reach it.

Terse rules plus an explicit "reply with the answer and nothing else" fixed both. If you loosen the tone guidance in `instructions.md`, expect the thinking to come back.

### Genre is not what people ask for; tags are

`agent/lib/tags.ts`. Steam's store genres are a short, coarse list - Action, Adventure, Indie, RPG, Strategy. Nobody asks for an Action game; they ask for something cosy, or a soulslike, or horror. Those are **tags**, and `appdetails` does not carry them, which is why a horror question was unanswerable until it did.

Two sources, split by what each is actually authoritative for:

- **Whether a tag exists** is Steam's own, from the 430-tag list the store's filters are built from.
- **Which games carry a tag** is SteamSpy, because **Steam publishes no per-game tag endpoint at all**.

SteamSpy's bulk list is noisy: everything tagged Horror is 10,896 games including Apex Legends and PUBG, because one stray vote counts. Its per-game data is good, because it has vote counts - Phasmophobia's top tag is Horror at 4,450 votes. So the bulk list only **orders** the scan, and every game actually offered must carry the tag inside its own top 8 by votes. `TAG_RANK_CEILING` is the entire defence against recommending Apex Legends as horror; do not raise it casually.

**A tag matches on whole name OR any word of it.** Steam has no single roguelike tag - it has Rogue-like, Rogue-lite, Action Roguelike and Roguelike Deckbuilder - so whole-name comparison meant Cult of the Lamb and Slay the Spire were not roguelikes. Matched per word rather than by substring, because "Art" is a real tag and a substring match finds it inside "Cartoon".

`bestTagMatch` is pure, takes the vocabulary as an argument and is unit-tested. Exact fold, then plurals, then bounded edit distance. **The first letter must agree**: without that, "action" is one edit from "Faction" and a player is silently handed a different tag. Four-character minimum, because "cosy" is four and is the case that started it.

The scan is bounded twice over - `TIME_BUDGET_MS` and `MAX_LOOKUPS` - because a word nobody owns otherwise walks the whole library while someone waits. Cutting it short changes what may be claimed, so `ranOut` and `failed` both feed the notes: "none of the ones I checked" and "none of your games" are different sentences.

### Interim narration must not reach the player

eve emits `message.completed` for interim narration as well as the final reply, so rendering every text part put the model's working-out in the transcript ("Let's do another query on why games might not work"). `app/page.tsx` treats any text part **before the last tool call** as deliberation and does not render it, and `hasVisibleText` counts only renderable text so narration cannot suppress `FallbackAnswer`.

This only catches narration in a *separate* part. Deliberation concatenated into the final message has to be prevented by the prompt — see above.

### Model fallback on rate limits

The free Gemini tier fails two ways that are transient and not the app's fault: `429 RESOURCE_EXHAUSTED` (per-minute or per-day cap) and `503 UNAVAILABLE` ("high demand"). Both were seen here — `gemini-3.5-flash-lite` returned 503 for a stretch while `gemini-3.5-flash` and `gemini-3.6-flash` answered normally throughout.

`agent/lib/model-fallback.ts` wraps the primary so a capacity error retries against the next model instead of killing the turn. Order is flash-lite → 3.5-flash → 3.6-flash, with 3.6 last because its free tier caps at 20 requests/day.

Two design points that are easy to get wrong:

- **It is a middleware, not a `defineDynamic` resolver.** The resolver picks the model *before* the provider call, so it cannot see a 429 — a resolver that throws just fails the turn. The AI SDK middleware wraps `doGenerate`/`doStream`, which is the only place the error is catchable. The resolver is still used, because eve only accepts a live `LanguageModel` object (rather than a model-id string) from the `step.started` scope.
- **Only capacity errors retry.** A 400 or a bad key will not do better elsewhere, and silently re-sending a malformed prompt to three models triples the cost of a real bug. A test pins that a 400 never reaches the backup.

The wrapper is built once at module scope; rebuilding it per step would discard the provider's prompt cache every time. Note that a fallback re-ingests the conversation uncached anyway — it is the right trade against failing, but a reason not to reorder the chain casually.

### Game artwork has no single reliable URL

Cards pull art straight from Valve's CDN (`cdn.akamai.steamstatic.com/steam/apps/{appid}/...`) with no API call. **No filename is guaranteed to exist.** Rhythia (appid 2250500) proves it: it 404s on `library_600x900.jpg`, `header.jpg` *and* both capsule sizes, yet serves `library_hero.jpg` fine.

So `artworkCandidates()` walks portrait → header → hero, advancing on each `onError`, and falls back to the game's name as text. Portrait first because the frame is shaped for it; the later two are landscape and get cropped by `object-cover`, which still reads as the game's art. Do not collapse this back to one URL.

**`MAX_GAMES` is duplicated in prose and has already drifted once.** The cap lives in `score_backlog.ts` and its tool description interpolates it, but `instructions.md`, README and this file all state it by hand. When it went 10 to 5 to 4, instructions.md was left saying 5 while the schema rejected anything above 4 — so a model following the instructions exactly would have had its tool call fail validation. Grep for "up to" in all three when changing it.

### One source of truth for categories

`agent/lib/categories.ts` holds the six categories' labels, descriptions and every numeric threshold. It has **zero imports** so that `app/page.tsx` (a `"use client"` component) can import it as safely as `scoring.ts` can. These were previously duplicated across `scoring.ts`, `page.tsx` and `instructions.md`, and the drift caused a real bug: the legend promised Quick Win meant "completable in eight hours or less", while `scoreGame` gated that category on completionist mode, so an achievement-less 3-hour game could never earn it. `instructions.md` is prose and still has to be updated by hand — it is the one remaining copy.

### Two output shapes per tool

`toModelOutput()` deliberately projects down what the *model* sees; the UI receives the full object on `part.output`. `score_backlog` uses this to withhold data the model shouldn't quote (see below). Changing one shape without the other silently breaks either the UI or the model's grounding.

### Hours-remaining is sometimes a floor, not an estimate

`estHoursRemaining` is linear extrapolation from achievement percentage. That collapses when the remaining achievements are rare — the last few in a completionist run are the hardest. When `avgRarityUnearned < 10`, `facts.remainingIsFloor` is set and **the linear figure is suppressed everywhere**: `templateReason` omits it, `quotableMetrics` drops it, and `toModelOutput` strips it so the model cannot quote it.

Suppression alone left ~45% of a real library with no time estimate at all, so `scarcityWeightedRemaining()` replaces it with a **range** (`estHoursRemainingLow` / `estHoursRemainingHigh`). It allocates HowLongToBeat's completionist total across the game's achievements in proportion to how scarce each one is, under two weightings — `-ln p` (gentle) and `p^-1.5` (steep) — which bracket the plausible answer. The spread is the message: reporting a midpoint would assert precision the data does not support. Real effect: Hollow Knight's single 5.3%-unlock achievement goes from "1h" to "2–4.3h"; Cult of the Lamb's nine at 2% from "4.8h" to "9.7–19.6h".

The steep exponent was 1 (a plain `1/p`) and was widened after checking both against real games: it capped Hollow Knight's last achievement — one of the hardest in the game — at 3.1h, and Sifu's remaining three at 1.8% unlock at 3.8h. Neither upper bound was credible. `-2` was rejected the other way, as it gave 4 of Neon White's 63 achievements 67% of the entire completionist time.

It returns null — falling back to the achievements-left count — when rarity data is missing, when the map covers under half the unearned achievements, or when it covers under half the game's total. That last guard matters: a map describing only the outstanding achievements would make them look like 100% of the work and hand over the entire completionist time.

**When the completionist budget is already spent, no hours figure is offered at all.** Every hours number here is a share of HowLongToBeat's completionist total: the linear one takes a percentage of it, the scarcity range reallocates it by rarity. Both assume that total still describes the work ahead. `facts.spentTheBudget` fires when playtime has passed it *and* achievements remain, and withholds all three figures. Raised against APB Reloaded: 4,059h played, a 145h completionist total, six achievements left, and the app answered "21 to 52h". What that state usually means is that the remainder is not time-gated at all — skill, luck, co-op partners who have moved on, an event that ended, or a player who simply does not chase achievements. Deliberately strict: it triggers on passing the whole total, not a fraction of it, because suppressing at 90% would strip estimates off most of a real library.

**Rarity is not difficulty, and the range cannot hide that.** It fails in both directions: an achievement is rare when it was added last month and nobody has reached it, and common when a dedicated fanbase all grind the same 200-hour challenge. The upper bound is additionally capped by HowLongToBeat's completionist total, so an enormous grind cannot be represented at all. The caveat and the README say this plainly, and the card is labelled "rarity-based" rather than "estimated" for the same reason. Bounds are rounded to whole hours above 10h: a tenth of an hour is a measurement, and this is a model.

**Don't replace this with a fixed difficulty multiplier, and don't add a third-party difficulty source.** Both were investigated. No source publishes per-achievement difficulty or time: Steam's `ISteamUserStats` exposes unlock percentage and nothing else; SteamHunters and AStats only restate that same rarity (SteamHunters' own docs say rarity is not difficulty); completionist.me and Exophase don't have the field. TrueSteamAchievements has crowd-voted difficulty but no API at all, HTML only, and its `robots.txt` opens with "go away". SteamHunters' `robots.txt` explicitly disallows ClaudeBot and reserves EU TDM rights; AStats tightened theirs specifically to stop bots. Scraping any of them is against their stated wishes, and the scarcity weighting above needs no new dependency.

### Built-in eve tools must be explicitly disabled

eve grants every agent `bash`, `read_file`, `write_file`, `web_fetch`, `web_search`, `todo`, `ask_question` and `agent` by default. Each is disabled by a `disableTool()` file in `agent/tools/` named after the tool. Only `ask_question` is left enabled, and it needs UI support (below).

`ask_question` has no `execute` — it parks the turn durably until a human answers. `InputRequestCard` in `app/page.tsx` renders the prompt and calls `agent.respond([{ requestId, optionId | text }])`. Without that the conversation hangs forever.

### Data sources

| Source | Auth | Notes |
| --- | --- | --- |
| `GetOwnedGames`, `GetPlayerAchievements` | Steam Web API key | No batch endpoint for achievements — one call per game |
| Global achievement rarity, ProtonDB, vanity resolution | none | Keyless |
| `appdetails` + `appreviews` (genre, rating) | none | `appdetails` does **not** batch; one appid per request |
| HowLongToBeat | none, but token-gated | Unofficial |
| Cloudflare Workers AI + Vectorize | `CF_API_TOKEN` | Embeddings and vector search over the document corpus |

**HowLongToBeat has no official API.** `agent/lib/playtime.ts` mirrors the site's own client: `GET /api/search/site/init` for a `{token, hpKey, hpVal}`, then `POST /api/search/site` with `x-auth-token`/`x-hp-key`/`x-hp-val` headers *and* `hpKey` echoed in the body, re-initialising once on 403. It is allowed to fail and returns "no data" rather than throwing.

Steam ships `™®©` in game names and HLTB does not — search terms are stripped of these or the game silently returns no hours. SteamSpy was evaluated as a fallback and rejected: it returns `0` playtime for every game.

### No database

`agent/lib/cache.ts` is a `Map` scoped by session id, held in the server process. It dies on restart. It is **bounded** — 50 sessions, 60-minute TTL, evicted lazily on access with no background timer — because it previously grew for the lifetime of the process, each entry holding a full library plus per-appid maps. `.eve/` is gitignored — it contains real conversation transcripts.

`pooled()` aborts every sibling if one worker rejects, which is the wrong failure mode for the achievement sweep — one bad response would discard hundreds of good lookups. `sweep_achievements` therefore uses `pooledSettled()` and reports a `failedLookups` count so a partial sweep is visible to the model and the player, rather than silently reading as "these games have no achievements".

### Citation is enforced, not requested

`agent/lib/citations.ts`, rendered in `page.tsx`. The model is asked to name the file it used and usually does; usually is the problem, because an uncited answer is indistinguishable from an invented one. `citationsToShow` returns the sources to print, or nothing if the answer already named one, and the line is rendered from the tool output.

Appended rather than substituted - a missing citation is not a false statement the way an ungrounded number is - and satisfied by ONE named source, because an answer often rests on one document even when the search returned two. Suppressed when grounding will replace the text, or the citation would be attached to a sentence that never used the document. Zero-import module so `page.tsx` can import it without pulling `rag.ts`'s Cloudflare path into the browser bundle.

### Failure states must stay distinguishable

`AchievementProgress.unknown` exists because collapsing every failure into `hasAchievements: false` made the app state a confident falsehood — a transient 500 produced the caveat "This game has no Steam achievements". A non-ok status, fetch error or parse failure now sets `unknown: true`, which `scoring.ts` turns into an honest "Steam did not return achievement data" caveat and `page.tsx` renders as "achievement data unavailable". Steam's 400 is genuinely ambiguous between "no achievements" and "private stats", so it counts as unknown.

**This is the bug the codebase keeps rediscovering, so assume it is present in any new lookup.** An audit found four more of it in one pass, every one shaped the same way — a failed, skipped or truncated lookup reported as a fact about the player:

- `getProtonRating` returned `null` both when ProtonDB had nothing and when it did not answer, so a game with hundreds of Linux reports was described as undocumented whenever it timed out. Now `ProtonLookup` is `ok | none | unknown`, with 404 meaning none and everything else meaning unknown. **Failures are never cached** — a failure describes the network a moment ago, not the game, and caching it freezes one blip into the whole conversation.
- `getGameDetails` swallowed a rejected `appdetails` call, leaving `genres: []` — byte for byte what a game with no genres returns. `lookupFailed` now separates them.
- `scannedEverything` meant "every game was attempted", not "every attempt succeeded", while telling the model its negative result was safe to state as fact.
- `facts.pastStoryEstimate` was originally `storyAlreadyBeaten` and claimed the story was finished because playtime exceeded HowLongToBeat's main-story estimate. **Playtime is not completion** — an explorer exceeds that estimate precisely because they have not finished. Steam does not publish story completion, so the app cannot say it. All it knows is that the estimate no longer describes this playthrough, and the hours figure is withheld rather than shown as `~0h`.

When adding any lookup, the question to ask is not "did I get data" but "can I tell an empty answer from no answer".

### Theming

Mirrors `../portfolio` exactly: Monkeytype `vesper_light`/`incognito` palettes, self-hosted Iosevka in `public/fonts/`, flat 8px radius. Uses `data-theme="light|dark"` on `<html>` with the `portfolio-theme` localStorage key — **not** shadcn's `.dark` class — so a theme choice carries between the two sites. The Tailwind `dark:` variant in `globals.css` is customised to match.

Category badge colours need a per-theme pair (`text-x-700 dark:text-x-400`). `bg-muted` is unusable for badges: in dark mode `--muted` equals the card background.

## Known issues / unfinished

- **eve's dev retry loop is understood and mostly defused** — see "Why the first turn is slow". The remaining unfixable part is a keep-alive mismatch: `@workflow/world-local` pools sockets for 30s (`keepAliveTimeout: 30000`, hardcoded) while eve's dev server is a stock Node server that closes idle sockets at 5s. Reproduced directly — a reused socket succeeds after 2s and 4s idle and gets `ECONNRESET` after 6s. Neither side is configurable. In practice it costs a 5s backoff occasionally rather than the storm it used to, because the raised transport timeouts stop the far more common cause. No official fix exists in eve 0.44.4.
- **Deployment.** Vercel should be a **new project** (not "new agent"); `withEve()` deploys the Next app and eve runtime as one project. Needs `STEAM_WEB_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` and the three `CF_*` vars set in Vercel. **Never set `EVE_BASE_URL` there** — it points at localhost.
- **ProtonDB's tiers are undocumented.** The cards print "Borked on Linux", and no first-party source defines Borked/Bronze/Gold/Platinum — checked all three ProtonDB help pages and `/contribute`. Valve documents *Steam Deck Verified*, a different system. The agent correctly says it does not know; adding a third-party explainer is the only fix, and it would not be authoritative.
- **Citation is prompted, not enforced.** The agent usually ends a document answer with `(source: file.pdf)`, but not always. The reliable fix is the same one used for grounding: render the sources under the answer from the tool output, rather than asking the model to remember.
- **Retrieval quality, not the threshold, is the real limit.** Genuine hits and near-misses overlap in the 0.73–0.76 band. Chunks are 200 words; a reranker (`@cf/baai/bge-reranker-base`, retrieve 20 → narrow to 5) or contextual retrieval would separate them properly.
- **Corpus PDFs carry reader-mode noise** — `about:reader?url=...` headers and page footers survive into chunks. Harmless but it wastes tokens and shows up in cited passages.
- **Auth is `none()`** in `agent/channels/eve.ts` — anyone with the URL can spend the Gemini quota, and the free tier's daily cap is low. Add auth before sharing the URL.
- **Model still occasionally re-calls tools** it already has results for, despite instructions and tool descriptions saying not to. This is why grounding is enforced in code rather than by prompting — the same unreliability applies to "only quote numbers you were given".
- **`ask_question` and the verify route are the remaining unauthenticated surfaces.** `app/api/steam/verify` now rate-limits to 10 requests/minute/IP, but that counter is per-process and therefore close to useless on serverless, where each instance keeps its own. It is a speed bump, not a control; real protection needs auth or a shared store.
- **HowLongToBeat may behave differently on Vercel** — its token is bound to caller IP, and serverless IPs are shared and rotate. Degrades to "no hours" rather than erroring.
- **The eve workshop upgrade is unpicked.** `approval: always()` was tried on `sweep_achievements` and reverted — these tools are read-only, so approval is friction without safety benefit. Remaining candidates are Skills (poor fit — logic is deterministic code, not procedural knowledge) or `defineState` (would replace the hand-rolled cache with durable framework state).
- **Steam Family Sharing is not feasible** as currently designed. `IFamilyGroupsService` endpoints exist but reject the Web API key (401) — they need a user access token, which would require Steam login and break the "any public profile, no login" design.

## Model

`gemini-3.5-flash-lite` with `reasoning: "low"`. `gemini-2.5-flash` is closed to new keys; `gemini-3.6-flash` works but free-tier keys get 20 requests/day, which one conversation exhausts. `scripts/smoke-keys.ts` lists what the current key can reach.

Every tool call is a model request. Prefer batching through `score_backlog` (handles up to 4 games in one call) over per-game tools.
