# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

A Steam backlog agent built on [eve](https://www.npmjs.com/package/eve) (Vercel's agent framework) + AI SDK + Next.js + AI Elements. Point it at any public Steam profile; it reports how far through each owned game you are and how much work is left.

Read `node_modules/eve/docs/` before writing agent code — eve is preview-stage and its API is not in training data. Start with `getting-started.mdx`, `tools/overview.mdx`, `concepts/built-in-tools.md`.

## Running it

**Two processes, in this order.** This is not the default `withEve()` setup — see "The retry loop" below for why.

```bash
# terminal 1 — eve on a FIXED port
WORKFLOW_LOCAL_BASE_URL=http://127.0.0.1:4278 npx eve dev --no-ui --port 4278

# terminal 2
npm run dev
```

`.env.local` must contain `EVE_BASE_URL=http://127.0.0.1:4278` for Next to proxy to that process instead of spawning its own. **Never set `EVE_BASE_URL` in production** — it points at localhost.

Restart the eve process after changing any env var or `agent/**` file; it reads `.env.local` once at spawn.

## Checks

```bash
npx tsc --noEmit                          # types
npx eslint app agent scripts              # lint
npx eve info                              # agent surface + diagnostics; run after touching agent/tools/
```

`eve info` reporting `0 errors` is meaningful proof for `disableTool()` files — eve fails discovery on an unrecognised tool name rather than silently ignoring it.

### Scripts (no test framework; these hit live APIs)

```bash
npx tsx scripts/smoke.ts [vanityOrSteamID64]   # keyless APIs + scoring logic, no keys needed
npx tsx scripts/smoke-keys.ts                  # validates both API keys, ~86 tokens
npx tsx scripts/time-sweep.ts [profile]        # times each data source end to end
```

They default to a public test profile; override with `SMOKE_STEAM_PROFILE` / `SMOKE_STEAM_ID`.

## Architecture

### The determinism contract

The core design constraint, spanning `agent/lib/scoring.ts`, `agent/tools/score_backlog.ts` and `agent/instructions.md`:

**The model performs no arithmetic and chooses no verdict.** `scoring.ts` computes every number and assigns one of seven fixed categories. The model receives that verdict as a fixed field and may only write a short sentence around it. `templateReason()` exists so the app still works correctly with zero useful LLM output.

When adding a metric, add it to `scoring.ts` — never let the model derive one.

### Two output shapes per tool

`toModelOutput()` deliberately projects down what the *model* sees; the UI receives the full object on `part.output`. `score_backlog` uses this to withhold data the model shouldn't quote (see below). Changing one shape without the other silently breaks either the UI or the model's grounding.

### Hours-remaining is sometimes a floor, not an estimate

`estHoursRemaining` is linear extrapolation from achievement percentage. That collapses when the remaining achievements are rare — the last few in a completionist run are the hardest. When `avgRarityUnearned < 10`, `facts.remainingIsFloor` is set and **the hours figure is suppressed everywhere**: the card shows achievements-left instead, `templateReason` omits it, and `toModelOutput` strips it so the model cannot quote it.

Don't "fix" this by inventing a difficulty multiplier — no source publishes per-achievement difficulty.

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

**HowLongToBeat has no official API.** `agent/lib/playtime.ts` mirrors the site's own client: `GET /api/search/site/init` for a `{token, hpKey, hpVal}`, then `POST /api/search/site` with `x-auth-token`/`x-hp-key`/`x-hp-val` headers *and* `hpKey` echoed in the body, re-initialising once on 403. It is allowed to fail and returns "no data" rather than throwing.

Steam ships `™®©` in game names and HLTB does not — search terms are stripped of these or the game silently returns no hours. SteamSpy was evaluated as a fallback and rejected: it returns `0` playtime for every game.

### No database

`agent/lib/cache.ts` is a `Map` scoped by session id, held in the server process. It dies on restart. `.eve/` is gitignored — it contains real conversation transcripts.

### Theming

Mirrors `../portfolio` exactly: Monkeytype `vesper_light`/`incognito` palettes, self-hosted Iosevka in `public/fonts/`, flat 8px radius. Uses `data-theme="light|dark"` on `<html>` with the `portfolio-theme` localStorage key — **not** shadcn's `.dark` class — so a theme choice carries between the two sites. The Tailwind `dark:` variant in `globals.css` is customised to match.

Category badge colours need a per-theme pair (`text-x-700 dark:text-x-400`). `bg-muted` is unusable for badges: in dark mode `--muted` equals the card background.

## Known issues / unfinished

- **eve's dev retry loop is mitigated, not fixed.** `withEve()` spawns eve on `--port 0` and never tells the child its own address, so `@workflow/world-local` re-discovers its port via `netstat` plus a 500ms probe race on *every* queue delivery. Under Turbopack compile load the probe misses and turns hang with `TypeError: fetch failed`. The fixed-port setup above avoids it (2 retries per turn vs dozens). No official fix exists in eve 0.44.4 — verified against its docs and changelog.
- **Not deployed.** Vercel should be a **new project** (not "new agent"); `withEve()` deploys the Next app and eve runtime as one project. `npx next build` passes locally.
- **Auth is `none()`** in `agent/channels/eve.ts` — anyone with the URL can spend the Gemini quota, and the free tier's daily cap is low. Add auth before sharing the URL.
- **Model still occasionally re-calls tools** it already has results for, despite instructions and tool descriptions saying not to.
- **HowLongToBeat may behave differently on Vercel** — its token is bound to caller IP, and serverless IPs are shared and rotate. Degrades to "no hours" rather than erroring.
- **The eve workshop upgrade is unpicked.** `approval: always()` was tried on `sweep_achievements` and reverted — these tools are read-only, so approval is friction without safety benefit. Remaining candidates are Skills (poor fit — logic is deterministic code, not procedural knowledge) or `defineState` (would replace the hand-rolled cache with durable framework state).
- **Steam Family Sharing is not feasible** as currently designed. `IFamilyGroupsService` endpoints exist but reject the Web API key (401) — they need a user access token, which would require Steam login and break the "any public profile, no login" design.

## Model

`gemini-3.5-flash-lite` with `reasoning: "low"`. `gemini-2.5-flash` is closed to new keys; `gemini-3.6-flash` works but free-tier keys get 20 requests/day, which one conversation exhausts. `scripts/smoke-keys.ts` lists what the current key can reach.

Every tool call is a model request. Prefer batching through `score_backlog` (handles up to 20 games in one call) over per-game tools.
