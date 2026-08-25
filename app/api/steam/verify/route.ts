import { NextResponse } from "next/server";
import {
  SteamKeyMissingError,
  getOwnedGames,
  resolveSteamId,
} from "@/agent/lib/steam";

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
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not reach Steam to look up that profile.",
      },
      { status: 404 },
    );
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
    const isKeyProblem = error instanceof SteamKeyMissingError;

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Steam refused to return the library for that profile.",
        // A missing server key is the operator's problem, not the visitor's.
        keyMissing: isKeyProblem,
      },
      { status: isKeyProblem ? 500 : 403 },
    );
  }
}
