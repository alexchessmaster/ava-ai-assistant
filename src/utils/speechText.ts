/**
 * Turns a rendered reply into something worth listening to.
 *
 * A markdown reply read literally is unusable: the engine says "asterisk
 * asterisk important asterisk asterisk", reads "hash hash hash Summary" for a
 * heading, spells a URL out character by character, and turns a code block into
 * punctuation soup. Everything here exists to stop the engine hearing what a
 * reader would see.
 *
 * The one caller that is not a reply is the read-aloud panel, which reads text
 * the user selected or pasted. That text is markdown too — a note, a README, a
 * reply they copied — so it gets every rule below, unchanged. Nothing about the
 * pass depends on which button was pressed: what to do with a code block is
 * decided by the text itself, see `SOLO_FENCE`.
 */

export interface SpeechTextOptions {
  /**
   * Said in place of a fenced code block, which is never read aloud. Defaults
   * to the wording below; passed in by the caller so it can be translated, and
   * an empty string means the block is dropped without a word.
   */
  codePlaceholder?: string;
}

/** Said where a block was, so a listener knows something was left out. */
const DEFAULT_CODE_PLACEHOLDER = "Code omitted here.";

/**
 * A passage that is nothing but one fenced block — no prose, no heading, no
 * second block.
 *
 * That is the one case where the code is read rather than announced: there is
 * no prose for it to be an aside to, so it is not an aside, it is the thing
 * that was selected or pasted. Asked for by name, it is read verbatim.
 */
const SOLO_FENCE = /^(```|~~~)[^\n]*\n([\s\S]*?)\1$/;

// Code is lifted out of the text before any other rule runs and put back
// afterwards, because a snippet's own characters are not markdown: a lone `*`
// in `a * b`, the `_` in `snake_case`, a URL in backticks would every one of
// them be mangled by the passes below. Hiding it is the only way to keep it.
// The delimiters are private-use code points, which no real text contains —
// and which the emoji pass below leaves alone.
const SENTINEL_OPEN = "\u{E000}";
const SENTINEL_CLOSE = "\u{E001}";
const SENTINEL = new RegExp(`${SENTINEL_OPEN}(\\d+)${SENTINEL_CLOSE}`, "g");

/** A horizontal rule, or a table's separator row: structure, no words. */
const RULE_LINE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/** Bullet glyphs, which markdown's `-`/`*`/`+` rules do not cover. */
const BULLETS = "\\u00B7\\u2022-\\u2025\\u2027\\u25AA\\u25AB\\u25CB\\u25CF\\u25E6";
const INLINE_BULLET = new RegExp(`\\s*[${BULLETS}]\\s*`, "g");
const LEADING_BULLET = new RegExp(`^\\s*[${BULLETS}]\\s*`);

/**
 * A line that opens a block: a heading, a quote, a list item, a table row.
 *
 * This is what tells a line break that ends a sentence from one that merely
 * wraps a paragraph, and getting it wrong is the difference between a list read
 * as items and a list read as one long breath.
 */
const BLOCK_START = new RegExp(
  `^\\s{0,3}(?:#{1,6}\\s|>|[-*+]\\s|\\d{1,3}[.)]\\s|\\||[${BULLETS}])`
);

/** A character the sentence before a block break already ended on. */
const SENTENCE_END = /[.!?\u{2026}:;,]$/u;

/**
 * Emoji, and the symbol blocks an engine reads as glyph names — "sparkles",
 * "heavy check mark", "rightwards arrow" — rather than as prose. Zero-width
 * joiners and variation selectors are in here too, so a multi-codepoint emoji
 * leaves in one piece instead of leaving its pieces behind.
 */
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{1FC00}-\u{1FFFD}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2900}-\u{297F}\u{2460}-\u{24FF}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FE0E}\u{FE0F}\u{20E3}\u{FEFF}\u{FFFD}]/gu;

/**
 * Modifier-key glyphs are worded, not dropped: "⌘K" spoken as "K" is a
 * different instruction from "press Command-K", and the emoji pass below would
 * otherwise swallow the glyph entirely.
 */
