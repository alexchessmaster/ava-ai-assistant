/**
 * Metadata for the Kokoro text-to-speech models, and the pure helpers that read
 * them.
 *
 * This deliberately does not live in `src/models/modelRegistryData.json`. That
 * file is upstream's single source of truth for inference models, and this fork
 * keeps its additions in files of its own so merges stay small. Nothing here
 * needs to be visible to the upstream model pickers.
 *
 * Sizes are the compressed archive sizes from the release; `expectedSizeBytes`
 * is what the downloader verifies against. The extracted model is larger — the
 * English bundle is ~354 MB on disk against a ~305 MB archive — which is why
 * `kokoroDownload.js` budgets disk against the archive and lets extraction
 * double it.
 *
 * Measurements behind the defaults (Linux x64, 24 cores, 2026-09):
 *   - synthesis runs at ~0.17 RTF (about 6x faster than realtime) with
 *     `--num-threads=8`; 4 threads was slower and 24 was slower still, because
 *     a model this small thrashes when oversubscribed. See KOKORO_MAX_THREADS.
 *   - model load costs ~1.4 s per process, so each spawn is expensive enough
 *     that we synthesize a whole chunk at a time rather than a sentence at a
 *     time. See `kokoroTts.js`.
 */

const MODEL_RELEASE_BASE =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models";

/**
 * Files every Kokoro bundle must contain before we call it installed. The
 * `espeak-ng-data` directory is checked separately because it is a directory.
 *
 * Deliberately a shared core rather than a per-bundle list: the bundles differ
 * in ways we do not care about (the multilingual one adds lexicon files for
 * Mandarin) and pinning them per bundle would break on a bundle revision for no
 * benefit.
 */
const REQUIRED_MODEL_FILES = ["model.onnx", "tokens.txt", "voices.bin"];

const REQUIRED_MODEL_DIRS = ["espeak-ng-data"];

/**
 * The engine is a separate download from the model. Keeping them apart means a
 * second voice bundle costs only the bundle, which matters when each one is
 * ~350 MB extracted.
 *
 * ARCHIVES maps our name for an engine build to the sherpa-onnx release asset
 * that contains it. The tarball holds a full sherpa-onnx distribution; we
 * extract only the TTS binary and the shared libraries it needs, so ~35 MB of
 * the 28 MB archive survives.
 */
const ENGINE_VERSION = "1.13.8";

const ENGINE_ARCHIVES = {
  "linux-x64": `sherpa-onnx-v${ENGINE_VERSION}-linux-x64-shared.tar.bz2`,
  "linux-arm64": `sherpa-onnx-v${ENGINE_VERSION}-linux-aarch64-shared.tar.bz2`,
  "darwin-x64": `sherpa-onnx-v${ENGINE_VERSION}-osx-universal2-shared.tar.bz2`,
  "darwin-arm64": `sherpa-onnx-v${ENGINE_VERSION}-osx-universal2-shared.tar.bz2`,
  // Windows is deliberately absent. Its build imports `onnxruntime.dll` by bare
  // name, and Windows 11 ships an older copy in System32 that some loader
  // configurations resolve instead — the crash upstream fixes (#2054) by
  // renaming the library to `ow-onnxrt.dll` and rewriting every image's PE
  // import table. That fix is untestable from a Linux checkout, and shipping
  // unverified binary patching is worse than not shipping the platform: with no
  // entry here `getEngineDownloadUrl()` returns null, `ensureEngine` reports
  // ENGINE_UNSUPPORTED_PLATFORM, and Settings says so instead of offering an
  // install that would produce an engine the OS cannot load.
  //
  // Read-aloud is unaffected on Windows — it keeps using the native voices
  // through Chromium's speechSynthesis, exactly as before.
  //
  // To add it: port `renameImportedModule` from `scripts/lib/pe-imports.js`
  // into a runtime helper, apply it to the extracted binary and libraries as
  // upstream's `privatizeWindowsOnnxRuntime` does, and add the archive above.
};

const ENGINE_BINARY_NAME = "sherpa-onnx-offline-tts";

/**
 * Threads is the single biggest lever on synthesis speed, and the obvious
 * answer ("use every core") is the wrong one: measured on a 24-core machine,
 * 4 threads took 3.60 s, 8 took 2.88 s, and 24 took 4.06 s for the same
 * passage. Cap it.
 */
const KOKORO_MAX_THREADS = 8;

