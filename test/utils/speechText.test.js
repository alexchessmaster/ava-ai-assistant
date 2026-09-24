const test = require("node:test");
const assert = require("node:assert/strict");

const { toSpeechText, splitForSpeech } = require("../../src/utils/speechText.ts");

test("plain prose is left alone", () => {
  assert.equal(toSpeechText("The build finished at noon."), "The build finished at noon.");
});

test("emphasis markers are not read aloud", () => {
  assert.equal(
    toSpeechText("This is **important** and *urgent*."),
    "This is important and urgent."
  );
  assert.equal(
    toSpeechText("This is __important__ and _urgent_."),
    "This is important and urgent."
  );
  assert.equal(toSpeechText("This is ~~wrong~~."), "This is wrong.");
});

test("underscores inside identifiers are not emphasis", () => {
  // Reading snake_case as "snakcase" would be worse than saying the underscores.
  assert.equal(toSpeechText("Use snake_case_names here."), "Use snake_case_names here.");
});

test("a link is read as its label, and a bare URL is dropped", () => {
  assert.equal(
    toSpeechText("See [the docs](https://example.com/a/b) for that."),
    "See the docs for that."
  );
  assert.equal(toSpeechText("Read https://example.com/a/b carefully."), "Read carefully.");
});

test("an image is read as its alt text, not its source", () => {
  assert.equal(toSpeechText("![a red bicycle](shot.png) above"), "a red bicycle above");
});

test("a fenced code block is announced, never read", () => {
  const markdown = ["Before.", "```js", "const x = 1;", "```", "After."].join("\n");

  // Saying nothing would leave a listener unable to tell that anything was
  // skipped, and where a bare "code block" leaves them no better off.
  assert.equal(toSpeechText(markdown), "Before. Code omitted here. After.");
  // A caller can still ask for silence, or word it differently.
  assert.equal(toSpeechText(markdown, { codePlaceholder: "" }), "Before. After.");
  assert.equal(
    toSpeechText(markdown, { codePlaceholder: "code block" }),
    "Before. code block After."
  );
});

test("a placeholder is not mangled by the emphasis rules", () => {
  const markdown = ["Before.", "```", "x", "```", "After."].join("\n");
  assert.equal(
    toSpeechText(markdown, { codePlaceholder: "**block**" }),
    "Before. **block** After.",
    "the placeholder is inserted after the stripping passes"
  );
});

test("inline code keeps its text but loses the backticks", () => {
  assert.equal(toSpeechText("Run `npm test` now."), "Run npm test now.");
});

test("a snippet's own characters are never mistaken for markup", () => {
  // Inside code, a lone `*` and a `_` in an identifier are the code, not
  // emphasis — and the passes that strip emphasis would otherwise eat them.
  assert.equal(toSpeechText("Run `a * b` and `snake_case`."), "Run a * b and snake_case.");
});

test("a passage that is nothing but code is read, not announced", () => {
  // Selected on its own, a snippet is the thing that was asked for — there is
  // no prose for it to be an aside to. It is read verbatim, so its own `*` and
  // `snake_case` survive: no rule above ever saw it.
  const solo = ["```bash", "git reset --soft HEAD~1 # snake_case", "```"].join("\n");
  assert.equal(toSpeechText(solo), "git reset --soft HEAD~1 # snake_case");
  // Surrounding blank lines do not change that.
  assert.equal(toSpeechText(`\n\n${solo}\n\n`), "git reset --soft HEAD~1 # snake_case");

  // One line of prose is enough to make it an aside, and asides are not read.
  const mixed = ["Here's the fix:", "", "```bash", "git reset --soft HEAD~1", "```"].join("\n");
  assert.equal(toSpeechText(mixed), "Here's the fix: Code omitted here.");
});

test("a run of code blocks is announced once, not once per block", () => {
  const markdown = ["```js", "a", "```", "", "```js", "b", "```", "", "Done."].join("\n");

  // Three examples back to back are one omission to a listener.
  assert.equal(toSpeechText(markdown), "Code omitted here. Done.");
});

test("a snippet's own last character decides the block break", () => {
  // The join has to see what the line really ends with, and a masked snippet
  // hides that: without resolving it first, this grows a second full stop.
  const markdown = ["1. Build it with `docker build -t app .`", "2. Run the migration"].join("\n");
  assert.equal(toSpeechText(markdown), "Build it with docker build -t app . Run the migration");
});

test("a silenced code block leaves no stray punctuation behind", () => {
  const markdown = ["It ends like this.", "```", "x", "```", "", "And then this."].join("\n");

  // Silent when the caller asks for silence — but it must not count as a
  // sentence that ended, which is the "this. . And" shape this pins.
  assert.equal(
    toSpeechText(markdown, { codePlaceholder: "" }),
    "It ends like this. And then this."
  );
});

