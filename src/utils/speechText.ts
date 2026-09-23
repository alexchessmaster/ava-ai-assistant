/**
 * Turns a rendered reply into something worth listening to.
 *
 * A markdown reply read literally is unusable: the engine says "asterisk
 * asterisk important asterisk asterisk", spells out URLs character by
 * character, and reads a code block as punctuation soup. Everything here exists
 * to stop the engine hearing what a reader would see.
 */

export interface SpeechTextOptions {
  /**
   * Said in place of a fenced code block, which is never read aloud. Passed in
   * by the caller so it can be translated; empty means the block is silently
   * dropped.
   */
  codePlaceholder?: string;
}

// Fenced blocks are removed before anything else looks at the text, so their
// contents can't be mangled by the emphasis and link rules. A sentinel keeps
// the placeholder itself safe from those rules on the way through.
const CODE_SENTINEL = "__OPENWHISPR_CODE_BLOCK__";

export function toSpeechText(markdown: string, options: SpeechTextOptions = {}): string {
  if (!markdown) return "";
  const { codePlaceholder = "" } = options;

  let text = markdown;

  // Fenced code blocks: contents are not prose and must never be read.
  text = text.replace(/```[\s\S]*?```/g, ` ${CODE_SENTINEL} `);
  text = text.replace(/~~~[\s\S]*?~~~/g, ` ${CODE_SENTINEL} `);
  // Inline code keeps its text but loses the ticks.
  text = text.replace(/`([^`\n]*)`/g, "$1");

  // Images become their alt text — dropping them would lose a caption.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links keep the label and drop the target.
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");

  // A bare URL is noise when spoken.
  text = text.replace(/<?https?:\/\/\S+>?/g, "");

  // Table separator rows carry no content; the bars either side are structure.
  text = text.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ");
  text = text.replace(/\|/g, " ");

  // Line-leading structure: quotes, headings, list markers.
  text = text.replace(/^\s{0,3}>+\s?/gm, "");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/gm, "");

  // Emphasis. Underscores are only emphasis at word boundaries, or an
  // identifier like snake_case would come out as snakcase.
  text = text.replace(/\*{1,3}([^*\n]+)\*{1,3}/g, "$1");
  text = text.replace(/(?<![\w])_{1,3}([^_\n]+)_{1,3}(?![\w])/g, "$1");
  text = text.replace(/~~([^~\n]+)~~/g, "$1");

  // Any markup left is a tag, not something to say.
  text = text.replace(/<[^>]+>/g, " ");

  text = text.split(CODE_SENTINEL).join(codePlaceholder ? ` ${codePlaceholder} ` : " ");

  return text.replace(/\s+/g, " ").trim();
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
  const sentences = text.match(/[^.!?…\n]+[.!?…]*\s*/g) ?? [];
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
