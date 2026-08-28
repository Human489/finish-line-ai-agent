/**
 * Which document sources an answer still needs to name.
 *
 * The instructions ask the model to end a document-grounded answer with the
 * file it used, and it usually does. "Usually" is the problem: an uncited
 * answer is indistinguishable from one the model invented, which is exactly
 * the confidence this app is built to withhold. So the citation is rendered
 * from the tool output rather than requested, the same way every number the
 * model quotes is checked against the scorer rather than trusted.
 *
 * This file has ZERO imports so `app/page.tsx` (a "use client" component) can
 * import it as safely as `categories.ts`. Putting it in `rag.ts` would drag
 * the Cloudflare fetch path into the browser bundle.
 */

/** Strips one trailing extension, so "steam-families.pdf" matches "steam-families". */
function stem(source: string): string {
  const cut = source.lastIndexOf(".");
  return cut <= 0 ? source : source.slice(0, cut);
}

/**
 * The sources to print under an answer, or none if it already names one.
 *
 * Deliberately satisfied by a SINGLE named source rather than all of them.
 * The model is told to answer from the passages and cite what it used, and a
 * good answer often rests on one document even when the search returned two.
 * Demanding every filename would append a redundant line to answers that are
 * already correctly attributed.
 *
 * Matching accepts the filename or its stem, case-insensitively, because the
 * model writes both "(source: steam-families.pdf)" and "per steam-families".
 * It is deliberately not fuzzier than that: "the Steam Families document" is
 * prose about a source, not a citation of one, and treating it as a citation
 * would let the guard pass on an answer a reader cannot actually trace.
 */
export function citationsToShow(text: string, sources: string[]): string[] {
  const distinct = [...new Set(sources.filter((source) => source.trim().length > 0))];
  if (distinct.length === 0) return [];

  // An empty or whitespace answer has nothing to attribute. The fallback path
  // owns that case; appending a bare source line to nothing reads as a bug.
  if (text.trim().length === 0) return [];

  const haystack = text.toLowerCase();
  const alreadyCited = distinct.some((source) => {
    const name = source.toLowerCase();
    return haystack.includes(name) || haystack.includes(stem(name));
  });

  return alreadyCited ? [] : distinct;
}
