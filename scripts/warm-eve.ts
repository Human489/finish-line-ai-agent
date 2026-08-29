/**
 * Pays eve's cold-start cost up front, so the first question a person asks is
 * not the one that waits for it.
 *
 * MEASURED, on a 597-game library:
 *
 *   first turn in a fresh eve process ... 59.1s
 *   second turn, same process .............. 6.9s
 *
 * The difference is not the model and not the data. Both were timed
 * separately: a Gemini call with the full instructions and every tool
 * declaration returns in ~0.9s, `sweep_achievements` across 137 games takes
 * 3.8s, and the keyless enrichment adds ~4s. The ~50s is eve compiling the
 * agent and its tools lazily on first use.
 *
 * It also cascades. `@workflow/world-local` aborts a queue delivery whose
 * response headers take longer than WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS
 * (default 30_000), reports it as `TypeError: fetch failed`, waits a hardcoded
 * 5s and retries — so a cold step that legitimately needs 50s gets killed and
 * re-run repeatedly, which is what the "retry loop" in the known issues
 * actually is most of the time. Raising that timeout (see CLAUDE.md) stops the
 * storm; this script stops the wait.
 *
 * Sends one trivially cheap, deliberately out-of-scope message: the agent
 * declines it in a single step without calling any tool, so it costs one small
 * model request and no Steam quota, while still forcing the compile.
 *
 *   npx tsx scripts/warm-eve.ts [baseUrl]
 */

// 4278 is the port the README and CLAUDE.md both tell you to start eve on. The
// default was 4274, left over from an earlier port choice, so following the
// README literally - start eve on 4278, then run this with no argument -
// warmed a port nothing was listening on and reported a connection failure for
// a process that was running perfectly well. Note EVE_BASE_URL in .env.local
// does not help here: nothing loads it for scripts, only `next dev` sees it.
const BASE = process.argv[2] ?? process.env.EVE_BASE_URL ?? "http://127.0.0.1:4278";

async function main() {
  const started = Date.now();
  process.stdout.write(`Warming ${BASE} ... `);

  let response: Response;
  try {
    response = await fetch(`${BASE}/eve/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Out of scope on purpose — instructions.md tells the agent to decline
      // this in one sentence, so it never reaches a tool.
      body: JSON.stringify({ message: "What is the capital of France?" }),
    });
  } catch (error) {
    console.log("FAILED");
    console.error(
      `Could not reach eve at ${BASE}. Is it running?\n  ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  if (!response.ok) {
    console.log(`FAILED (HTTP ${response.status})`);
    process.exit(1);
  }

  const { sessionId } = (await response.json()) as { sessionId?: string };
  if (!sessionId) {
    console.log("FAILED (no sessionId in response)");
    process.exit(1);
  }

  // The compile happens while the turn runs, so we have to wait for the turn
  // to finish rather than just for the session to be accepted.
  const stream = await fetch(`${BASE}/eve/v1/session/${sessionId}/stream`);
  const reader = stream.body?.getReader();
  if (!reader) {
    console.log("FAILED (no stream)");
    process.exit(1);
  }

  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    if (buffered.includes('"turn.completed"') || buffered.includes('"turn.failed"')) break;
  }
  await reader.cancel();

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`warm in ${seconds}s`);
  console.log("The next question will not pay the compile cost.");
}

void main();
