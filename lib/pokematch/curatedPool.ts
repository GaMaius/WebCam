// The species PokéMatch is willing to hand back as a "you look like this" result.
//
// Why a curated pool at all: the fun of this app depends on RECOGNITION. Being
// told you resemble a species nobody can picture isn't a result, it's a shrug.
// The embedding shortlist, left alone, surfaces plenty of those.
//
// The pool is COMPUTED from a ban list and an inclusion list rather than
// written out as 200 literal entries, so editing it means editing a rule
// rather than auditing a wall of slugs. Order is by pokedex number, which
// makes the numbering the judge sees stable across runs.
//
// Historical note: entries used to carry a hand-written Korean `look`
// description (~46 tokens each), because the judge was a TEXT-ONLY model and
// had to compare two pieces of prose. The judge is now a vision model that
// sees the face and already knows what these species look like, so the
// descriptions are gone — which is exactly what made a 200+ pool affordable
// (~5.6 tokens per species instead of ~46). Don't reintroduce them without
// re-checking the token budget in CLAUDE.md.

import type { PokedexEntry } from "./matcher";

/**
 * Never shown as a result, regardless of how well the embedding scores them.
 * Somebody's face is the input — the output has to be something they'd enjoy
 * being shown. Grouped by why.
 */
export const BANNED_SLUGS = new Set([
  // Filth / decay — reads as an insult no matter how it's phrased.
  "grimer", "muk", "grimer_alola", "muk_alola", "koffing", "weezing", "weezing_galar",
  "trubbish", "garbodor", "gulpin", "swalot", "stunfisk", "stunfisk_galar", "pyukumuku",
  "amoonguss", "foongus", "shiinotic", "morelull", "slugma", "magcargo",
  // ⚠️ Weight / laziness jokes used to be excluded here (Snorlax, Slowpoke and
  // their families). The user judged those fine to receive, so they're allowed.
  // The categories below stay: being told you resemble living sludge, or a
  // design with a caricature history, is a different thing from being told you
  // look like Snorlax.
  // "Useless" jokes.
  "magikarp", "feebas", "sunkern", "metapod", "kakuna", "silcoon", "cascoon",
  // Unsettling or historically criticized designs.
  "hypno", "drowzee", "jynx", "smoochum", "mr_mime", "mime_jr", "mr_rime",
  "spiritomb", "yamask", "cofagrigus", "banette", "shuppet",
  // No face to compare a person to at all.
  "voltorb", "electrode", "voltorb_hisui", "electrode_hisui", "ditto", "unown",
  "magnemite", "magneton", "magnezone", "geodude", "graveler", "golem",
]);

/**
 * Post-gen-1 species famous enough that a Korean player pictures them
 * instantly. Gen 1 comes in wholesale (see buildCuratedPool) because it's the
 * generation everyone knows; everything after it has to earn its place here.
 */
export const EXTRA_FAMOUS = [
  // Eeveelutions — distinct impressions, universally known.
  "espeon", "umbreon", "vaporeon", "jolteon", "flareon", "leafeon", "glaceon", "sylveon",
  // ⚠️ ADDED BECAUSE THE JUDGE ASKED FOR THEM. The ?debug line "POOL이 거부한
  // 이름" reports every species the model named that this list didn't contain,
  // which turns a guessing game into a maintenance loop: these four came from
  // one real run (Aipom, Braixen, Emolga, Purrloin) and none is obscure —
  // Braixen is the middle stage of a line whose other two members were already
  // here. Add to this group when that line names something recognisable; don't
  // try to anticipate it.
  "aipom", "ambipom", "braixen", "emolga", "purrloin", "liepard",
  // Gen 2
  "chikorita", "cyndaquil", "totodile", "typhlosion", "feraligatr", "meganium",
  "togepi", "togetic", "togekiss", "marill", "azumarill", "ampharos", "mareep",
  "scizor", "heracross", "umbreon", "houndoom", "houndour", "tyranitar", "larvitar",
  "sneasel", "weavile", "lugia", "ho_oh", "suicune", "entei", "raikou", "celebi",
  "skarmory", "miltank", "girafarig", "murkrow", "honchkrow",
  // Gen 3
  "treecko", "torchic", "mudkip", "sceptile", "blaziken", "swampert",
  "gardevoir", "gallade", "ralts", "kirlia", "absol", "salamence", "metagross",
  "rayquaza", "groudon", "kyogre", "latios", "latias", "flygon", "altaria", "milotic",
  // Gen 4
  "turtwig", "chimchar", "piplup", "torterra", "infernape", "empoleon",
  "lucario", "riolu", "garchomp", "gible", "luxray", "shinx", "froslass",
  "glaceon", "rotom", "darkrai", "dialga", "palkia", "giratina", "gliscor",
  "weavile", "mamoswine", "roserade", "staraptor",
  // Gen 5
  "zorua", "zoroark", "chandelure", "hydreigon", "haxorus", "excadrill",
  "krookodile", "scrafty", "bisharp", "volcarona", "zekrom", "reshiram",
  "emboar", "serperior", "samurott", "lilligant", "sawsbuck",
  // Gen 6
  "greninja", "delphox", "chesnaught", "froakie", "fennekin", "chespin",
  "goodra", "noivern", "aegislash", "talonflame", "pangoro", "pancham",
  "sylveon", "hawlucha", "malamar", "trevenant", "xerneas", "yveltal",
  // Gen 7
  "decidueye", "incineroar", "primarina", "rowlet", "litten", "popplio",
  "mimikyu", "meowstic", "oranguru", "salazzle", "kommo_o",
  "toucannon", "lurantis", "mudsdale", "lycanroc_midday", "meloetta_aria",
  // Gen 8
  "cinderace", "inteleon", "rillaboom", "scorbunny", "sobble", "grookey",
  "corviknight", "dragapult", "obstagoon", "grimmsnarl", "toxtricity",
  "zacian", "zamazenta", "sirfetch_d", "boltund", "perrserker",
  // Gen 9
  "meowscarada", "skeledirge", "quaquaval", "sprigatito", "fuecoco", "quaxly",
  "ceruledge", "armarouge", "kingambit", "annihilape", "tinkaton", "gholdengo",
  "lokix", "maushold", "pawmot", "baxcalibur", "koraidon", "miraidon",
];

