# Finish Line

Point it at any public Steam profile and it tells you which games you already own are closest to being finished, how much you roughly have left, and which ones are actually worth finishing next.

Steam knows how many achievements you have. HowLongToBeat has estimates for completion times. ProtonDB knows whether it works properly on Linux. None of them really combine information into an answer to something like "what game in my library should I actually finish?". That is basically what this project does.

It is built using [eve](https://www.npmjs.com/package/eve) (Vercel's agent framework), the AI SDK, Next.js and AI Elements.

---

## Why this exists

This project was built as part of the [Governance AI](https://governanceai.io) Mini CTO Programme as part of a task to build an LLM-based application.

The goal was to build something that used an LLM alongside real external data rather than relying on the model alone. Finish Line combines Steam library and achievement data with HowLongToBeat estimates, ProtonDB compatibility information, and a small documentation corpus to help decide what game in a Steam library is worth finishing next.

## What it can do

- Find the games in your library that you are closest to finishing
- Estimate how much work you actually have left
- Account for cases where the achievements you have left are much rarer than the ones you already completed
- Find games you could realistically finish over a weekend
- Score story progress separately from achievement progress when that is what you care about
- Suggest games that you own but have never launched
- Filter games by Steam genre, Steam tag (horror, cosy, souls-like) or review score, correcting near-miss spellings, and say plainly when Steam has no such category
- Show Linux and Steam Deck compatibility using ProtonDB
- Answer questions about Steam, Proton, and ProtonDB using a small reference-document corpus

It also tries not to pretend it knows things that it does not.

If HowLongToBeat has no useful data for a game, Steam fails to return something, or there is simply no sensible way to estimate how long an achievement grind will take, the app says so instead of making it up.

## Example prompts

| Ask                                                          | What it does                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| "What should I finish?"                                      | Checks achievement progress across played games, scores the best candidates and recommends one |
| "What can I beat this weekend? I only care about the story." | Uses story-progress scoring instead of achievement completion                                  |
| "What should I play next?"                                   | Looks at games you own but have never launched                                                 |
| "Give me something horror-ish I haven't started."            | Horror is a Steam tag rather than a genre, so it searches tags and returns real horror games    |
| "Do I own any roguelikes? Include ones I have played."       | Searches the whole library rather than only unstarted games                                     |
| "Find me a rougelike I have not started."                    | Corrects the spelling against Steam's own tag list before searching                             |
| "Something well-reviewed and short."                         | Combines Steam review scores with completion-time estimates                                    |
| "How far through Hollow Knight am I?"                        | Scores just Hollow Knight instead of searching the whole library                               |
| "Does Sifu work on Linux?"                                   | Returns its ProtonDB compatibility tier                                                        |
| "Why is a game missing from my library?"                     | Searches the reference documents and answers using the relevant source                         |
| "What does the Borked rating mean?"                          | Refuses to answer if the documentation available to it does not define it                      |

The same applies to anything else it cannot ground in one of its tools. For example, it cannot tell you what you paid for a game because it has no pricing data.

## Categories

Every scored game is assigned exactly one category based on how much work is left:

| Category          | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| Finish Line       | At least 60% complete with roughly five hours or less remaining           |
| Quick Win         | Can be completed in eight hours or less                                   |
| Rarity Wall Ahead | Most of what remains consists of globally rare achievements               |
| Keep Going        | Already started with meaningful progress but still has a fair amount left |
| Never Started     | Owned but never launched                                                  |
| Long Haul         | More than thirty hours remaining                                          |

Linux support is kept separate from this.

For example, a game can be almost finished while also being broken on Linux. Those are two different pieces of information, so the app does not try to combine them into one category.

## Tools

| Tool                    | What it does                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `resolve_steam_profile` | Converts a vanity name, Steam profile URL or SteamID64 into a SteamID64 and checks whether the profile is public |
| `get_library`           | Gets the user's full Steam library and playtime                                                                  |
| `sweep_achievements`    | Checks achievement completion across every played game and streams progress                                      |
| `score_backlog`         | Calculates all scoring values and assigns categories for up to 4 games                                          |
| `suggest_unstarted`     | Finds games by Steam genre or tag, correcting near-miss spellings. Unstarted by default, or the whole library    |
| `get_game_details`      | Gets genres and Steam review ratings for up to 6 games in one call                                               |
| `get_playtime_estimate` | Gets estimated story and 100% completion times                                                                   |
| `get_proton_rating`     | Gets the ProtonDB compatibility tier                                                                             |
| `search_documents`      | Searches the local reference corpus for Steam, Proton and ProtonDB information                                   |
| `ask_question`          | An eve built-in that pauses the turn and asks you, with buttons to press or a box to type in                     |

eve normally gives an agent several built-in tools:

`bash`, `read_file`, `write_file`, `web_fetch`, `web_search`, `todo` and `agent`.

All of those are explicitly disabled in this project using files under `agent/tools/`.

The agent does not need unrestricted filesystem or web access, so I would rather not give it those capabilities at all. `ask_question` is the only built-in tool that remains enabled.

## Keeping the model from making things up

There are three main rules behind the architecture.

### The model does not calculate scores or choose categories

Anything numerical that affects the result is handled by normal deterministic TypeScript.

The model receives the calculated numbers and the category rather than being asked to work them out itself.

### Model output is checked before it is shown

Any figure the model quotes about a game is checked against the result the scorer actually produced, and the value, the unit and the metric all have to match.

For example, if it says there are "90 achievements left" when 90 was the number already earned, that fails. The number is real, the unit is right, and it is still the wrong claim.

If the sentence cannot be grounded, it is replaced by a deterministic one built from the same figures.

Two things it deliberately does not do. Numbers with no unit are ignored, because most of them here are titles rather than claims: "Portal 2" is not an assertion about anything. And the check needs a scorer result to compare against, so it covers answers about your games rather than answers drawn from the documents, which are checked for their citation instead.

### Unknown values stay unknown

One problem with achievement completion is that percentages can be misleading.

If you have completed 95% of the achievements, that does **not** necessarily mean you have completed 95% of the work.

The last few achievements may be significantly harder or rarer than everything before them.

Because of that, the app does not simply calculate:

```text
5% achievements remaining = 5% of completion time remaining
```

For rarer achievements, the estimated completion time is redistributed based on achievement scarcity and returned as a range instead.

The range is deliberately wider when the estimate is less certain.

Failed lookups are handled similarly.

"This game has no achievements" and "Steam failed to return achievement information" are not treated as the same thing.

## Answering things the APIs cannot

Steam's APIs are useful for things like your library, playtime and achievements.

They are not very useful for questions such as:

- Why is a game missing from my library?
- What exactly gets shared through Steam Families?
- Why might a game not work through Proton?

For those questions, the project has a small reference corpus made from twelve Valve and ProtonDB documentation pages saved as PDFs.

This is handled using retrieval-augmented generation (RAG).

Each document is split into chunks of 200 words, overlapping by 40 so a sentence is not cut in half at a boundary. An embedding model converts each chunk into a vector containing 768 numbers representing its meaning, which are stored in a vector index.

When the user asks a documentation-related question, the question is embedded in the same way and compared against the stored chunks. The most similar chunks are returned and included in the model's context.

The model can then answer using those passages and include the source document it used.

### Similarity thresholds

A vector search will almost always return *something*, even if nothing in the corpus actually answers the question.

That means "closest result" is not necessarily the same as "relevant result".

To deal with this, document search uses a similarity threshold.

If the best matches fall below it, the app treats the corpus as not containing enough information and refuses to answer.

This mattered more than I expected.

For example, asking "What does the Borked rating mean?" can retrieve Valve's Steam Deck Verified documentation because it is semantically related to compatibility ratings.

The problem is that Steam Deck Verified is a completely different rating system, and the available ProtonDB documentation does not actually define the Borked tier.

Without a sufficiently strict threshold, the agent can use the wrong document and produce a convincing but incorrect explanation.

I tested the threshold against the corpus rather than just picking an arbitrary value. The floor is 0.75. A complete miss sits at around 0.58, and the Borked question peaks at about 0.74, which is why the 0.62 I started with was not strict enough.

Genuine matches mostly land between 0.81 and 0.87, but not all of them. "How is playtime recorded if I play offline?" is a real question the documents do answer, and it scores 0.7512, clearing the floor by roughly a thousandth. The margin between answering correctly and refusing wrongly is that thin, and it is luck rather than design.

Document ingestion is also separate from the agent itself. The agent only reads from the finished vector index.

### Building the index

Ingestion is handled separately using [gai-rag-skeleton](https://github.com/HamadaFMahdi/gai-rag-skeleton). This app only reads from the finished index.

To rebuild it, put the PDFs in that repo's `corpus/` folder and run:

```bash
CHUNK_WORDS=200 OVERLAP_WORDS=40 npm run ingest
```

Both variables matter. The skeleton defaults to 500-word chunks with 50 words of
overlap, so leaving them out builds a different index from this one and the
relevance scores move with it. The 0.75 floor in `agent/lib/rag.ts` was measured
against a 200-word index.

Both numbers are checkable rather than remembered. Every chunk the index returns
is 200 words, apart from the tail of a document, and adjacent chunks from the
same file share exactly 40 words at the boundary.

The corpus I used contains twelve pages of Valve and ProtonDB documentation saved as PDFs. They are not committed here because they are not mine to redistribute.

All twelve are public help pages, saved to PDF from a browser. The Steam ones
come from Valve's own support and Steam Deck pages, the Proton ones from the
Proton project and ProtonDB's site. Print to PDF rather than screenshotting: the
text has to be selectable or nothing gets extracted.

These are the twelve files the current index was built from, so a rebuild that
matches it needs the equivalent page saved under each name:

| File | What it covers |
| --- | --- |
| `steam-missing-games.pdf` | Why an owned game does not appear in the library |
| `steam-families.pdf` | Steam Families, and what is and is not shared |
| `steam-private-games.pdf` | Marking games private, and profile privacy settings |
| `steam-achievements.pdf` | Achievements and global unlock percentages |
| `steam-cloud.pdf` | Steam Cloud saves |
| `steam-offline-mode.pdf` | Offline mode, and how playtime is recorded |
| `steamdeck-verified.pdf` | The Steam Deck Verified categories |
| `steamdeck-compat-review.pdf` | How Valve reviews a game for Deck compatibility |
| `proton-readme.pdf` | What Proton is and what it can run |
| `protondb-performance.pdf` | ProtonDB performance reports |
| `protondb-site-questions.pdf` | ProtonDB's own site and FAQ |
| `protondb-troubleshooting.pdf` | Common Proton problems and fixes |

The filenames are what the agent cites, so keeping them is what makes a citation
mean anything. Note what is deliberately absent: nothing here defines ProtonDB's
Platinum through Borked tiers, because ProtonDB does not publish them. That gap
is the reason the relevance floor exists.

The PDFs need to contain actual text rather than just scanned images, otherwise there is nothing for the ingestion script to extract and embed.

A few things to watch out for:

- The skeleton reads from `process.env` directly and does not automatically load `.env`. Either add `--env-file=.env` to the scripts or export the variables in your shell first. If `CF_VECTORIZE_INDEX` is missing, it falls back to `my-rag-index`, which can make the resulting `index not found` error a bit misleading.

- Removing a file from `corpus/` does not remove its existing vectors. To fully rebuild the corpus, recreate the index and delete `ingest-log.jsonl` as well, since ingestion is resumable and skips files that are already logged.

- The embedding model must match the one used when the index was created. `@cf/baai/bge-base-en-v1.5` produces 768-dimensional embeddings, so the index also needs 768 dimensions. A mismatch does not raise an error, it just returns confidently wrong matches.

The index can also take around a minute to finish syncing after ingestion, so querying it immediately may return results from an incomplete index.

## Running it

Copy `.env.example` to `.env.local` and add the required values:

| Variable                       | Needed for                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `STEAM_WEB_API_KEY`            | Steam library and achievement data. Available free from [Steam](https://steamcommunity.com/dev/apikey) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | The chat model                                                                                         |
| `CF_ACCOUNT_ID`                | Document search. Available from the Cloudflare dashboard                                               |
| `CF_API_TOKEN`                 | Document search. Requires Workers AI Read and Vectorize Edit permissions                               |
| `CF_VECTORIZE_INDEX`           | Name of the Vectorize index containing the ingested corpus                                             |
| `EVE_BASE_URL`                 | Optional. Used locally to point Next.js at an eve process you started manually                         |
| `SMOKE_STEAM_PROFILE`          | Optional. Overrides the Steam profile used by test scripts                                             |
| `SMOKE_STEAM_ID`               | Optional. Same thing, using a SteamID64                                                                |

The app still works without the three `CF_` variables.

The only difference is that `search_documents` reports itself as unavailable. Those variables also need to point at an index that has already been built. See [Building the index](#building-the-index).

Then start eve and the Next.js app in separate terminals:

```bash
# eve, using a fixed port and longer transport timeouts

WORKFLOW_LOCAL_BASE_URL=http://127.0.0.1:4278 \
WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS=600000 \
WORKFLOW_LOCAL_BODY_TIMEOUT_MS=600000 \
  npx eve dev --no-ui --port 4278
```

```bash
# Next.js app

npm run dev
```

You can optionally run this once afterwards:

```bash
npx tsx scripts/warm-eve.ts
```

This triggers eve's cold-start compilation before the first real user request instead of making the first question pay the cost.

### Scripts

| Command                                   | What it does                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`                             | Starts the Next.js development server                                          |
| `npm run build`                           | Creates a production build                                                     |
| `npm run start`                           | Runs the production build                                                      |
| `npm run lint`                            | Runs ESLint                                                                    |
| `npx tsc --noEmit`                        | Runs the TypeScript type checker                                               |
| `npx tsx scripts/test-logic.ts`           | Tests deterministic scoring logic without requiring API keys or network access |
| `npx tsx scripts/smoke.ts [profile]`      | Runs the keyless API and scoring path end-to-end against a real Steam profile  |
| `npx tsx scripts/smoke-keys.ts`           | Checks that both API keys work                                                 |
| `npx tsx scripts/time-sweep.ts [profile]` | Measures how long each data source takes                                       |
| `npx tsx scripts/warm-eve.ts [baseUrl]`   | Triggers eve's cold start ahead of time                                        |

Scripts that accept `[profile]` require a Steam profile with its profile and game details set to public.

Either pass the profile manually or configure `SMOKE_STEAM_PROFILE`.

The old built-in test profile is no longer reliable because its owner changed their game-details privacy setting to friends-only.

More development notes, architecture decisions and known issues are in [CLAUDE.md](./CLAUDE.md).

## Running costs and state

### Model fallback

Gemini's free tier can temporarily fail with either:

- `429` when a rate limit or quota is reached
- `503` when the model is temporarily unavailable

I ran into both while developing the project.

There is middleware that catches capacity-related failures and retries the request using the next model in the configured fallback chain.

Only capacity-related errors are retried.

Things like invalid requests are not retried against another model because doing the same broken request again is not going to fix it.

### No database

There is currently no database.

Session data is stored in an in-process map with:

- a maximum of 50 sessions
- a 60-minute expiry

Everything disappears when the server process stops.

This also means refreshing the page effectively starts a new session.

### Rate limiting

The profile lookup endpoint is limited to 10 requests per minute per IP.

This is an in-memory rate limit, so it should not be treated as serious abuse protection in a serverless environment where separate instances may each have their own counters.

There is also currently no authentication, meaning somebody with access to the deployed app could consume the configured Gemini quota.

## Limitations

### HowLongToBeat is unofficial

HowLongToBeat does not provide a public API.

The project therefore uses a client that mirrors the API used by the website itself.

That can change or break without warning.

If it does break, the app reports that no completion-time data is available rather than trying to guess.

### Completion times are estimates

HowLongToBeat values are estimates to begin with, and the rare-achievement calculation is even less certain.

There is no reliable public dataset containing the amount of time required for every individual achievement. Steam publishes how many players hold one, and nothing else.

So the range is scaled from how rare the remaining achievements are, not from how hard they are, and rarity is a poor stand-in for difficulty in both directions. An achievement can be rare because it was added recently and nobody has reached it yet, and it can be common because a game has a dedicated fanbase who all grind the same hundred-hour challenge. The upper bound is also capped by HowLongToBeat's 100% time, so a genuinely enormous grind cannot be represented at all.

Treat it as a rough range rather than a prediction. The width is there to say the answer is uncertain, not to bracket it precisely.

There are two cases where no figure is offered at all.

Every hours number is a share of HowLongToBeat's completionist total, so once you have already played longer than that total and still have achievements outstanding, none of them mean anything. The card then shows how many achievements are left and says why there is no estimate.

The same goes for story time. If you have played longer than the main-story estimate, that estimate no longer describes your playthrough, so no figure is given. What it does not do is conclude that you finished the story: you can put three times the estimate into exploring and still be halfway through, and Steam does not publish story completion for anyone to check.

### Steam profiles need to be public

The Steam profile must be public and **Game Details** must also be public.

Steam treats those as separate privacy settings.

### It cannot tell you whether a game is actually good

The app can tell you things like:

- how much you have played
- how far through the achievements you are
- approximately how much time you have left
- Steam review statistics
- whether it works on Linux

It cannot decide whether you personally think the game is good.

That part is still your problem.