const KOKORO_MODELS = {
  "kokoro-en-v0_19": {
    id: "kokoro-en-v0_19",
    name: "Kokoro English",
    description: "11 voices, US and UK English. The smaller download.",
    sizeMb: 305,
    expectedSizeBytes: 319625534,
    downloadUrl: `${MODEL_RELEASE_BASE}/kokoro-en-v0_19.tar.bz2`,
    license: "Apache-2.0",
    // v0.19 predates `--kokoro-lang`; espeak-ng data alone drives pronunciation.
    ttsArgs: {},
    recommended: true,
  },
  "kokoro-multi-lang-v1_1": {
    id: "kokoro-multi-lang-v1_1",
    name: "Kokoro Multilingual",
    description: "103 voices, English and Mandarin.",
    sizeMb: 348,
    expectedSizeBytes: 364816464,
    downloadUrl: `${MODEL_RELEASE_BASE}/kokoro-multi-lang-v1_1.tar.bz2`,
    license: "Apache-2.0",
    // Bundles from v1.0 on refuse to start unless given `--kokoro-lang` or
    // `--kokoro-lexicon`. The app reads replies in English, so pin that; the
    // other 14 languages the model knows are reachable by changing this.
    ttsArgs: { lang: "en" },
    recommended: false,
  },
};

function getKokoroModelConfig(modelId) {
  const model = KOKORO_MODELS[modelId];
  if (!model) return null;
  return { ...model };
}

function getKokoroModelIds() {
  return Object.keys(KOKORO_MODELS);
}

function getRequiredModelFiles() {
  return { files: [...REQUIRED_MODEL_FILES], dirs: [...REQUIRED_MODEL_DIRS] };
}

function getEngineArchiveName(platform = process.platform, arch = process.arch) {
  return ENGINE_ARCHIVES[`${platform}-${arch}`] || null;
}

function getEngineDownloadUrl(platform = process.platform, arch = process.arch) {
  const archiveName = getEngineArchiveName(platform, arch);
  if (!archiveName) return null;
  return `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${ENGINE_VERSION}/${archiveName}`;
}

/**
 * Parses the speaker table out of the engine's `--debug=true` output.
 *
 * The bundles ship no voice list — `voices.bin` is a matrix of embeddings, and
 * the names live inside the binary rather than the model directory. Asking the
 * engine to describe itself is the only way to enumerate voices without
 * hardcoding a list that would be wrong for the next bundle. The relevant
 * lines look like:
 *
 *   speaker_names=af,af_bella,af_nicole,...,bm_lewis
 *   speaker2id=af->0,af_bella->1,...
 *   n_speakers=11
 *
 * Pure, so it can be tested without the engine: see
 * `test/helpers/kokoroModels.test.js`.
 */
function parseSpeakerNames(debugOutput) {
  if (typeof debugOutput !== "string" || !debugOutput) return [];

  const match = debugOutput.match(/^\s*speaker_names=(.+)$/m);
  if (!match) return [];

  return match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name, index) => ({ id: index, name, label: describeVoice(name) }));
}

/**
 * Turns Kokoro's voice codes into something a person can choose from. The first
 * letter is the language, the second the region/gender — `af_bella` is
 * American female, `bm_george` British male. Purely cosmetic; the engine only
 * ever sees the index.
 */
function describeVoice(name) {
  const match = name.match(/^([a-z])([a-z])_?(.*)$/);
  if (!match) return name;

  const accents = {
    a: "US",
    b: "UK",
    z: "Chinese",
    e: "Spanish",
    f: "French",
    h: "Hindi",
    i: "Italian",
    p: "Portuguese",
    j: "Japanese",
  };
  const accent = accents[match[1]] || "";
  const gender = { f: "female", m: "male" }[match[2]] || "";
  const given = match[3] ? match[3].replace(/_/g, " ") : "";

  const detail = [accent, gender].filter(Boolean).join(" ");
  if (!detail) return name;

  const tidy = (value) => value.charAt(0).toUpperCase() + value.slice(1);
  // The base voices carry no given name — `af` is just "af" — so they get the
  // description alone rather than a dangling empty parenthesis.
  if (!given) return tidy(detail);
  return `${tidy(given)} (${detail})`;
}

module.exports = {
  ENGINE_VERSION,
  ENGINE_BINARY_NAME,
  ENGINE_ARCHIVES,
  KOKORO_MAX_THREADS,
  KOKORO_MODELS,
  MODEL_RELEASE_BASE,
  getKokoroModelConfig,
  getKokoroModelIds,
  getRequiredModelFiles,
  getEngineArchiveName,
  getEngineDownloadUrl,
  parseSpeakerNames,
  describeVoice,
};
