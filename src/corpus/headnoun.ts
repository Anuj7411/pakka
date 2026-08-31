/**
 * Head-noun extraction, for certifying that a product can answer a request.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Pairing on token overlap alone produced conforming cases that were not
 * conforming. The Day 4 semantic run surfaced it:
 *
 *   request "nut free and gluten free CHOCOLATE"
 *   paired with "Blue Diamond ALMONDS Nut Thins Gluten Free CRACKER CRISPS"
 *
 * Three tokens matched — "nut", "free", "gluten" — all of them MODIFIERS. The
 * thing being asked for did not match at all. Token overlap measures how much
 * two strings have in common; it says nothing about whether one satisfies the
 * other. Raising the similarity threshold cannot fix it, because the bad pair
 * scores well by construction: it shares every modifier. The fix has to look at
 * WHICH token matched, not how many.
 *
 * ── Why the obvious heuristic fails on this corpus ──────────────────────────
 * "The head is the last noun" holds for a bare noun phrase ("carbon fiber
 * TRIPOD") and fails on real WebShop instructions, which are sentences with
 * trailing modifiers:
 *
 *   "buy a one pack of permanent HAIR DYE in espresso."
 *
 * Last-token extraction yields "espresso", which accepts Pilon Espresso Coffee
 * for a hair-dye request — the same class of error, one step further in.
 * Measured over 9,605 instructions, 73% open with a fixed verb phrase ("i am
 * looking for", "i need", "i want", …) and the head sits between that opener
 * and the first trailing clause.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Strip the opener, keep tokens up to the first clause boundary, drop units and
 * colours, take the last survivor. "of" is the interesting case: it passes the
 * head through after a container word ("one pack OF hair dye" → dye) and blocks
 * otherwise ("smartwatch bands OF tie dye color" → bands).
 *
 * ── It needs its own tokeniser ──────────────────────────────────────────────
 * similarity.tokenise() drops stopwords and tokens of two characters or fewer,
 * which is right for Jaccard overlap and fatal here: it removes "of", "for",
 * "with" and "that" — every marker this rule depends on. Reusing it silently
 * disabled every boundary and sent heads to the object of a trailing
 * prepositional phrase ("curtains FOR my living ROOM" → room). Head extraction
 * reads the raw words.
 *
 * ── Precision over recall, deliberately ─────────────────────────────────────
 * When the structure is not recognised this returns null and the instruction is
 * dropped. We need a few hundred pairs out of 9,605, so recall is nearly free
 * and precision is not: a rejected pair costs corpus size, an accepted-but-wrong
 * pair corrupts the labels every downstream number rests on.
 *
 * This remains a heuristic. It does not make the conforming labels verified —
 * only less wrong. The human validation still gates any published FP rate.
 */

/**
 * Every word, in order, nothing dropped. Deliberately NOT similarity.tokenise:
 * see the header. Possessives are folded ("women's" → "women") so they stem the
 * same on both sides.
 */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]s/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Fixed openers, longest first so "i am looking for" wins over "i am looking". */
const OPENERS = [
  'i am looking for',
  "i'm looking for",
  'iam looking for',
  'i am searching for',
  "i'm searching for",
  'i would like',
  'i am looking a',
  'iam looking a',
  'can you find me',
  'can you find',
  'please find me',
  'please find',
  'i am looking',
  "i'm looking",
  'looking for',
  'i need',
  'i want',
  'i like',
  'find me',
  'get me',
  'show me',
  'buy me',
  'give me',
  'search for',
  'buy',
];

/**
 * Tokens that end the head phrase. Relative pronouns and modifier-introducing
 * prepositions: everything after them describes the thing, and is not it.
 *
 * "and" is deliberately absent — "gluten free AND low calorie sparkling spritz"
 * must not truncate to "free".
 */
const BOUNDARY = new Set([
  'that', 'which', 'who', 'whose', 'where', 'when',
  // "on" and "over" are deliberately absent. In this corpus they appear inside
  // compound descriptors far more often than they introduce a qualifier:
  // "on-ear headset", "over-ear headphones", "over-the-door rack". Treating
  // them as boundaries dropped the request to nothing.
  'in', 'with', 'for', 'from', 'at', 'under', 'around',
  'about', 'made', 'is', 'are', 'has', 'have', 'it', 'also', 'pick', 'please',
  'i', 'must', 'should', 'need', 'want', 'choose', 'select',
  // Negation. "queen sized gray bed WITHOUT a box spring" must resolve to bed,
  // not spring — otherwise the head is a thing the buyer explicitly refused,
  // and it paired that request with a Spring Coil Mattress.
  'without', 'no', 'not', 'except', 'excluding', 'minus', 'avoid',
]);