test("emoji are never read, in any of their multi-codepoint shapes", () => {
  assert.equal(toSpeechText("Great job \u{1F389}\u{1F44D}"), "Great job");
  // A zero-width joiner sequence goes as one piece, not as two pictographs.
  assert.equal(toSpeechText("We \u{1F469}\u{200D}\u{1F4BB} ship it"), "We ship it");
  // A flag is two regional indicators.
  assert.equal(toSpeechText("Berlin \u{1F1E9}\u{1F1EA} is nice"), "Berlin is nice");
  // A keycap is a digit plus a variation selector and an enclosing mark.
  assert.equal(toSpeechText("Press 1\u{FE0F}\u{20E3} now"), "Press 1 now");
});

test("a dingbat is dropped rather than read as a glyph name", () => {
  assert.equal(toSpeechText("\u{2705} Done \u{2714} Verified"), "Done Verified");
  assert.equal(toSpeechText("one \u{2022} two"), "one, two");
});

test("an arrow or a modifier key is worded, not spelled out", () => {
  assert.equal(toSpeechText("input \u{2192} output"), "input to output");
  assert.equal(toSpeechText("Press \u{2318}K to open it."), "Press command K to open it.");
});

test("a number sign before a number is spoken as one", () => {
  assert.equal(toSpeechText("Issue #42 is closed."), "Issue number 42 is closed.");
  // An approximate quantity keeps its approximation.
  assert.equal(toSpeechText("About ~5 minutes left."), "About approximately 5 minutes left.");
});

test("a dash between two words is a pause, and one inside a word is not", () => {
  assert.equal(toSpeechText("The plan - as agreed - is dead."), "The plan, as agreed, is dead.");
  assert.equal(
    toSpeechText("The well-known 2019\u{2013}2020 run."),
    "The well-known 2019\u{2013}2020 run."
  );
});

test("an entity is read as the character it stands for", () => {
  assert.equal(toSpeechText("Tom &amp; Jerry"), "Tom & Jerry");
  // Decoded before the tag rule runs, so an escaped `<` survives as a word.
  assert.equal(toSpeechText("5 &lt; 10"), "5 < 10");
});

test("headings, quotes and list markers lose their punctuation", () => {
  const markdown = ["# Title", "", "> quoted line", "", "- first", "- second", "", "1. step"].join(
    "\n"
  );

  // A full stop joins the blocks, because each of those *is* its own block:
  // leaving the line break as a space is what makes an engine read a list as
  // one long breath.
  assert.equal(toSpeechText(markdown), "Title. quoted line. first. second. step");
});

test("a table is read as its cells without the bars", () => {
  const markdown = ["| Name | Value |", "| --- | --- |", "| a | 1 |"].join("\n");
  assert.equal(toSpeechText(markdown), "Name Value. a 1");
});

test("a wrapped paragraph is not chopped into sentences", () => {
  // The flip side of the rule above: this break is a wrap inside one sentence,
  // so a full stop here would break the sentence in half.
  const wrapped = ["This paragraph was hard-wrapped by its", "editor at eighty columns."].join(
    "\n"
  );
  assert.equal(
    toSpeechText(wrapped),
    "This paragraph was hard-wrapped by its editor at eighty columns."
  );
});

test("a rule says nothing, and a heading of nothing but markup leaves nothing", () => {
  const markdown = ["---", "### \u{1F48E} Summary", "---"].join("\n");
  assert.equal(toSpeechText(markdown), "Summary");
});

test("a bulleted list is read as items, not as one run-on sentence", () => {
  const markdown = ["*   **Streaming Complexity:**", "*   **Audio Pipeline:**"].join("\n");

  // The reported shape: a list marker, padding, and bold. None of it is read.
  assert.equal(toSpeechText(markdown), "Streaming Complexity: Audio Pipeline:");
});

test("stray html tags are dropped", () => {
  assert.equal(toSpeechText("Hello <br/> there"), "Hello there");
});

test("whitespace is collapsed so the engine doesn't pause on blank lines", () => {
  assert.equal(toSpeechText("One.\n\n\n   Two."), "One. Two.");
});

test("empty input is empty", () => {
  assert.equal(toSpeechText(""), "");
  assert.equal(toSpeechText("   \n  "), "");
});

test("speech is split into sentence-sized chunks", () => {
  const chunks = splitForSpeech("One. Two. Three.", 10);
  assert.deepEqual(chunks, ["One. Two.", "Three."]);
});

test("short neighbours are merged so the engine isn't restarted for every fragment", () => {
  assert.deepEqual(splitForSpeech("Hi. Ok.", 220), ["Hi. Ok."]);
});

test("text with no terminal punctuation is still spoken", () => {
  assert.deepEqual(splitForSpeech("no full stop here"), ["no full stop here"]);
});

test("a single sentence longer than the limit is kept whole rather than cut mid-word", () => {
  const long = "a".repeat(300) + ".";
  assert.deepEqual(splitForSpeech(long, 50), [long]);
});
