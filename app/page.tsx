"use client";

import type { EveMessage } from "eve/client";
import { useEveAgent } from "eve/react";
import { useState, type FormEvent } from "react";
import {
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  type Category,
} from "@/agent/lib/categories";
import { findUngroundedNumbers, quotableMetrics, type ScoredGame } from "@/agent/lib/scoring";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * The six categories score_backlog can assign. Labels and descriptions
 * come from agent/lib/categories.ts — the single source of truth, imported
 * above — so they can no longer drift from scoring.ts the way they did
 * before (Quick Win's stated definition not matching what scoreGame actually
 * awarded). Only the Tailwind classes stay local: they are presentational
 * and have no server-side equivalent to drift from.
 */
const CATEGORY_ORDER: Category[] = [
  "finish-line",
  "quick-win",
  "rarity-wall-ahead",
  "keep-going",
  "never-started",
  "long-haul",
];

const CATEGORY_CLASSNAMES: Record<Category, string> = {
  "finish-line": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  "quick-win": "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  // amber-800, not -700: at badge size -700 measured 4.48:1 on the light
  // card, just under the 4.5 needed for small text.
  "rarity-wall-ahead": "bg-amber-500/15 text-amber-800 dark:text-amber-400",
  "keep-going": "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  // Not bg-muted: in dark mode --muted is #151515, the same value as the
  // card background, so the badge disappeared entirely.
  "never-started": "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
  // orange-800 for the same reason as amber above (-700 measured 4.43:1).
  "long-haul": "bg-orange-500/15 text-orange-800 dark:text-orange-400",
};

const CATEGORIES: { label: string; description: string; className: string }[] =
  CATEGORY_ORDER.map((category) => ({
    label: CATEGORY_LABELS[category],
    description: CATEGORY_DESCRIPTIONS[category],
    className: CATEGORY_CLASSNAMES[category],
  }));

const CATEGORY_STYLE = new Map(CATEGORIES.map((c) => [c.label, c.className]));