/**
 * After these, "of" introduces the head rather than a modifier:
 * "one pack OF hair dye" → dye, but "smartwatch bands OF tie dye" → bands.
 */
const CONTAINERS = new Set([
  'pack', 'packs', 'box', 'boxes', 'set', 'sets', 'bottle', 'bottles', 'case',
  'cases', 'bag', 'bags', 'jar', 'jars', 'can', 'cans', 'tube', 'tubes',
  'roll', 'rolls', 'bundle', 'pair', 'pairs', 'piece', 'pieces', 'count',
  'carton', 'cartons', 'container', 'containers', 'unit', 'units', 'lot',
]);

/**
 * The subset of CONTAINERS that is pure packaging. A box or a bottle can be the
 * thing you are buying ("5 pack of amber glass spray BOTTLES"); a pack or a
 * count never is, and allowing it would match the "(Pack of 12)" suffix carried
 * by most grocery listings.
 */
const PACKAGING_ONLY = new Set([
  'pack', 'packs', 'count', 'lot', 'quantity', 'piece', 'pieces', 'unit', 'units',
]);

/**
 * Never a head noun in a product request. Units, packaging and colours sit at
 * the end of a phrase often enough to be mistaken for the thing being bought.
 */
const NEVER_HEAD = new Set([
  ...PACKAGING_ONLY,
  'inch', 'inches', 'ounce', 'ounces', 'pound', 'pounds', 'gram', 'grams', 'gr',
  'kilo', 'kilos', 'kilogram', 'litre', 'liter', 'litres', 'liters', 'ml', 'oz',
  'lb', 'lbs', 'foot', 'feet', 'ft', 'yard', 'yards', 'meter', 'metre', 'cm',
  'meters', 'metres', 'mm', 'size', 'sizes', 'color', 'colour', 'colors',
  'colours', 'style', 'styles', 'type', 'types', 'item', 'items', 'product',
  'products', 'quantity', 'flavor', 'flavour', 'flavors', 'flavours', 'scent',
  'shape', 'shapes', 'them', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'a', 'an', 'the', 'some', 'any', 'my',
  'black', 'white', 'blue', 'red', 'green', 'yellow', 'pink', 'purple',
  'orange', 'brown', 'grey', 'gray', 'silver', 'gold', 'golden', 'beige',
  'navy', 'turquoise', 'teal', 'ivory', 'tan', 'blonde', 'brunette', 'cream',
  'multicolor', 'multicolour', 'free', 'new', 'good', 'best', 'nice',
  // Size adjectives. Never the thing bought, and they strand at the end of a
  // phrase that names nothing: "i want a large blue one" resolved to "large".
  // "light" is deliberately absent — a wall light is a product.
  'large', 'small', 'medium', 'big', 'little', 'mini', 'tiny', 'huge',
  'xl', 'xxl', 'xxxl', 'xs', 'extra',
]);

/**
 * Heads that name a container, a supercategory or a part rather than a product.
 *
 * These match almost anything, and did: "duvet cover SET" took Hillsdale Bed
 * Set with Rails, "snack FOODS" took Goya FOODS Wafers on the brand token, and
 * "internet CABLE" took an HDMI cable. A generic head is not enough on its own,
 * so its qualifier must match too — "internet cable" then needs "internet",
 * which the HDMI listing does not have, while "hdmi cable" still passes.
 */
const GENERIC_HEADS = new Set([
  'set', 'sets', 'kit', 'kits', 'bag', 'bags', 'box', 'boxes', 'bundle',
  'bundles', 'collection', 'collections', 'food', 'foods', 'supply', 'supplies',
  'accessory', 'accessories', 'gear', 'cable', 'cables', 'cover', 'covers',
  'sleeve', 'sleeves', 'top', 'tops', 'gift', 'gifts', 'thing', 'things',
  'stuff', 'combo', 'assortment', 'variety', 'bundle',
]);

