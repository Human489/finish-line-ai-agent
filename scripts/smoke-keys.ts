/**
 * Verifies both API keys with the cheapest possible calls.
 *
 * Listing Gemini models consumes no tokens. The generation check that follows
 * costs well under 100 tokens. The Steam calls are two requests against a
 * 100,000/day quota.
 *
 *   npx tsx scripts/smoke-keys.ts
 *
 * Never prints a key.
 */

import { readFileSync } from "node:fs";

// Load .env.local without adding a dependency.
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
}

const google = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const steam = process.env.STEAM_WEB_API_KEY;

/**
 * A public SteamID64 to exercise the keyed endpoints against. Defaults to
 * Gabe Newell's public profile; override with SMOKE_STEAM_ID to use your own.
 */
const STEAM_ID = process.env.SMOKE_STEAM_ID ?? "76561197960287930";

/** Keep in sync with agent/agent.ts. */
const CONFIGURED_MODEL = "gemini-3.5-flash-lite";

function describe(name: string, value: string | undefined) {
  if (!value) return `${name}: MISSING`;
  const trimmed = value.trim();
  const notes: string[] = [`${trimmed.length} chars`];
  if (trimmed !== value) notes.push("HAS SURROUNDING WHITESPACE");
  if (/^["']|["']$/.test(value)) notes.push("HAS QUOTES — remove them");
  return `${name}: ${notes.join(", ")}`;
}

async function checkGoogle() {
  console.log("\n=== Gemini key ===");
  console.log(describe("GOOGLE_GENERATIVE_AI_API_KEY", google));
  if (!google) return;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${google.trim()}`,
  );
  console.log("list models ->", res.status);

  const body = (await res.json()) as {
    models?: { name: string; supportedGenerationMethods?: string[] }[];
    error?: { message?: string; status?: string };
  };

  if (!res.ok) {
    console.log("ERROR:", body.error?.status, "-", body.error?.message);
    return;
  }

  const usable = (body.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace("models/", ""));

  console.log(`key is VALID — ${usable.length} models support generateContent`);
  console.log("gemini-3.x models available to this key:");
  for (const name of usable.filter((n) => n.startsWith("gemini-3"))) {
    console.log("   ", name);
  }

  const present = usable.includes(CONFIGURED_MODEL);
  console.log(`configured model '${CONFIGURED_MODEL}' present:`, present);
  if (!present) {
    console.log("   ^ update agent/agent.ts to one of the models listed above");
    return;
  }

  // Smallest possible generation, with one tool declared, to prove that both
  // text output and tool calling work. Costs well under 100 tokens.
  const gen = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CONFIGURED_MODEL}:generateContent?key=${google.trim()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }],
        generationConfig: { maxOutputTokens: 500 },
        tools: [
          {
            functionDeclarations: [
              {
                name: "ping",
                description: "Ping a host.",
                parameters: {
                  type: "object",
                  properties: { host: { type: "string" } },
                  required: ["host"],
                },
              },
            ],
          },
        ],
      }),
    },
  );

  const genBody = (await gen.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { totalTokenCount?: number };
    error?: { message?: string; status?: string };
  };

  console.log("minimal generateContent ->", gen.status);
  if (!gen.ok) {
    console.log("ERROR:", genBody.error?.status, "-", genBody.error?.message);
    return;
  }

  const text = (genBody.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text)
    .filter(Boolean)
    .join("");
  console.log("   reply:", JSON.stringify(text));
  console.log("   tokens used:", genBody.usageMetadata?.totalTokenCount);
}

async function checkSteam() {
  console.log("\n=== Steam key ===");
  console.log(describe("STEAM_WEB_API_KEY", steam));
  if (!steam) return;

  const owned = await fetch(
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${steam.trim()}&steamid=${STEAM_ID}&include_appinfo=1&format=json`,
  );
  console.log("GetOwnedGames ->", owned.status);
  if (!owned.ok) {
    console.log("ERROR body:", (await owned.text()).slice(0, 200));
    return;
  }

  const body = (await owned.json()) as {
    response?: { games?: { appid: number; name?: string; playtime_forever?: number }[] };
  };
  const games = body.response?.games ?? [];
  const played = games.filter((g) => (g.playtime_forever ?? 0) > 0);
  console.log(`library: ${games.length} games, ${played.length} played`);

  const top = [...played]
    .sort((a, b) => (b.playtime_forever ?? 0) - (a.playtime_forever ?? 0))
    .slice(0, 5);
  for (const g of top) {
    console.log(`   ${g.name} — ${Math.round((g.playtime_forever ?? 0) / 60)}h`);
  }

  if (top.length > 0) {
    const appid = top[0].appid;
    const ach = await fetch(
      `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${steam.trim()}&steamid=${STEAM_ID}&appid=${appid}&l=en&format=json`,
    );
    console.log(`GetPlayerAchievements (${top[0].name}) ->`, ach.status);
    if (ach.ok) {
      const aBody = (await ach.json()) as {
        playerstats?: { success?: boolean; achievements?: { achieved: number }[] };
      };
      const list = aBody.playerstats?.achievements ?? [];
      const earned = list.filter((a) => a.achieved === 1).length;
      console.log(
        list.length > 0
          ? `   ${earned}/${list.length} achievements (${Math.round((earned / list.length) * 1000) / 10}%)`
          : "   no achievements for this game",
      );
    }
  }
}

async function main() {
  await checkGoogle();
  await checkSteam();
  console.log("\nDone. Only the one-word generation above consumed any tokens.");
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