const KEY_GLYPHS: Record<string, string> = {
  "\u{2318}": " command ",
  "\u{2303}": " control ",
  "\u{2325}": " option ",
  "\u{21E7}": " shift ",
  "\u{21EA}": " caps lock ",
  "\u{232B}": " delete ",
  "\u{2326}": " delete ",
  "\u{23CE}": " enter ",
  "\u{238B}": " escape ",
  "\u{21E5}": " tab ",
};
const KEY_GLYPH =
  /[\u{2318}\u{2303}\u{2325}\u{21E7}\u{21EA}\u{232B}\u{2326}\u{23CE}\u{238B}\u{21E5}]/gu;

/** An arrow between two things says how they relate; a glyph name does not. */
const TO_ARROW = /[\u{2192}\u{2794}\u{279C}\u{279E}\u{27A1}\u{27A4}\u{27F6}]/gu;
const FROM_ARROW = /[\u{2190}\u{2B05}\u{27F5}]/gu;

/** A dash standing between two words, which is a pause and not a word. */
const SPACED_DASH = /\s+[-\u{2013}\u{2014}]+\s+/gu;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u{2014}",
  ndash: "\u{2013}",
  hellip: "\u{2026}",
  lsquo: "\u{2018}",
  rsquo: "\u{2019}",
  ldquo: "\u{201C}",
  rdquo: "\u{201D}",
};

/** Drops a block's marker, leaving the words the block was made of. */
function stripLineMarker(line: string): string {
  if (RULE_LINE.test(line) || TABLE_SEPARATOR.test(line)) return "";
  return line
    .replace(/^\s{0,3}>+\s?/, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/, "")
    .replace(LEADING_BULLET, "");
}