/**
 * Crude plural stem. The only property that matters is SYMMETRY: it runs on
 * both the request and the product name, so both sides must land on the same
 * string.
 *
 * Stripping "es" wholesale breaks that — "headphones" became "headphon" while
 * "headphone" stayed "headphone", and the pair stopped matching. "es" is only a
 * plural suffix after a sibilant (boxes, glasses, watches); elsewhere the "e"
 * belongs to the word.
 */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(?:s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** First sentence only: "…spritz. pick something in coconut" describes, not names. */
function firstSentence(text: string): string {
  const cut = text.search(/[.!?;]/);
  return cut === -1 ? text : text.slice(0, cut);
}

function stripOpener(lower: string): string {
  const t = lower.trimStart();
  for (const o of OPENERS) {
    if (t.startsWith(`${o} `)) return t.slice(o.length + 1);
  }
  return t;
}

/** A token that could name a product: not a unit, not a colour, not a number. */
function isContentful(t: string): boolean {
  return !NEVER_HEAD.has(t) && !/^\d+$/.test(t);
}

export interface Head {
  /** The thing being asked for. */
  readonly head: string;
  /**
   * The word that narrows a generic head, when the head needs narrowing.
   * "duvet cover set" → head "set", qualifier "duvet". null when the head
   * stands on its own, or when a generic head has nothing behind it.
   */
  readonly qualifier: string | null;
  readonly generic: boolean;
}

/**
 * The head phrase, or null when the structure is not recognised — in which case
 * the instruction is dropped rather than paired on a guess.
 */
export function headPhrase(text: string): Head | null {
  const body = stripOpener(firstSentence(text).toLowerCase());

  const phrase: string[] = [];
  for (const t of words(body)) {
    if (t === 'of') {
      // Partitive: "one pack OF hair dye" passes through, "bands OF tie dye"
      // does not.
      const prev = phrase.length > 0 ? phrase[phrase.length - 1]! : '';
      if (CONTAINERS.has(prev)) continue;
      break;
    }
    if (BOUNDARY.has(t)) break;
    phrase.push(t);
  }

  let i = phrase.length - 1;
  while (i >= 0 && !isContentful(phrase[i]!)) i--;
  if (i < 0) return null;

  const head = stem(phrase[i]!);
  if (!GENERIC_HEADS.has(phrase[i]!)) return { head, qualifier: null, generic: false };

  // Walk back past further generic words: "candy mix GIFT SET" must narrow to
  // "mix", not to "gift", which is as generic as "set".
  let j = i - 1;
  while (j >= 0 && (!isContentful(phrase[j]!) || GENERIC_HEADS.has(phrase[j]!))) j--;
  return { head, qualifier: j >= 0 ? stem(phrase[j]!) : null, generic: true };
}

/** The head noun alone. Kept for callers that do not need the qualifier. */
export function headNoun(text: string): string | null {
  return headPhrase(text)?.head ?? null;
}

/**
 * Clause boundaries on the PRODUCT side, which are not the request side's.
 *
 * A request is a sentence, so relative pronouns and most prepositions end the
 * head phrase. A listing name is not: "Over-Ear Headphones", "On-Ear Monitors",
 * "All-in-One Printer" carry prepositions INSIDE the name. Reusing the request
 * set truncated "Bose Over-Ear-Headphones" to "Bose" and rejected the pair.
 *
 * Only these two reliably introduce a qualifier in a listing name — "Case FOR
 * Samsung Galaxy", "Curtains WITH Grommets".
 */
const PRODUCT_BOUNDARY = new Set(['for', 'with']);

/**
 * The part of a product name that says what the product IS.
 *
 * Listing names append qualifiers after commas: pack size, colour, and —
 * the case that matters — flavour. "Blue Diamond … Cracker Crisps, Hint of Sea
 * Salt, 4.25 Oz Boxes" carries "salt", so a request for sea salt matched a box
 * of crackers on a token that was never the product. Only the first segment
 * names the thing; everything after a comma describes it.
 */
function productHeadSegment(name: string): string[] {
  const first = name.split(',')[0] ?? name;
  const out: string[] = [];
  for (const t of words(first)) {
    if (t === 'of') {
      const prev = out.length > 0 ? out[out.length - 1]! : '';
      if (CONTAINERS.has(prev)) continue;
      break;
    }
    if (PRODUCT_BOUNDARY.has(t)) break;
    out.push(t);
  }
  return out;
}

/**
 * Can this product plausibly BE the thing requested?
 *
 * Not "are these texts similar" — "does the product carry the head noun". This
 * is the check that rejects almond crackers for a chocolate request.
 */
export function carriesHeadNoun(requestText: string, productName: string): boolean {
  const h = headPhrase(requestText);
  if (h === null) return false;
  const productTokens = new Set(productHeadSegment(productName).map(stem));

  // A generic head proves nothing by itself. Require the qualifier, and reject
  // outright when there is no qualifier to require.
  if (h.generic) {
    if (h.qualifier === null) return false;
    if (!carries(productTokens, h.qualifier)) return false;
  }
  return carries(productTokens, h.head);
}

function carries(productTokens: ReadonlySet<string>, head: string): boolean {
  return productTokens.has(head);
}
