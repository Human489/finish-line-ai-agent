import { defineTool } from "eve/tools";
import { z } from "zod";
import { cacheFor } from "../lib/cache";
import { resolveSteamId } from "../lib/steam";

export default defineTool({
  description:
    "Resolve a Steam vanity name, profile URL or SteamID64 into a SteamID64 and report whether the profile is public. Always call this first — every other tool needs the SteamID64.",
  inputSchema: z.object({
    profile: z
      .string()
      .min(1)
      .describe("A Steam vanity name, a full profile URL, or a 17-digit SteamID64."),
  }),
  async execute({ profile }, ctx) {
    const result = await resolveSteamId(profile);

    cacheFor(ctx.session.id).steamId = result.steamId;

    return {
      steamId: result.steamId,
      personaName: result.personaName ?? null,
      privacyState: result.privacyState,
      isPublic: result.privacyState === "public",
      warning:
        result.privacyState === "public"
          ? null
          : "This profile is not public. Steam will refuse to return the library or achievements.",
    };
  },
});
