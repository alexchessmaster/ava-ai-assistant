const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ENGINE_BINARY_NAME,
  KOKORO_MAX_THREADS,
  describeVoice,
  getEngineArchiveName,
  getEngineDownloadUrl,
  getKokoroModelConfig,
  getKokoroModelIds,
  getRequiredModelFiles,
  parseSpeakerNames,
} = require("../../src/helpers/kokoroModels");

/**
 * The speaker table is read back out of the engine's own `--debug=true` output
 * rather than from a hardcoded list, because the bundles ship no voice names at
 * all — `voices.bin` is a matrix of embeddings and the names live inside the
 * binary. The fixture below is a verbatim slice of that output, captured by
 * running the real engine against kokoro-en-v0_19.
 */
const REAL_ENGINE_OUTPUT = `
OfflineTtsModelConfig(vits=OfflineTtsVitsModelConfig(model="", lexicon="", tokens="", data_dir=""), kokoro=OfflineTtsKokoroModelConfig(model="mdl/model.onnx", voices="mdl/voices.bin", tokens="mdl/tokens.txt", lexicon="", data_dir="mdl/espeak-ng-data", length_scale=1, lang=""), num_threads=8, debug=True, provider="cpu")
sample_rate=24000
voice=en-us
speaker_names=af,af_bella,af_nicole,af_sarah,af_sky,am_adam,am_michael,bf_emma,bf_isabella,bm_george,bm_lewis
speaker2id=af->0,af_bella->1,af_nicole->2,af_sarah->3,af_sky->4,am_adam->5,am_michael->6,bf_emma->7,bf_isabella->8,bm_george->9,bm_lewis->10
n_speakers=11
id2speaker=0->af,1->af_bella,2->af_nicole,3->af_sarah,4->af_sky,5->am_adam,6->am_michael,7->bf_emma,8->bf_isabella,9->bm_george,10->bm_lewis
The text is: hi. Speaker ID: 0
`;

test("parseSpeakerNames reads the engine's own speaker table", () => {
  const voices = parseSpeakerNames(REAL_ENGINE_OUTPUT);

  assert.equal(voices.length, 11);
  assert.deepEqual(
    voices.map((v) => v.name),
    [
      "af",
      "af_bella",
      "af_nicole",
      "af_sarah",
      "af_sky",
      "am_adam",
      "am_michael",
      "bf_emma",
      "bf_isabella",
      "bm_george",
      "bm_lewis",
    ]
  );
  // The id is the index the engine expects back in `--sid`.
  assert.deepEqual(
    voices.map((v) => v.id),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  assert.equal(voices[1].label, "Bella (US female)");
  assert.equal(voices[9].label, "George (UK male)");
});

test("parseSpeakerNames tolerates output without a speaker table", () => {
  // Single-speaker models print no speaker_names line at all.
  assert.deepEqual(parseSpeakerNames("sample_rate=22050\nThe text is: hi."), []);
  assert.deepEqual(parseSpeakerNames(""), []);
  assert.deepEqual(parseSpeakerNames(null), []);
  assert.deepEqual(parseSpeakerNames(undefined), []);
});

test("parseSpeakerNames survives a multi-language speaker list", () => {
  // The multilingual bundles carry 53 and 103 voices; the parse must not care
  // about the count.
  const names = Array.from({ length: 103 }, (_, i) => `v${i}`).join(",");
  const voices = parseSpeakerNames(`speaker_names=${names}\nn_speakers=103`);
  assert.equal(voices.length, 103);
  assert.equal(voices[102].id, 102);
});

test("describeVoice names the accent and gender, and copes with a nameless base voice", () => {
  assert.equal(describeVoice("af_bella"), "Bella (US female)");
  assert.equal(describeVoice("am_adam"), "Adam (US male)");
  assert.equal(describeVoice("bf_emma"), "Emma (UK female)");
  assert.equal(describeVoice("zf_xiaobei"), "Xiaobei (Chinese female)");
  // `af` is the model's default voice and carries no given name — it must not
  // render a dangling empty parenthesis.
  assert.equal(describeVoice("af"), "US female");
  // Anything unrecognised is passed through rather than mangled.
  assert.equal(describeVoice("weird"), "weird");
});

test("every registered model can actually be driven by the engine's flags", () => {
  const ids = getKokoroModelIds();
  assert.ok(ids.length >= 2, "both bundles should be offered from day one");

  for (const id of ids) {
    const config = getKokoroModelConfig(id);
    assert.ok(config.downloadUrl.startsWith("https://"), `${id} needs a download URL`);
    assert.ok(config.expectedSizeBytes > 0, `${id} needs a verified size`);
    // A size of 0 would make validateFileSize accept a truncated archive.
    assert.ok(config.sizeMb > 0);
  }
});

test("the multilingual bundle declares a language, the v0.19 bundle does not", () => {
  // Bundles from v1.0 on refuse to start without `--kokoro-lang` or
  // `--kokoro-lexicon`; v0.19 predates the flag. Getting this backwards makes
  // one of them fail at speak time rather than at install time, so it is pinned.
  assert.equal(getKokoroModelConfig("kokoro-multi-lang-v1_1").ttsArgs.lang, "en");
  assert.deepEqual(getKokoroModelConfig("kokoro-en-v0_19").ttsArgs, {});
});

test("required files cover what the bundles actually ship", () => {
  const { files, dirs } = getRequiredModelFiles();
  // Verified against a real kokoro-en-v0_19 extract, which contains exactly
  // these plus LICENSE and README.md.
  assert.deepEqual(files.sort(), ["model.onnx", "tokens.txt", "voices.bin"]);
  assert.deepEqual(dirs, ["espeak-ng-data"]);
});

test("engine archive names resolve per platform and refuse the unknown", () => {
  assert.match(getEngineArchiveName("linux", "x64"), /linux-x64-shared\.tar\.bz2$/);
  assert.match(getEngineArchiveName("darwin", "arm64"), /osx-universal2-shared\.tar\.bz2$/);
  // macOS ships one universal archive for both architectures.
  assert.equal(getEngineArchiveName("darwin", "x64"), getEngineArchiveName("darwin", "arm64"));
  // An unsupported platform must resolve to null so the caller reports it
  // rather than downloading something that cannot run.
  assert.equal(getEngineArchiveName("aix", "ppc64"), null);
  assert.equal(getEngineDownloadUrl("aix", "ppc64"), null);
  assert.ok(getEngineDownloadUrl("linux", "x64").includes(ENGINE_BINARY_NAME.replace("-offline-tts", "")));
});

test("Windows is explicitly unsupported rather than silently broken", () => {
  // Pinned on purpose. The engine works on Windows only with upstream's PE
  // import rewrite for `onnxruntime.dll`, which cannot be verified from a Linux
  // checkout. Returning null here is what makes Settings say "not available"
  // instead of installing an engine the OS would fail to load.
  assert.equal(getEngineArchiveName("win32", "x64"), null);
  assert.equal(getEngineDownloadUrl("win32", "x64"), null);
});

test("thread count is capped where it was measured to be fastest", () => {
  // Measured on a 24-core machine: 4 threads took 3.60 s, 8 took 2.88 s, and 24
  // took 4.06 s for the same passage. The cap is the point, not an accident.
  assert.equal(KOKORO_MAX_THREADS, 8);
});
