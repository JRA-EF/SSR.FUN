// Profanity / hate-speech filter for the user-written identity of a Reserve
// (name, ticker, description). Shared by the Create forms (inline warning,
// Launch blocked) and lib/reserve-metadata/payload.ts (the one place every
// metadata write goes through), so a request that skips the UI is refused
// too. Pure and dependency-free.
//
// Three lists, because of the Scunthorpe problem:
// - BLOCKED_INSIDE_WORDS: matched anywhere inside a word, so "fuckcoin" and
//   "MotherFuckerReserve" are caught. Only terms that never occur inside
//   ordinary English words belong here (ALLOWED_WORDS excuses the few that do).
// - BLOCKED_WORDS: whole words only, so "ass" blocks "ass" but never
//   "assets", "class" or "Bass Reserve".
// - BLOCKED_PHRASES: matched across the whole text with spaces and
//   punctuation removed, so "Hate Jews", "hate-jews" and "h4te j3ws" are caught.
// Every check also runs with look-alike characters mapped (0->o, 1->i,
// 3->e, 4->a, 5->s, @->a, $->s ...), and runs of single letters are joined
// ("f u c k", "F.U.C.K" -> "fuck").
//
// Extend the lists here; tests/phase_profanity_filter.ts pins both the
// blocked and the must-pass examples.

export const PROFANITY_MESSAGE = "Profanity filter: Please keep it clean";

const BLOCKED_INSIDE_WORDS = [
  "fuck", "fuk", "phuck", "shit", "bitch", "cunt", "motherfuck", "dickhead", "asshole", "bullshit", "jackass",
  "dumbass", "wanker", "whore", "slut", "cocksuck", "blowjob", "handjob", "jizz", "dildo", "hentai", "porno",
  "nigger", "nigga", "faggot", "fagot", "tranny", "kike", "wetback", "raghead", "towelhead", "beaner",
];

const BLOCKED_WORDS = [
  "ass", "asses", "arse", "cum", "cock", "cocks", "dick", "dicks", "fag", "fags", "tit", "tits", "titty", "titties",
  "hoe", "hoes", "nig", "fck", "fk", "fu", "stfu", "wtf", "milf", "sex", "anal", "nude", "nudes", "porn", "pussy",
  "twat", "twats", "rape", "raped", "rapes", "rapist", "retard", "retards", "retarded", "spic", "spics", "coon",
  "coons", "gook", "gooks", "chink", "chinks", "kkk", "nazi", "nazis", "bastard", "bastards", "1488",
];

const BLOCKED_PHRASES = [
  "hatejews", "killjews", "killthejews", "gasthejews", "deathtojews", "hatemuslims", "killmuslims", "deathtomuslims",
  "hateblacks", "killblacks", "hategays", "killgays", "heilhitler", "siegheil", "whitepower", "whitesupremacy",
  "holocaustwasfake", "holohoax", "jewsdid911", "hitlerwasright",
];

// Ordinary words that contain a BLOCKED_INSIDE_WORDS term.
const ALLOWED_WORDS = new Set([
  "scunthorpe", "snigger", "sniggers", "sniggered", "sniggering", "shiitake", "mishit", "cockpit", "dickens",
]);

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i" };

function deLeet(s: string): string {
  let out = "";
  for (const ch of s) out += LEET[ch] ?? ch;
  return out;
}

/** Lowercased with accents stripped, so "Fück" and "FUCK" read alike. */
function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Words of the text, with runs of single characters joined ("f u c k" -> "fuck"). */
function tokens(folded: string): string[] {
  const raw = folded.split(/[^a-z0-9@$!|]+/).filter(Boolean);
  const out: string[] = [];
  let run = "";
  for (const w of raw) {
    if (w.length === 1) {
      run += w;
      continue;
    }
    if (run) out.push(run);
    run = "";
    out.push(w);
  }
  if (run) out.push(run);
  return out;
}

/** Each spelling worth checking for a word: as typed (letters/digits only) and with look-alikes mapped, unless it is a plain number. */
function spellings(w: string): string[] {
  const plain = w.replace(/[^a-z0-9]/g, "");
  if (/^[0-9]+$/.test(plain)) return [plain];
  const mapped = deLeet(w).replace(/[^a-z0-9]/g, "");
  return mapped === plain ? [plain] : [plain, mapped];
}

/** Returns the first blocked term found in `text`, or null when the text is clean. */
export function findProfanity(text: string): string | null {
  if (!text) return null;
  const folded = fold(text);
  const words = tokens(folded);

  for (const w of words) {
    for (const v of spellings(w)) {
      if (BLOCKED_WORDS.includes(v)) return v;
      if (ALLOWED_WORDS.has(v)) continue;
      const hit = BLOCKED_INSIDE_WORDS.find((t) => v.includes(t));
      if (hit) return hit;
    }
  }

  const squashed = words.join("");
  for (const v of spellings(squashed)) {
    const hit = BLOCKED_PHRASES.find((t) => v.includes(t));
    if (hit) return hit;
  }
  return null;
}

export function containsProfanity(text: string): boolean {
  return findProfanity(text) !== null;
}

/** Checks a Reserve's name, ticker and description; returns the first field that fails, or null. */
export function findProfaneReserveField(fields: { name?: string; ticker?: string; description?: string }): "name" | "ticker" | "description" | null {
  for (const key of ["name", "ticker", "description"] as const) {
    if (containsProfanity(fields[key] ?? "")) return key;
  }
  return null;
}