/** Everything that is markup on a single line of prose. */
function stripInline(line: string): string {
  let out = line;

  // Images become their alt text — dropping them would lose a caption.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links keep the label and drop the target.
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
  // Footnote references are pointers, not words.
  out = out.replace(/\[\^[^\]]*\]/g, " ").replace(/\[\d{1,3}\]/g, " ");

  // A bare URL is noise when spoken.
  out = out.replace(/<?https?:\/\/\S+>?/g, "");

  // Entities first, so an escaped tag is still a tag when the rule below runs,
  // and an escaped `<` comes out as "less than" rather than as leftover markup.
  out = out.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] !== "#") return ENTITIES[body.toLowerCase()] ?? match;
    const hexadecimal = body[1] === "x" || body[1] === "X";
    const point = parseInt(hexadecimal ? body.slice(2) : body.slice(1), hexadecimal ? 16 : 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });

  // Table bars are structure; the cells either side are the content.
  out = out.replace(/\|/g, " ");

  // Emphasis. Underscores are only emphasis at word boundaries, or an
  // identifier like snake_case would come out as snakcase.
  out = out.replace(/\*{1,3}([^*\n]+)\*{1,3}/g, "$1");
  out = out.replace(/(?<![\w])_{1,3}([^_\n]+)_{1,3}(?![\w])/g, "$1");
  out = out.replace(/~~([^~\n]+)~~/g, "$1");

  // Any markup left is a tag, not something to say. Anchored on a letter or a
  // slash so that arithmetic — "if a < b > c" — is not mistaken for a tag.
  out = out.replace(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g, " ");

  out = out.replace(KEY_GLYPH, (glyph) => KEY_GLYPHS[glyph]);
  out = out.replace(TO_ARROW, " to ").replace(FROM_ARROW, " from ");
  out = out.replace(INLINE_BULLET, ", ");
  out = out.replace(EMOJI, " ");

  // A number sign introducing a number is how it is said. Headings are gone by
  // here, so what is left is "#42" rather than a marker.
  out = out.replace(/#(?=\s?\d)/g, " number ");
  // An approximate quantity keeps its approximation.
  out = out.replace(/~(?=\s?\d)/g, " approximately ");
  // Whatever markup survives is punctuation the engine would name out loud.
  out = out.replace(/[*#`~^]/g, "");
  // A lone underscore is markup; one between two characters is part of a word.
  out = out.replace(/(?<!\w)_+|_+(?!\w)/g, "");
  // A dash between words is a pause, and reading it as "dash" derails the
  // sentence. One inside a word, or in a range like 2019–2020, is neither.
  out = out.replace(SPACED_DASH, ", ");

  return out;
}

export function toSpeechText(markdown: string, options: SpeechTextOptions = {}): string {
  if (!markdown) return "";
  const { codePlaceholder = DEFAULT_CODE_PLACEHOLDER } = options;

  // The block logic below only knows about \n, and \r and the Unicode line
  // separators are line breaks too.
  let text = markdown.replace(/\r\n?|[\u{2028}\u{2029}]/gu, "\n");

  // Asked for by name, read as it is: no rule below applies to a snippet, which
  // is why this returns before any of them run. An empty block leaves nothing.
  const solo = text.trim().match(SOLO_FENCE);
  if (solo) return solo[2].replace(/\s+/g, " ").trim();

  const code: (string | null)[] = [];
  const mask = (content: string | null) => {
    code.push(content);
    return `${SENTINEL_OPEN}${code.length - 1}${SENTINEL_CLOSE}`;
  };

  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_match) => ` ${mask(null)} `);
  text = text.replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, (_match) => ` ${mask(null)} `);
  // A fence the model left open, or a stray one. Its ticks are structure and go,
  // and its body is read as prose — there is nothing better to do with text that
  // was never closed, and dropping it would lose the only copy.
  text = text.replace(/^\s{0,3}(?:```|~~~)[^\n]*$/gm, " ");
  // Inline code keeps its text but loses the ticks.
  text = text.replace(/`([^`\n]+)`/g, (_match, body) => mask(body));

  // A snippet goes back in here, once every rule above has had its turn and
  // before the line joins are decided: the join has to see what the line
  // actually ends with, and a sentinel hides that. No padding either — a block
  // carries the spaces that surrounded its fence, and inline code sits against
  // whatever punctuation followed it, so padding would leave a space before a
  // full stop.
  const resolve = (line: string) =>
    line.replace(SENTINEL, (_match, index: string) => {
      const content = code[Number(index)];
      if (content === null) return codePlaceholder;
      // A snippet's own line breaks are not sentence breaks. It is read as one
      // run of words, and no rule above ever saw it.
      return content.replace(/\s+/g, " ").trim();
    });

  let out = "";
  let pendingBreak = false;
  let previous = "";

  for (const raw of text.split("\n")) {
    // Empty means a blank line, a rule, a table separator, a line that was
    // nothing but a marker, or a code block that is announced rather than read
    // — so the block before it ended here.
    const body = resolve(stripInline(stripLineMarker(raw))).trim();
    if (!body) {
      if (out) pendingBreak = true;
      continue;
    }

    // Two blocks back to back are one omission to a listener, not two. Reading
    // the same sentence twice in a row is how a reply with a few examples in it
    // turns into a chore.
    if (body === codePlaceholder && previous === codePlaceholder) continue;

    if (out) {
      // Markdown's own line breaks are the guide. A blank line, a new list
      // item, a heading or a table row ends the sentence before it even with no
      // full stop, which is what stops a bulleted list running together into
      // one breath; a line that carries on the same paragraph is only a wrap,
      // and a full stop there would break a sentence in half.
      const endsBlock = pendingBreak || BLOCK_START.test(raw) || RULE_LINE.test(raw);
      out += endsBlock && !SENTENCE_END.test(out) ? ". " : " ";
    }

    out += body;
    previous = body;
    pendingBreak = false;
  }

  return out.replace(/\s+/g, " ").trim();
}

/** Roughly one breath per chunk; also the point most engines stop truncating. */
const MAX_CHUNK_CHARS = 220;

/**
 * Splits speech into sentence-sized chunks. A single long utterance gets cut
 * off part-way through by some engines, so replies are queued a sentence at a
 * time instead; short neighbours are merged so the engine isn't restarted for
 * every fragment.
 */
export function splitForSpeech(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const sentences = text.match(/[^.!?\u{2026}\n]+[.!?\u{2026}]*\s*/gu) ?? [];
  const chunks: string[] = [];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    const previous = chunks[chunks.length - 1];
    if (previous && previous.length + trimmed.length + 1 <= maxChars) {
      chunks[chunks.length - 1] = `${previous} ${trimmed}`;
    } else {
      chunks.push(trimmed);
    }
  }

  return chunks;
}