function CategoryLegend() {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            Categories
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80">
        <div className="space-y-3">
          <p className="text-sm font-medium">What the categories mean</p>
          <dl className="space-y-2.5">
            {CATEGORIES.map((category) => (
              <div key={category.label}>
                {/* Same badge styling as the result cards, so the colour in
                    the legend is recognisably the colour on the card. */}
                <dt>
                  <Badge className={category.className}>{category.label}</Badge>
                </dt>
                <dd className="mt-1 text-sm text-muted-foreground">
                  {category.description}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const SUGGESTIONS = [
  "What should I finish?",
  "What game should I start next?",
  "What can I beat this weekend?",
];

/**
 * The resolved SteamID64 is prepended to the first message so the agent gets an
 * exact identifier instead of guessing at a vanity name. It is plumbing, not
 * something the user typed, so it is stripped back out when rendering.
 */
const ID_PREFIX = /^My SteamID64 is \d{17}\.\s*/;

/** Progress snapshot streamed by the sweep_achievements tool. */
type SweepSnapshot = {
  phase?: string;
  completed?: number;
  total?: number;
  recent?: { name: string; percent: number | null }[];
};

function SweepProgress({ output }: { output: SweepSnapshot }) {
  const { completed = 0, total = 0, recent = [] } = output;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Sweeping achievements</span>
        <span className="tabular-nums">
          {completed}/{total}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        {recent.map((game) => (
          <li key={game.name} className="flex justify-between gap-4">
            <span className="truncate">{game.name}</span>
            <span className="tabular-nums">{game.percent ?? "—"}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Shape of one score_backlog result. Derived from ScoredGame (the type
 * scoring.ts actually produces) rather than hand-mirrored, so the UI cannot
 * silently drift from what execute() returns. scoring.ts is pure and only
 * `import type`s from its neighbours, so pulling types (never values) from it
 * into this client component is fully erased at compile time.
 *
 * `fallbackReason` is added locally: it does not exist on ScoredGame itself
 * (scoring.ts computes it, score_backlog.ts's execute() attaches it — see
 * templateReason() in agent/lib/scoring.ts).
 */
type ScoredGameResult = Pick<ScoredGame, "appid" | "name" | "categoryLabel" | "metrics"> & {
  facts: Pick<ScoredGame["facts"], "protonTier" | "hasAchievements" | "achievementsUnknown" | "dataGaps"> & {
    /** estHoursRemaining is a lower bound, not an estimate. */
    remainingIsFloor?: boolean;
  };
  fallbackReason: string;
};

type ScoreBacklogOutput = {
  mode: string;
  scored: ScoredGameResult[];
  unknownAppids: number[];
};

/** Short forms — these read inline on one line, not as column headings. */
const METRIC_LABELS: Record<string, string> = {
  achievementPercent: "Achievements",
  estHoursRemaining: "left",
  hoursToBeat: "to beat",
  hoursTo100: "to 100%",
  avgRarityUnearned: "rarity",
  hoursPlayed: "played",
  overinvestmentRatio: "Overinvestment",
  storyProgressPercent: "Story progress",
};

function formatMetric(key: string, value: number): string {
  if (key.toLowerCase().includes("percent") || key === "avgRarityUnearned") {
    return `${value}%`;
  }
  if (key.toLowerCase().includes("hours")) return `${value}h`;
  return String(value);
}

/** Supporting figures, shown small and inline rather than as equal columns. */
const SECONDARY_METRICS = ["hoursToBeat", "hoursTo100", "hoursPlayed"];

const titleCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

/**
 * Steam's own portrait box art. Confirmed 600x900 (2:3) real image/jpeg,
 * 200 for every appid tested (including appid 10, Counter-Strike) and a
 * clean 404 for a nonexistent one — see the akamai host, not the
 * shared.cloudflare.steamstatic.com store_item_assets host, which
 * 301-redirects instead of serving the file directly.
 */
const artworkUrl = (appid: number) =>
  `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`;

/**
 * The image is decorative — the name is already real, selectable text right
 * below it — so alt="" rather than duplicating the name into alt text.
 *
 * aspect-[2/3] reserves the known 600x900 ratio before the image has
 * loaded (or if it 404s and falls back), so the grid's row heights don't
 * jump once artwork starts arriving. onError swaps to a flat placeholder
 * that still shows the name legibly instead of leaving a broken-image icon
 * on screen — a plain `display: none` was rejected because it would leave a
 * hole in the grid instead of a same-sized placeholder.
 */
function GameArtwork({ appid, name }: { appid: number; name: string }) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="relative aspect-4/5 w-full overflow-hidden rounded-md bg-muted">
      {failed ? (
        <div className="flex h-full w-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
          {name}
        </div>
      ) : (
        /*
         * A plain <img>, not next/image, deliberately. next/image would need
         * Steam's CDN added to images.remotePatterns and would then proxy every
         * one of these through our own server to re-optimise them — a request
         * per game, per answer, billable on Vercel. These are already ~50-100KB
         * JPEGs on Valve's CDN at exactly the size we display them, so there is
         * nothing to win and a dependency on our server staying up to lose.
         */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={artworkUrl(appid)}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

/**
 * Built for scanning, not reading. The eye should land on the progress bar and
 * the hours-left figure — the two things that actually decide "which of these
 * do I play" — with everything else demoted to a single quiet line.
 *
 * flex flex-col h-full + the grid's `items-stretch` (grid's default) makes
 * every card in a row match the tallest one, so a card with 3 dataGaps lines
 * doesn't leave its neighbours looking broken. mt-auto on the dataGaps
 * block — the one section of genuinely variable height — pins it to the
 * bottom rather than letting it float directly under a short metrics line.
 */
function GameResultCard({ game }: { game: ScoredGameResult }) {
  const badgeClassName = CATEGORY_STYLE.get(game.categoryLabel) ?? "";
  const { metrics, facts } = game;

  // Achievement completion where it exists, story progress otherwise.
  const progress = metrics.achievementPercent ?? metrics.storyProgressPercent;
  const hasProgress = typeof progress === "number";

  const hoursLeft = metrics.estHoursRemaining;
  const rarity = metrics.avgRarityUnearned;

  const secondary = SECONDARY_METRICS.filter((key) => key in metrics).map(
    (key) => `${formatMetric(key, metrics[key])} ${METRIC_LABELS[key] ?? key}`,
  );

  return (
    <div className="flex h-full flex-col rounded-lg border p-2">
      <GameArtwork appid={game.appid} name={game.name} />

      {/*
        Name and badge stack instead of sharing a line. Side by side they were
        fighting for room: at 3-up the card is ~230px wide, and a long title
        ("Middle-earth™: Shadow of Mordor") plus "Rarity Wall Ahead" left both
        wrapping to two lines each. Stacked, the title gets the full width and
        is clamped to two lines, and the badge sits on its own row at full
        size rather than being squeezed.
      */}
      <div className="mt-2 min-w-0">
        <span className="line-clamp-2 text-sm leading-snug font-medium break-words" title={game.name}>
          {game.name}
        </span>
        <Badge className={`mt-1.5 ${badgeClassName}`}>{game.categoryLabel}</Badge>
      </div>

      {hasProgress && (
        <div className="mt-2 flex items-center gap-2">
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={
              facts.hasAchievements ? "Achievement completion" : "Story progress"
            }
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
          <span className="shrink-0 text-xs tabular-nums">{progress}%</span>
        </div>
      )}

      {/* The decision line: how much work is left, and anything that changes
          how painful that work is. Separated so the parts stay distinct. */}
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
        {/*
          When the hours figure is a floor it is actively misleading — "1.1h+"
          still reads as "about an hour" for what may be a very long grind. So
          lead with what is actually known: how many achievements are left.
          The hours caveat is spelled out in dataGaps below.
        */}
        {/*
          Three cases, most informative first. When the linear figure does not
          hold we prefer the scarcity-weighted RANGE, which reallocates the
          completionist time by how rare each remaining achievement is — the
          spread is the point, so it is always shown as two bounds and never
          collapsed to a midpoint. Only when that cannot be computed (no rarity
          data, or the map does not cover what is unearned) do we fall back to
          the bare achievements-left count.
        */}
        {typeof metrics.estHoursRemainingLow === "number" &&
        typeof metrics.estHoursRemainingHigh === "number" ? (
          <span>
            <span className="font-medium tabular-nums">
              {metrics.estHoursRemainingLow}–{metrics.estHoursRemainingHigh}h
            </span>
            <span className="text-muted-foreground"> left (estimated)</span>
          </span>
        ) : facts.remainingIsFloor && typeof metrics.achievementsLeft === "number" ? (
          <span>
            <span className="font-medium tabular-nums">
              {metrics.achievementsLeft}
            </span>
            <span className="text-muted-foreground">
              {metrics.achievementsLeft === 1
                ? " achievement left"
                : " achievements left"}
            </span>
          </span>
        ) : (
          typeof hoursLeft === "number" && (
            <span>
              <span className="font-medium tabular-nums">~{hoursLeft}h</span>
              <span className="text-muted-foreground"> left</span>
            </span>
          )
        )}
        {typeof rarity === "number" && (
          <>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span className="text-muted-foreground tabular-nums">
              {rarity}% unlock rate
            </span>
          </>
        )}
        {facts.protonTier && (
          <>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span className="text-muted-foreground">
              {titleCase(facts.protonTier)} on Linux
            </span>
          </>
        )}
      </div>

      {(secondary.length > 0 || !facts.hasAchievements) && (
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {[
            ...secondary,
            // achievementsUnknown means Steam never confirmed either way —
            // "no achievements" would assert a fact we don't actually have.
            ...(facts.hasAchievements
              ? []
              : [facts.achievementsUnknown ? "achievement data unavailable" : "no achievements"]),
          ].join(" · ")}
        </p>
      )}

      {facts.dataGaps.length > 0 && (
        <ul className="mt-auto space-y-0.5 border-t pt-1.5 text-[11px] leading-snug text-muted-foreground">
          {facts.dataGaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ScoreBacklogResults({ output }: { output: ScoreBacklogOutput }) {
  if (output.scored.length === 0) {
    return <p className="p-3 text-sm text-muted-foreground">No games were scored.</p>;
  }

  return (
    <div className="space-y-2 p-3">
      {/*
        2 up on phones, 3 from lg. The page shell is max-w-3xl (768px), so at
        3-up each card is roughly 230px — workable only because the card was
        made compact for it: the category badge moved off the title line onto
        its own row, the title is clamped to two lines, the artwork was
        shortened from 2:3 to 4:5, and the supporting figures dropped to 11px.
        Left at 2 columns on phones because 3 at 375px would be ~110px per
        card, which no amount of tightening rescues.

        Grid, not flex-wrap: a row mixes cards with 0 and 3 caveat lines, and
        grid's row-track sizing equalises their heights for free.
      */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        {output.scored.map((game) => (
          <GameResultCard key={game.appid} game={game} />
        ))}
      </div>
      {output.unknownAppids.length > 0 && (
        // Matches the dataGaps styling on a card: quiet, muted, not an error.
        // We only have the raw appids here, not names — score_backlog found
        // them absent from the library before it could look up anything else
        // about them — so the wording stays honest about that limit.
        <p className="text-xs text-muted-foreground">
          {output.unknownAppids.length === 1
            ? `1 requested appid (${output.unknownAppids[0]}) isn't in this library and was skipped.`
            : `${output.unknownAppids.length} requested appids (${output.unknownAppids.join(", ")}) aren't in this library and were skipped.`}
        </p>
      )}
    </div>
  );
}

type DynamicToolPart = Extract<
  EveMessage["parts"][number],
  { type: "dynamic-tool" }
>;

/**
 * A tool call is identified by its `toolCallId`, and eve republishes the same id
 * as a call streams (an async-generator tool yields several snapshots for one
 * call). Collapse those to the last state so one call renders as one card.
 *
 * Two cards with *different* ids means the model genuinely called the tool
 * twice, which is a prompting problem rather than a rendering one.
 */
function dedupeParts(parts: EveMessage["parts"]): EveMessage["parts"] {
  const seen = new Map<string, number>();
  const result: EveMessage["parts"][number][] = [];

  for (const part of parts) {
    if (part.type !== "dynamic-tool") {
      result.push(part);
      continue;
    }

    const at = seen.get(part.toolCallId);
    if (at === undefined) {
      seen.set(part.toolCallId, result.length);
      result.push(part);
    } else {
      result[at] = part;
    }
  }

  return result;
}

/**
 * One tool call in the transcript, rendered as collapsible tool-activity chrome
 * (a chevron, a status badge) — appropriate for the model's *working*, not for
 * its *answer*. score_backlog carries the answer, so it is deliberately never
 * routed through this component — see ScoreBacklogAnswer below, which renders
 * the same cards as a plain, unwrapped part of the response instead.
 *
 * Open state is controlled rather than passed as `defaultOpen`, because the
 * sweep card wants to be open while it streams and collapsed once it finishes —
 * and Base UI only reads `defaultOpen` on first render.
 */
function ToolCall({ part }: { part: DynamicToolPart }) {
  const snapshot = part.output as SweepSnapshot | undefined;
  const isSweeping =
    part.toolName === "sweep_achievements" && snapshot?.phase === "sweeping";

  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? isSweeping;

  return (
    <Tool open={open} onOpenChange={(next) => setOverride(next)}>
      <ToolHeader type={`tool-${part.toolName}`} state={part.state} />
      <ToolContent>
        {isSweeping && snapshot ? (
          <SweepProgress output={snapshot} />
        ) : (
          <>
            <ToolInput input={part.input} />
            <ToolOutput output={part.output} errorText={part.errorText} />
          </>
        )}
      </ToolContent>
    </Tool>
  );
}

/**
 * A pending human-in-the-loop request — the built-in `ask_question` tool, or
 * any tool gated on approval. eve parks the turn durably until it is answered,
 * so without a control here the conversation simply stops forever, which is
 * exactly what "Awaiting Approval" with no buttons looked like.
 *
 * The request rides on the tool part's metadata as
 * `toolMetadata.eve.inputRequest`, and is answered with
 * `agent.respond([{ requestId, optionId | text }])`.
 */
function InputRequestCard({
  request,
  onRespond,
  answered,
}: {
  request: NonNullable<
    NonNullable<DynamicToolPart["toolMetadata"]>["eve"]
  >["inputRequest"];
  onRespond: (response: { requestId: string; optionId?: string; text?: string }) => void;
  answered: boolean;
}) {
  const [text, setText] = useState("");
  if (!request) return null;

  if (answered) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
        {request.prompt} <span className="text-foreground">— answered</span>
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
      <p className="text-sm font-medium">{request.prompt}</p>

      {request.options && request.options.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {request.options.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={option.style === "primary" ? "default" : "outline"}
              onClick={() =>
                onRespond({ requestId: request.requestId, optionId: option.id })
              }
              title={option.description}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}

      {/* Freeform is also the fallback when a question ships no options at
          all, which would otherwise leave nothing to click. */}
      {(request.allowFreeform || !request.options?.length) && (
        <form
          className="mt-2.5 flex items-end gap-2"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const answer = text.trim();
            if (answer.length === 0) return;
            setText("");
            onRespond({ requestId: request.requestId, text: answer });
          }}
        >
          <input
            className="h-10 flex-1 rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            placeholder="Type your answer…"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" className="h-10 px-4" disabled={text.trim().length === 0}>
            Answer
          </Button>
        </form>
      )}
    </div>
  );
}

/**
 * score_backlog's result, rendered with no tool-call chrome at all — no
 * chevron, no "Completed" badge, no click needed. It sits at the same visual
 * level as the model's own text because it IS the answer, not a log of how
 * the model got there.
 */
/**
 * The written half of the answer, guaranteed even when the model emits no
 * text at all — see CLAUDE.md's determinism contract: "templateReason()
 * exists so the app still works correctly with zero useful LLM output." That
 * guarantee did not actually hold in the UI before this: fallbackReason was
 * computed, deliberately withheld from the model, and then never rendered
 * anywhere, so a silent model turn left the user with cards and no sentence.
 *
 * Shows only the top-ranked game's fallback line (scored is already
 * rank-ordered, best first) rather than one line per game — instructions.md
 * is emphatic that the written answer must not restate the cards, and a
 * per-game list would do exactly that.
 */
function FallbackAnswer({ output }: { output: ScoreBacklogOutput }) {
  const top = output.scored[0];
  if (!top) return null;

  return <MessageResponse>{top.fallbackReason}</MessageResponse>;
}

/**
 * The determinism contract, actually enforced.
 *
 * scoring.ts computes every number and the model is only ever allowed to
 * narrate them. Until now that was enforced by asking nicely: instructions.md
 * says so, score_backlog ships an `allowedNumbers` array per game, and the
 * model was trusted to police itself — which CLAUDE.md already records it does
 * not reliably do.
 *
 * It cannot be enforced on the server. eve's hooks are observe-only and fire
 * after the text is durably persisted and already streaming, and their one
 * escalation is to throw, which fails the whole turn rather than substituting
 * the safe sentence. So the check lands here, at render, which is the first
 * point that has both the model's prose AND the full untrimmed tool output —
 * `toModelOutput` withholds data from the model, but the UI still receives
 * everything on `part.output`.
 *
 * If the prose asserts a statistic the scorer never produced, it is replaced
 * wholesale by the deterministic sentence rather than shown with a warning:
 * a fabricated figure is the one failure this project exists to prevent, and
 * a hedge next to a wrong number still leaves the number on screen.
 *
 * Caveat worth knowing: this protects this UI only. The ungrounded text still
 * exists in the durable transcript and would reach any other consumer of the
 * session unfiltered.
 */
function GroundedText({
  text,
  output,
  streaming,
}: {
  text: string;
  output: ScoreBacklogOutput | undefined;
  streaming: boolean;
}) {
  // Never judge a half-written sentence — a number is routinely ungrounded
  // for the moment between its first digit and its last.
  if (streaming || !output) {
    return <MessageResponse>{text}</MessageResponse>;
  }

  // Checked against every game in the shortlist, not just the top one: the
  // model is asked for a comparative sentence ("Sifu beats Terraria's 33h"),
  // so a figure belonging to any scored game is legitimately grounded.
  // quotableMetrics, not raw metrics: a game whose hours figure is a floor has
  // that figure withheld from the model, so it must be withheld from the
  // allowed set too — otherwise the guard would accept the exact number the
  // suppression exists to keep off the screen.
  const ungrounded = findUngroundedNumbers(text, output.scored.map(quotableMetrics));

  if (ungrounded.length === 0) {
    return <MessageResponse>{text}</MessageResponse>;
  }

  const top = output.scored[0];
  return (
    <MessageResponse>
      {top ? top.fallbackReason : "That answer could not be verified against the data."}
    </MessageResponse>
  );
}

function ScoreBacklogAnswer({ part }: { part: DynamicToolPart }) {
  const output = part.output as ScoreBacklogOutput | undefined;

  if (part.state !== "output-available" || !Array.isArray(output?.scored)) {
    // Still scoring. No chrome here either — just a quiet in-progress line at
    // the same visual level the finished cards will land at.
    return <Shimmer className="text-sm text-muted-foreground">Scoring…</Shimmer>;
  }

  return <ScoreBacklogResults output={output} />;
}

export type VerifiedProfile = {
  steamId: string;
  personaName: string;
  totalGames: number;
  playedGames: number;
};

/**
 * First screen: collect the Steam profile and prove it actually works before
 * letting the user ask anything. Checks that the profile resolves, that it is
 * public, and that Steam will actually hand over its library — three separate
 * failure modes that would otherwise surface halfway through a turn.
 */
function ProfileGate({ onVerified }: { onVerified: (profile: VerifiedProfile) => void }) {
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const profile = value.trim();
    if (profile.length === 0 || checking) return;

    setChecking(true);
    setError(null);

    try {
      const response = await fetch("/api/steam/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      const body = await response.json();

      if (!response.ok || !body.ok) {
        setError(body.error ?? "Could not verify that profile.");
        return;
      }

      onVerified(body as VerifiedProfile);
    } catch {
      setError("Could not reach the server to check that profile.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="max-w-xl space-y-5">
        <h2 className="text-3xl font-semibold tracking-tight text-balance">
          How far through your Steam games are you?
        </h2>
        <p className="text-lg text-muted-foreground text-balance">
          Enter a public Steam profile and it pulls together four things Steam
          keeps in separate places.
        </p>

        <ul className="mx-auto max-w-md space-y-3 text-left text-base">
          <li className="flex gap-3">
            <span aria-hidden className="text-primary">
              →
            </span>
            <span>
              <span className="font-medium">Achievement progress</span>{" "}
              <span className="text-muted-foreground">
                for every game you have played
              </span>
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="text-primary">
              →
            </span>
            <span>
              <span className="font-medium">Hours to beat and to 100%</span>{" "}
              <span className="text-muted-foreground">from HowLongToBeat</span>
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="text-primary">
              →
            </span>
            <span>
              <span className="font-medium">How rare your remaining achievements are</span>{" "}
              <span className="text-muted-foreground">
                — the difference between an hour left and a very long grind
              </span>
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="text-primary">
              →
            </span>
            <span>
              <span className="font-medium">Linux support</span>{" "}
              <span className="text-muted-foreground">from ProtonDB</span>
            </span>
          </li>
        </ul>

        <p className="text-base text-muted-foreground text-balance">
          It reports those numbers and sorts games into fixed categories. It has
          no idea which games you would actually enjoy, and it has no pricing
          data — you decide what is worth your time.
        </p>

        <p className="text-sm text-muted-foreground">
          A Steam username, profile link, or 17-digit Steam ID. The profile and
          its game details must be public.
        </p>
      </div>

      <form className="flex w-full max-w-sm gap-2" onSubmit={verify}>
        <input
          autoFocus
          disabled={checking}
          className="h-10 flex-1 rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
          placeholder="e.g. gabelogannewell"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
        />
        {/* Height pinned to match the input beside it — Button's default
            size is h-8, which left the two visibly misaligned. */}
        <Button
          type="submit"
          className="h-10 px-4"
          disabled={value.trim().length === 0 || checking}
        >
          {checking ? "Checking…" : "Continue"}
        </Button>
      </form>

      {error && (
        <p className="max-w-sm text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Nothing is stored. Refreshing the page clears everything.
      </p>
    </div>
  );
}

export default function Home() {
  const agent = useEveAgent();
  const [profile, setProfile] = useState<VerifiedProfile | null>(null);
  const [input, setInput] = useState("");

  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isFirstMessage = agent.data.messages.length === 0;

  const submit = (text: string) => {
    const message = text.trim();
    if (message.length === 0 || !profile) return;
    setInput("");

    // Pass the already-resolved SteamID64 so the agent does not have to guess
    // at a vanity name. It only needs stating once; the session carries it.
    const payload = isFirstMessage
      ? `My SteamID64 is ${profile.steamId}. ${message}`
      : message;

    // Always steer, never send() bare. The client's "busy" flag only reflects
    // what the browser has heard back, not whether the server-side turn is
    // still alive — eve's local dev queue can retry a stalled turn well after
    // the client gives up and shows idle. A bare send() in that window starts
    // a second concurrent turn on the same session, and the two turns'
    // tool calls and answers interleave in the transcript. `steer` cancels
    // whatever is still running before accepting the new message, so it is
    // safe to use even when the client believes nothing is active.
    void agent.send(payload, { turnPolicy: "steer" });
  };

  /** Answers a parked question or approval so the turn can resume. */
  const respondToInput = (response: {
    requestId: string;
    optionId?: string;
    text?: string;
  }) => {
    void agent.respond([response]);
  };

  const changeProfile = () => {
    agent.reset();
    setInput("");
    setProfile(null);
  };

  // max-w-5xl, not the original 3xl: at 3-up a 768px shell left each card
  // around 230px and half a 1280px screen empty. 1024px gives roughly 320px
  // per card, which is what the artwork and a wrapped title actually need.
  // Prose still reads fine because the answer text is one or two sentences,
  // never a wall.
  return (
    <div className="mx-auto flex h-dvh max-w-5xl flex-col px-4">
      {/* items-center, not items-baseline: the right-hand controls are
          buttons, which have no meaningful shared baseline with a two-line
          text block and ended up sitting high. */}
      <header className="flex items-center justify-between gap-4 border-b py-4">
        <div>
          {/* Accented like the portfolio's section headings. */}
          <h1 className="text-lg font-semibold tracking-tight text-primary">
            Finish Line
          </h1>
          <p className="text-sm text-muted-foreground">
            Which of your Steam games are you closest to finishing?
          </p>
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <CategoryLegend />
          {profile && (
            /* text-sm to match the buttons beside it, with separators so the
               three values stay distinct. */
            <div className="ml-1 flex items-center gap-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {profile.personaName}
              </span>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <span className="tabular-nums">
                {profile.playedGames}/{profile.totalGames} played
              </span>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={changeProfile}
              >
                change
              </button>
            </div>
          )}
        </div>
      </header>

      {!profile ? (
        <ProfileGate onVerified={setProfile} />
      ) : (
        <>
          <Conversation className="flex-1">
            <ConversationContent className="gap-4">
              {isFirstMessage && (
                <ConversationEmptyState>
                  <div className="max-w-md space-y-1">
                    <h3 className="font-medium text-sm">Ask away</h3>
                    <p className="text-muted-foreground text-sm">
                      The first question sweeps achievements across everything
                      you have played, which takes a moment. After that, answers
                      are instant.
                    </p>
                  </div>
                  <div className="mt-2 flex flex-col gap-2">
                    {SUGGESTIONS.map((suggestion) => (
                      <Button
                        key={suggestion}
                        variant="outline"
                        size="sm"
                        onClick={() => submit(suggestion)}
                      >
                        {suggestion}
                      </Button>
                    ))}
                  </div>
                </ConversationEmptyState>
              )}

              {agent.data.messages.map((message, messageIndex) => {
                const isLastMessage = messageIndex === agent.data.messages.length - 1;
                const hasVisibleText = message.parts.some(
                  (part) => part.type === "text" && part.text.trim().length > 0,
                );

                // Once every tool card is done, there is a real gap while the
                // model composes its reply — nothing else in the transcript
                // shows that. Surface it explicitly rather than leaving a
                // silent wait after the last tool result.
                const isComposing =
                  isBusy && isLastMessage && message.role === "assistant" && !hasVisibleText;

                // The fallback sentence only belongs on screen once the turn
                // has genuinely finished with nothing else said — rendering
                // it while still streaming would mean the real answer, when
                // it does arrive, replaces a flicker of fallback text. Reuses
                // isBusy/isComposing rather than tracking a second notion of
                // "done", so this and the shimmer above can never disagree
                // about whether the turn is still in flight.
                const showFallback =
                  !isBusy && isLastMessage && message.role === "assistant" && !hasVisibleText && !isComposing;

                // This turn's scored games, if it scored any. Needed whether or
                // not the model went silent: with no text it supplies the
                // fallback sentence, and with text it supplies the numbers that
                // text is checked against.
                const scoreOutput = dedupeParts(message.parts).find(
                  (part): part is DynamicToolPart =>
                    part.type === "dynamic-tool" &&
                    part.toolName === "score_backlog" &&
                    part.state === "output-available" &&
                    Array.isArray((part.output as ScoreBacklogOutput | undefined)?.scored) &&
                    ((part.output as ScoreBacklogOutput).scored.length > 0),
                )?.output as ScoreBacklogOutput | undefined;

                const fallbackOutput = showFallback ? scoreOutput : undefined;

                return (
                  <Message key={message.id} from={message.role}>
                    <MessageContent>
                      {dedupeParts(message.parts).map((part, index) => {
                        if (part.type === "text") {
                          if (message.role === "user") {
                            return (
                              <MessageResponse key={index}>
                                {part.text.replace(ID_PREFIX, "")}
                              </MessageResponse>
                            );
                          }

                          return (
                            <GroundedText
                              key={index}
                              text={part.text}
                              output={scoreOutput}
                              streaming={isBusy && isLastMessage}
                            />
                          );
                        }

                        if (part.type === "dynamic-tool") {
                          // A pending question or approval must be answerable,
                          // or the turn parks forever.
                          const inputRequest = part.toolMetadata?.eve?.inputRequest;
                          if (inputRequest) {
                            return (
                              <InputRequestCard
                                key={part.toolCallId}
                                request={inputRequest}
                                answered={Boolean(part.toolMetadata?.eve?.inputResponse)}
                                onRespond={respondToInput}
                              />
                            );
                          }

                          return part.toolName === "score_backlog" ? (
                            <ScoreBacklogAnswer key={part.toolCallId} part={part} />
                          ) : (
                            <ToolCall key={part.toolCallId} part={part} />
                          );
                        }

                        return null;
                      })}
                      {isComposing && (
                        <Shimmer className="text-sm">Working out the answer…</Shimmer>
                      )}
                      {fallbackOutput && <FallbackAnswer output={fallbackOutput} />}
                    </MessageContent>
                  </Message>
                );
              })}

              {isBusy &&
                agent.data.messages[agent.data.messages.length - 1]?.role !== "assistant" && (
                  <Message from="assistant">
                    <MessageContent>
                      <Shimmer className="text-sm">Thinking…</Shimmer>
                    </MessageContent>
                  </Message>
                )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <form
            className="flex items-end gap-2 border-t py-4"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              submit(input);
            }}
          >
            <textarea
              className="max-h-40 min-h-10 flex-1 resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder="Ask about your backlog…"
              rows={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit(input);
                }
              }}
            />
            {isBusy ? (
              <Button
                type="button"
                variant="outline"
                className="h-10 px-4"
                onClick={() => void agent.cancel()}
              >
                Stop
              </Button>
            ) : (
              <Button
                type="submit"
                className="h-10 px-4"
                disabled={input.trim().length === 0}
              >
                Send
              </Button>
            )}
          </form>
        </>
      )}

      {agent.error && (
        <p className="pb-3 text-sm text-destructive">{agent.error.message}</p>
      )}
    </div>
  );
}
