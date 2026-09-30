const WORD_A = [
  "amber", "brave", "coral", "delta", "ember", "frost", "grove", "haven",
  "ivory", "jade", "kite", "lunar", "maple", "north", "olive", "pine",
  "quartz", "river", "sage", "tide", "umbra", "violet", "willow", "zenith",
  "forest", "ocean", "solar", "nova", "pixel", "cloud", "stone", "flame",
];

const WORD_B = [
  "anchor", "beacon", "canyon", "drift", "echo", "falcon", "glimmer", "harbor",
  "island", "jupiter", "kernel", "lantern", "meadow", "nebula", "orchid", "prism",
  "quill", "ridge", "sparrow", "temple", "unity", "valley", "whisper", "yonder",
  "lamp", "bridge", "castle", "garden", "rocket", "signal", "trail", "wave",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Lowercase, strip non-alnum, collapse empties. */
export function normalizeWord(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40);
}

export function joinWords(
  w1: string,
  w2: string,
  joiner = "-",
  unique = false,
): string {
  const a = normalizeWord(w1);
  const b = normalizeWord(w2);
  if (!a || !b) {
    throw new Error("Both words must contain letters or digits after normalization");
  }
  let prefix = `${a}${joiner}${b}`;
  if (prefix.length > 50) prefix = prefix.slice(0, 50);
  if (unique) {
    const suffix = Math.random().toString(16).slice(2, 6);
    prefix = `${prefix}${joiner}${suffix}`;
  }
  return prefix;
}

export function randomWordPair(joiner = "-", unique = false): string {
  return joinWords(pick(WORD_A), pick(WORD_B), joiner, unique);
}

export function wordsFromSiteName(name: string, joiner = "-"): string {
  const parts = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length >= 2) return joinWords(parts[0]!, parts[1]!, joiner);
  if (parts.length === 1) return joinWords(parts[0]!, pick(WORD_B), joiner);
  return randomWordPair(joiner);
}
