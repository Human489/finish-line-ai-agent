import { NextResponse } from "next/server";
import {
  SteamKeyMissingError,
  SteamKeyRejectedError,
  SteamLibraryPrivateError,
  SteamProfileNotFoundError,
  SteamUnavailableError,
  getOwnedGames,
  resolveSteamId,
} from "@/agent/lib/steam";

/**
 * What to tell the visitor, decided by error TYPE rather than by forwarding the
 * thrown text.
 *
 * This route is unauthenticated, so the thrown message is the wrong thing to
 * send: it is written for whoever runs the server, and the missing-key error
 * names STEAM_WEB_API_KEY and links to where to get one. Forwarding it handed a
 * stranger the name of a server secret, the same mistake the document search
 * error made.
 *
 * Each branch also has to be ACCURATE, not merely vague. Collapsing these into
 * one sentence about privacy settings told people to fix a setting that was
 * fine whenever Steam simply had an outage, and told them to retry a missing
 * key that no amount of retrying will fix.
 */
function visitorMessage(error: unknown): { text: string; status: number; ourFault: boolean } {
  if (error instanceof SteamKeyMissingError || error instanceof SteamKeyRejectedError) {
    return {
      text: "This app is not able to talk to Steam at the moment. That is a problem with the app rather than your profile, and retrying will not help until it is fixed.",
      status: 500,
      ourFault: true,
    };
  }

  if (error instanceof SteamUnavailableError) {
    return {
      text: "Steam did not respond properly just now. Nothing is wrong with your profile, so it is worth trying again in a moment.",
      status: 503,
      ourFault: false,
    };
  }

  if (error instanceof SteamLibraryPrivateError) {
    return {
      text: "Steam would not share this profile's games. Set Game Details to Public in Steam privacy settings, which is a separate setting from the profile itself.",
      status: 403,
      ourFault: false,
    };
  }

  if (error instanceof SteamProfileNotFoundError) {
    return {
      text: "No Steam profile found with that name. Check the vanity name, profile URL or 17-digit SteamID64.",
      status: 404,
      ourFault: false,
    };
  }

  // NOT dead code, despite every throw in steam.ts being typed: fetch itself
  // rejects on a network failure, and AbortSignal.timeout rejects with a
  // TimeoutError. Both land here, and both are worth retrying.
  return {
    text: "Could not reach Steam to check that profile. Please try again in a moment.",
    status: 503,
    ourFault: false,
  };
}

/**
 * Validates a Steam profile before the user is allowed to start a conversation.
 *
 * Two things can be wrong and they are different settings:
 *   - the profile itself does not exist, or is not public
 *   - the profile is public but its *game details* are private, in which case
 *     the library comes back empty
 *
 * Both are checked here so the failure surfaces on the first screen rather than
 * halfway through a turn. A missing API key surfaces here too.
 */
/**
 * This route is unauthenticated and every call spends Steam API key quota
 * (getOwnedGames), so it needs its own throttle rather than relying on
 * anything upstream. A plain in-process Map, lazily cleaned on access - same
 * spirit as the session cache in agent/lib/cache.ts, and for the same reason:
 * no new dependency, no background timer.
 *
 * This is per-process and therefore best-effort on serverless: each instance
 * (and each cold start) has its own Map, so a caller spread across instances
 * can exceed the nominal limit. Good enough to blunt casual abuse; not a
 * substitute for a real edge/WAF rate limit if this ever needs to be robust.
 */
const RATE_LIMIT = 10; // requests
const RATE_WINDOW_MS = 60 * 1000; // per minute
const hits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;

  // Lazily drop expired entries so the map doesn't grow forever.
  for (const [key, timestamps] of hits) {
    const recent = timestamps.filter((t) => t > windowStart);
    if (recent.length === 0) hits.delete(key);
    else hits.set(key, recent);
  }

  const recent = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }

  recent.push(now);
  hits.set(ip, recent);
  return false;
}

/**
 * Steam reports privacy as raw enum tokens like "friendsonly", which read badly
 * dropped into a sentence. Turn them into something a person can act on.
 */
function describePrivacy(state: string): string {
  const fix =
    "Steam → Profile → Edit Profile → Privacy Settings, and set both " +
    '"My profile" and "Game details" to Public.';

  switch (state) {
    case "friendsonly":
      return `That profile is visible to friends only, so Steam will not share it with this app. To use it: ${fix}`;
    case "private":
      return `That profile is private, so Steam will not share anything about it. To use it: ${fix}`;
    default:
      return `That profile is not public (Steam reports it as "${state}"). To use it: ${fix}`;
  }
}

export async function POST(request: Request) {
  // No forwarded-for header (e.g. local dev behind no proxy) falls back to a
  // single shared bucket rather than skipping the check entirely.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  if (isRateLimited(ip)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Too many profile checks from this connection. Try again in a minute.",
      },
      { status: 429 },
    );
  }

  let profile: string;

  try {
    const body = (await request.json()) as { profile?: unknown };
    if (typeof body.profile !== "string" || body.profile.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: "Enter a Steam profile." },
        { status: 400 },
      );
    }
    profile = body.profile.trim();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Malformed request." },
      { status: 400 },
    );
  }

  let resolved: Awaited<ReturnType<typeof resolveSteamId>>;
  try {
    resolved = await resolveSteamId(profile);
  } catch (error) {
    const { text, status } = visitorMessage(error);
    console.error("[steam/verify] profile lookup failed", error);
    return NextResponse.json({ ok: false, error: text }, { status });
  }

  if (resolved.privacyState !== "public") {
    return NextResponse.json(
      { ok: false, error: describePrivacy(resolved.privacyState) },
      { status: 403 },
    );
  }

  try {
    const games = await getOwnedGames(resolved.steamId);
    const played = games.filter((game) => game.hoursPlayed > 0).length;

    return NextResponse.json({
      ok: true,
      steamId: resolved.steamId,
      personaName: resolved.personaName ?? profile,
      totalGames: games.length,
      playedGames: played,
    });
  } catch (error) {
    const { text, status, ourFault } = visitorMessage(error);

    // The operator gets the real error here; the visitor never does.
    console.error("[steam/verify] library lookup failed", error);

    return NextResponse.json(
      { ok: false, error: text, serverProblem: ourFault },
      { status },
    );
  }
}
