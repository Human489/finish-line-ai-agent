# Finish Line

Point it at any public Steam profile and it tells you which of the games you **already own** you are closest to finishing, and what the last stretch will actually cost you.

Steam knows how many achievements you have. HowLongToBeat knows how long a game takes. ProtonDB knows whether it runs on Linux. Nobody joins those up, so "what should I actually finish?" is a question your library cannot answer. This does that join, and — more importantly — it refuses to guess when the data will not support an answer.

Built with [eve](https://www.npmjs.com/package/eve) (Vercel's agent framework), the AI SDK, Next.js and AI Elements.

---

## Why this exists

This is a learning project. I wanted to understand what building an LLM agent is actually like — not the demo version, the version where real APIs return nothing, where the model confidently invents a statistic, and where the interesting engineering turns out to be about **what the model is not allowed to do**.

It was also written *with* AI, deliberately and throughout, as a way of learning how that collaboration works: where it is fast, where it needs to be held to account, and how much of the work is deciding what "correct" means before any code gets written.

The most useful thing I learned is in the architecture below. An agent that can freely do arithmetic will do arithmetic wrong, occasionally and unpredictably, and it will sound completely certain while doing it. So in this app the model does none. Every number and every verdict is computed by ordinary deterministic TypeScript; the model chooses which games to look at and writes one sentence about the result — and even that sentence is checked against the real figures before it reaches you.

## What it can do

- **Find what you are closest to finishing**, ranked, across your whole library
- **Estimate what is actually left** — including the hard case where the achievements you have left are ones almost nobody unlocks
- **Tell you what you can beat this weekend**, measured on story completion rather than achievements
- **Suggest something new to start** from the games you have never launched
- **Filter by genre or review score** using real Steam store data rather than guessing from a title
- **Report Linux/Steam Deck compatibility** from ProtonDB as context on any recommendation

And, just as deliberately, it will tell you when it **cannot** answer: a game HowLongToBeat has never heard of, a Steam lookup that failed, an achievement grind whose length genuinely cannot be known.

### Example prompts

| Ask | What happens |
| --- | --- |
| *"What should I finish?"* | Sweeps achievements across every played game, scores a shortlist, and names one pick |
| *"What can I beat this weekend? I only care about the story."* | Switches to story-progress scoring and ignores achievements entirely |
| *"What should I play next?"* | Looks only at games you have never launched |
| *"Give me something horror-ish I haven't started."* | Checks real Steam genres before recommending, and says so plainly if nothing matches |
| *"Something well-reviewed and short."* | Combines Steam review scores with hours-to-beat |
| *"How far through Hollow Knight am I?"* | Skips the sweep and scores that one game |
| *"Does Sifu work on Linux?"* | Reports the ProtonDB tier |

It will decline anything it cannot ground in a tool call — including how much a game cost, since it has no pricing data of any kind.

## The categories

Every scored game gets exactly one, and each is only ever about **how much work is left**:

| Category | Meaning |
| --- | --- |
| **Finish Line** | 60%+ done, about five hours or less left |
| **Quick Win** | Completable in eight hours or less |
| **Rarity Wall Ahead** | What is left is globally rare, so the last stretch is a grind |
| **Keep Going** | Started, real progress, more to do |
| **Never Started** | Owned, never launched |
| **Long Haul** | More than thirty hours remaining |

Linux support is reported alongside but is never a category — a game can be nearly finished *and* broken on Linux, and both facts should survive.

## The tools

| Tool | Does |
| --- | --- |
| `resolve_steam_profile` | Vanity name, profile URL or SteamID64 → SteamID64, and whether the profile is public |
| `get_library` | The whole library with playtime, in one call |
| `sweep_achievements` | Achievement completion across every played game, streamed with live progress |
| `score_backlog` | The verdict tool — computes every number and assigns the category for up to 10 games |
| `suggest_unstarted` | Games with zero playtime |
| `get_game_details` | Genres and Steam review rating |
| `get_playtime_estimate` | Hours to beat and to 100% for one game |
| `get_proton_rating` | ProtonDB compatibility tier |

## How it stays honest

Three ideas do most of the work:

**The model performs no arithmetic and picks no verdict.** All of it is deterministic code. The model receives finished numbers and a fixed category.

**What the model writes is verified before you see it.** Every statistic in its sentence is checked against the figures the scorer actually produced — with its units, and bound to the right metric, so "90 achievements left" is caught when 90 was the number *earned*. Ungrounded prose is replaced with a deterministic sentence rather than shown.

**A number that cannot be known is not invented.** When the achievements you have left are rare, a flat "5% left means 5% of the time left" is badly wrong — the last few are the hardest by a wide margin. Rather than state a figure or refuse outright, the remaining completionist time is reallocated by how scarce each achievement is, and reported as a **range**. The width is the point: it is how the app says "genuinely uncertain" without pretending otherwise.

Failed lookups are never rounded off into facts, either. "This game has no achievements" and "Steam did not answer" are different sentences, and the app says whichever is true.

## Running it

Needs a free [Steam Web API key](https://steamcommunity.com/dev/apikey) and a Google AI API key in `.env.local`. Then, in two terminals:

```bash
# eve, on a fixed port, with the transport timeouts raised
WORKFLOW_LOCAL_BASE_URL=http://127.0.0.1:4278 \
WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS=600000 \
WORKFLOW_LOCAL_BODY_TIMEOUT_MS=600000 \
  npx eve dev --no-ui --port 4278

# the app
npm run dev
```

Then optionally `npx tsx scripts/warm-eve.ts` once, which pays eve's cold-start compile so your first question does not.

```bash
npx tsx scripts/test-logic.ts   # assertions over the deterministic logic; no keys, no network
npx tsc --noEmit                # types
npx eslint app agent scripts    # lint
```

Development notes, the reasoning behind the architecture, and the known issues live in [CLAUDE.md](./CLAUDE.md).

## Limitations worth knowing

- **HowLongToBeat is unofficial.** It has no public API; the client here mirrors the site's own. It can break without notice, and when it does the app reports no hours rather than guessing.
- **Hours are an estimate, and rare-achievement hours are a wide one.** Nobody publishes per-achievement difficulty — not Steam, not the community trackers — so the range is a model, not a measurement.
- **The profile must be public**, including its game details, which is a separate Steam privacy setting.
- **It has no idea whether a game is any good.** It knows how far through it you are. Opinions about quality are not its to give.