/**
 * ⚠️ DEFINED BUT NOT APPLIED — kept as the record of a failed fix.
 *
 * The judge kept returning these famous mascots for every face, so they were
 * removed from its pool. It did not work. Blocking Pikachu and Psyduck did not
 * push the model toward specific matches; it picked the next generic thing
 * instead — Porygon, Staryu, Starmie, Poliwag — which resembled the person
 * less, not more, and read as bizarre rather than safe.
 *
 * The lesson: reaching for mascots was a SYMPTOM of a low temperature
 * collapsing onto the argmax, not a property of the pool. Removing the top of
 * a bad ranking just exposes the next entry of the same bad ranking. It is
 * fixed at the temperature instead (see the route).
 *
 * Don't re-apply this without changing something else first.
 */
export const JUDGE_DEFAULT_SLUGS = new Set([
  "pikachu", "psyduck", "golduck", "clefairy", "clefable",
  "togepi", "togetic", "chansey", "mew", "mewtwo",
]);

// ⚠️ Filtering the pool by pokedex `shape` was tried here and reverted.
//
// The judge described "두툼한 윗입술" on Omastar and "날카로운 눈매" on Zubat,
// which has no eyes, so dropping faceless species looked like the fix. It
// isn't: `shape` is the Pokedex's BODY-shape taxonomy, not a statement about
// whether a species has a face. Mimikyu is "squiggle" and plainly has one;
// birds are "wings" and have faces; Omastar is "tentacles" and has a face too.
// A test on the recognizable staples caught it immediately.
//
// This was the same mistake as the embedding shortlist: filtering on a proxy
// that does not measure the thing being filtered for. The invented anatomy is
// the MODEL's knowledge failing, and no metadata in this repo can correct it —
// the per-species appearance text that could have (the old `look` field) was
// removed to afford a 291-species pool.

const LAST_GEN1_DEX = 151;

/**
 * Everything the judge's answer is allowed to resolve to.
 *
 * ⚠️ THIS IS THE GATE NOW, NOT buildCuratedPool. Measured: on the first working
 * vision run the model named eight species and FOUR were deleted for being
 * outside the curated pool — Aipom, Braixen, Emolga and Purrloin. None of those
 * is obscure; Braixen is the middle stage of a line whose other two members are
 * both in EXTRA_FAMOUS. The user saw four cards where the page promises five,
 * and the missing ones were perfectly good answers.
 *
 * The curated pool was built to serve two purposes, and only one of them still
 * needs it:
 *   - RECOGNITION ("don't name a species nobody can picture"). This is now the
 *     prompt's job and the model's. It is choosing Emolga and Aipom, not Klink,
 *     so it does not need a whitelist to keep it sensible — and a whitelist of
 *     294 out of ~1000 deletes half of a good answer to prevent a bad one that
 *     isn't happening.
 *   - THE BAN LIST ("somebody's face is the input"). That is a guarantee, not a
 *     preference, so it stays enforced here.
 *
 * buildCuratedPool is kept because EXTRA_FAMOUS still documents which post-gen-1
 * species we consider household names, and the tests hold the ban list to
 * account through it.
 */
export function buildJudgeAllowlist(
  pokedex: Record<string, PokedexEntry>,
  availableSlugs: Iterable<string>
): string[] {
  const available = availableSlugs instanceof Set ? availableSlugs : new Set(availableSlugs);
  return [...available]
    .filter((slug) => pokedex[slug] && !BANNED_SLUGS.has(slug))
    .sort((a, b) => (pokedex[a].dex ?? 9999) - (pokedex[b].dex ?? 9999) || a.localeCompare(b));
}

/**
 * Builds the ordered candidate pool from the shipped pokedex.
 *
 * Gen 1 wholesale + EXTRA_FAMOUS, minus BANNED_SLUGS, minus anything not
 * actually present in the gallery (a slug with no embedding or sprite would
 * render as a broken row). Sorted by dex so the numbering the judge sees is
 * deterministic — the model answers with positions in this list, so a
 * non-deterministic order would silently scramble results.
 */
export function buildCuratedPool(
  pokedex: Record<string, PokedexEntry>,
  availableSlugs: Iterable<string>,
  options?: { excludeJudgeDefaults?: boolean }
): string[] {
  const available = availableSlugs instanceof Set ? availableSlugs : new Set(availableSlugs);
  const chosen = new Set<string>();

  for (const [slug, entry] of Object.entries(pokedex)) {
    if (entry?.dex && entry.dex <= LAST_GEN1_DEX && !entry.slug?.includes("_")) chosen.add(slug);
  }
  for (const slug of EXTRA_FAMOUS) chosen.add(slug);

  const dropDefaults = options?.excludeJudgeDefaults === true;
  return [...chosen]
    .filter(
      (slug) =>
        !BANNED_SLUGS.has(slug) &&
        !(dropDefaults && JUDGE_DEFAULT_SLUGS.has(slug)) &&
        available.has(slug) &&
        pokedex[slug]
    )
    .sort((a, b) => (pokedex[a].dex ?? 9999) - (pokedex[b].dex ?? 9999) || a.localeCompare(b));
}
