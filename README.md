# Finish Line

Point it at any public Steam profile and it tells you which owned games you are
closest to finishing, and what the last mile will actually cost.

Built with [eve](https://www.npmjs.com/package/eve), the AI SDK, Next.js and AI Elements.

## Setup

Two free keys, both server-side only:

```bash
cp .env.example .env.local
```

| Variable | Where to get it |
| --- | --- |
| `GOOGLE_GENERATIVE_AI_API_KEY` | https://aistudio.google.com/apikey |
| `STEAM_WEB_API_KEY` | https://steamcommunity.com/dev/apikey |

Then:

```bash
npm run dev
```

**Restart the dev server after changing any env var.** `withEve` runs the eve
runtime as a separate process that reads `.env.local` once at spawn, so Next
will see a new key while eve does not — which surfaces as Google's
`"method doesn't allow unregistered callers"`.

Check both keys without spending anything meaningful (~86 tokens):

```bash
npx tsx scripts/smoke-keys.ts
```

It also prints every `gemini-3.x` model the key can reach and confirms the one
in `agent/agent.ts` is among them. `gemini-2.5-flash` is closed to new API
keys. `gemini-3.6-flash` works but free-tier keys get only 20
requests/day — one conversation's tool loop exhausts that immediately — so the
agent runs on **`gemini-3.5-flash-lite`**, whose free tier is far higher and is
plenty for narrating over data `score_backlog` already computed.

"Gemini 3 Flash Live" is not an option here despite the similar name: it is
`gemini-3.1-flash-live-preview`, which only supports `bidiGenerateContent` — the
realtime audio/video API — not `generateContent` with tool calling, which this
agent needs.

The Steam key is unavoidable: there is no keyless route to a user's library or
achievements. It is read in server-side tool code only and never reaches the
browser.

## Using it

The first screen asks for a Steam profile before any prompting, and verifies it
via `POST /api/steam/verify` before letting you continue. That route checks
three separate things that would otherwise only fail mid-conversation:

1. the profile resolves at all,
2. its `privacyState` is `public`,
3. Steam will actually return its library — a profile can be public while its
   *game details* are private, which is a different setting.

A missing `STEAM_WEB_API_KEY` also surfaces here rather than during a turn.

On success the resolved SteamID64 is handed to the agent directly, so it never
has to guess at a vanity name. The profile is held in React state only and is
attached to the first message of the conversation; **change** in the header
resets both it and the session. Refreshing the page clears everything.

The first question sweeps achievements across every played game, which streams
live progress and takes a moment on a large library. Everything after that is
served from the per-conversation cache and is instant.

## How it works

The model does no arithmetic and picks no verdicts. `agent/lib/scoring.ts`
computes every number and assigns every category deterministically; the model
receives the result as a fixed field and may only write one short sentence
around it. Any number it writes is checked against the numbers the scorer
actually produced, and there is a template fallback so the app still works
correctly with zero useful LLM output.

### Tools

| Tool | Does | Needs a key |
| --- | --- | --- |
| `resolve_steam_profile` | Vanity name / URL / SteamID64 → SteamID64 + privacy state | No |
| `get_library` | Whole library with names and playtime, in one call | Yes |
| `sweep_achievements` | Achievement completion across every played game | Yes |
| `get_playtime_estimate` | Hours to beat and to 100% from HowLongToBeat | No |
| `get_proton_rating` | ProtonDB Linux compatibility tier | No |
| `suggest_unstarted` | Owned games never launched | Yes |
| `score_backlog` | All the arithmetic, and the final verdict | Yes |

### Categories

Assigned deterministically, first match wins: **Proton-Blocked**, **Never
Started**, **Finish Line** (60%+ done, ≤5h left), **Quick Win** (≤8h to 100%),
**Rarity Wall Ahead** (remaining achievements average <10% global unlock),
**Long Haul** (>30h left), **Keep Going**.

## Design notes

**Full sweep, not triage.** Achievement data has no batch endpoint, so a full
library pass is one keyed call per played game. That is ~0.3% of the 100k/day
quota, and it runs once per conversation and is cached, so every follow-up
question is instant. Accuracy was chosen over speed deliberately.

**Rate limits.** The daily quota is not the constraint; undocumented burst
throttling is. Calls are pooled at 10 concurrent with backoff on 429.

**No database.** The per-conversation cache in `agent/lib/cache.ts` is a Map in
the server process, scoped by session id. Nothing is persisted; it dies with the
process.

**Playtime is the fragile part.** HowLongToBeat has no official API. Its search
endpoint needs a short-lived token bound to caller IP and User-Agent plus a
per-request challenge pair, obtained from `/api/search/site/init`. The handshake
in `agent/lib/playtime.ts` mirrors the site's own client and re-inits once on a
403, but it can break without notice. Every failure path returns "no data" and
the agent is instructed to say so rather than guess.

SteamSpy was evaluated as a fallback and rejected: `median_forever` and
`average_forever` return `0` for every game tested, so it carries no playtime
signal any more.

**ProtonDB is context, never a verdict.** A Bronze game is still worth
finishing. Only Borked blocks anything.

## Verifying the data layer

`scripts/smoke.ts` exercises the live APIs and the scoring logic without needing
either key:

```bash
npx tsx scripts/smoke.ts
```

## Deploying

The channel in `agent/channels/eve.ts` admits anonymous traffic via `none()`,
which is appropriate for a public demo that reads only public Steam data and
stores nothing. Replace it with a real authenticator before putting private data
behind this agent. Set both env vars in the Vercel project.
