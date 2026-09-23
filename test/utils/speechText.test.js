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

test("a fenced code block is replaced, never read", () => {
  const markdown = ["Before.", "```js", "const x = 1;", "```", "After."].join("\n");

  assert.equal(
    toSpeechText(markdown, { codePlaceholder: "code block" }),
    "Before. code block After."
  );
  // Without a placeholder the block is dropped silently.
  assert.equal(toSpeechText(markdown), "Before. After.");
});

test("a placeholder is not mangled by the emphasis rules", () => {
  const markdown = ["```", "x", "```"].join("\n");
  assert.equal(
    toSpeechText(markdown, { codePlaceholder: "**block**" }),
    "**block**",
    "the placeholder is inserted after the stripping passes"
  );
});

test("inline code keeps its text but loses the backticks", () => {
  assert.equal(toSpeechText("Run `npm test` now."), "Run npm test now.");
});

test("headings, quotes and list markers lose their punctuation", () => {
  const markdown = ["# Title", "", "> quoted line", "", "- first", "- second", "", "1. step"].join(
    "\n"
  );

  assert.equal(toSpeechText(markdown), "Title quoted line first second step");
});

test("a table is read as its cells without the bars", () => {
  const markdown = ["| Name | Value |", "| --- | --- |", "| a | 1 |"].join("\n");
  assert.equal(toSpeechText(markdown), "Name Value a 1");
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
