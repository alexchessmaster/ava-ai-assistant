/**
 * Fetches the sherpa-onnx TTS engine at runtime instead of shipping it.
 *
 * Upstream bundles its sherpa-onnx binaries during `prebuild` by driving
 * `scripts/download-sherpa-onnx.js`. Doing the same for TTS would mean editing
 * that script, `package.json`, and the packaging config — three upstream files
 * this fork would then have to re-merge on every release. The engine is an
 * ordinary download, so it is fetched the same way models are: on demand, into
 * the cache, behind a button.
 *
 * The engine directory is deliberately self-contained — binary plus its own
 * shared libraries — rather than reusing the copies already in
 * `resources/bin/`. Two reasons:
 *
 *   1. The binary's RPATH is `$ORIGIN:$ORIGIN/../lib`, verified with
 *      `readelf -d`. A `bin/` + `lib/` layout beside each other resolves
 *      natively, with no LD_LIBRARY_PATH (checked by running the binary from a
 *      moved directory). Nothing has to be injected into the spawn env, which
 *      would otherwise differ per platform.
 *   2. Upstream pins sherpa-onnx to whatever version Parakeet needs. Keeping our
 *      own copy means the next time they bump it, Kokoro does not start
 *      failing to load against newer libraries.
 *
 * The installed engine is ~35 MB: the TTS binary is 2.5 MB and libonnxruntime
 * is 27 MB.
 */

const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

const debugLogger = require("./debugLogger");
const { getSafeTempDir } = require("./safeTempDir");
const { getCacheRoot } = require("./modelDirUtils");
const { ENGINE_BINARY_NAME, ENGINE_VERSION, getEngineDownloadUrl } = require("./kokoroModels");
const { downloadFile, createDownloadSignal, checkDiskSpace } = require("./downloadUtils");

const MARKER_NAME = ".engine.json";
const ARCHIVE_SIZE_BYTES = 28156791;

function getEngineDir() {
  // Built from getCacheRoot() rather than getModelsDirForService() so this
  // directory does not have to be added to RELOCATED_SUBDIRS in modelDirUtils.
  // getCacheRoot() already redirects to an ASCII-safe root on Windows profiles
  // with non-ASCII characters, which is the behaviour that matters here — a
  // native binary reading a path with Cyrillic or CJK in it is exactly the
  // crash that relocation exists to prevent.
  return path.join(getCacheRoot(), "kokoro-engine");
}

function getBinaryName() {
  return process.platform === "win32" ? `${ENGINE_BINARY_NAME}.exe` : ENGINE_BINARY_NAME;
}

function getBinaryPath() {
  return path.join(getEngineDir(), "bin", getBinaryName());
}

function getMarkerPath() {
  return path.join(getEngineDir(), MARKER_NAME);
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(getMarkerPath(), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Installed means: a marker recording the engine version we build against, and
 * the binary it names still on disk. A marker from an older release reports
 * not-installed, so the next install replaces it.
 */
function isEngineInstalled() {
  const marker = readMarker();
  if (!marker || marker.version !== ENGINE_VERSION || !marker.binary) return false;
  try {
    fs.accessSync(getBinaryPath(), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function libraryExtensions() {
  if (process.platform === "darwin") return [".dylib"];
  if (process.platform === "win32") return [".dll"];
  // Versioned sonames (`libonnxruntime.so.1.23.2`) come through the same filter.
  return [".so"];
}

function isWantedMember(entryPath) {
  const base = path.basename(entryPath);
  if (base === getBinaryName()) return true;

  const isLibrary = libraryExtensions().some(
    (extension) => base.includes(extension) || base.endsWith(extension)
  );
  if (!isLibrary) return false;

  // Only libraries from the distribution's lib/ directory. The archive also
  // carries copies beside the binaries, and pulling both would double the
  // install size for nothing.
  return /(^|\/)lib\//.test(entryPath);
}

/**
 * Extracts only the TTS binary and its shared libraries.
 *
 * The archive is a full sherpa-onnx distribution — every example binary plus
 * their libraries — which unpacks to far more than the ~35 MB we actually
 * install. The filter keeps the extraction to four files, and the JS
 * decompressor is used rather than shelling out to `tar` because the
 * member-filtering flags differ across GNU tar, bsdtar, and Windows' tar.
 */
async function extractEngine(archivePath, destDir) {
  const unbzip2 = require("unbzip2-stream");
  const tar = require("tar");

  await pipeline(
    fs.createReadStream(archivePath),
    unbzip2(),
    tar.x({ cwd: destDir, filter: (entryPath) => isWantedMember(entryPath) })
  );
}

function findExtractedFiles(sourceDir) {
  const binaryName = getBinaryName();
  const extensions = libraryExtensions();
  let binary = null;
  const libraries = [];

  const walk = (current, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (entry.name === binaryName) binary = full;
      else if (extensions.some((extension) => entry.name.includes(extension))) {
        libraries.push(full);
      }
    }
  };

  walk(sourceDir, 0);
  return { binary, libraries };
}

/**
 * Lays out the extracted files as `<dir>/bin` and `<dir>/lib`.
 *
 * Windows is the odd one out: its loader searches the directory holding the
 * executable rather than a sibling `lib/`, so the DLLs are duplicated next to
 * the binary. That costs ~35 MB there and nothing anywhere else.
 */
function installFromExtract(sourceDir) {
  const engineDir = getEngineDir();
  const binDir = path.join(engineDir, "bin");
  const libDir = path.join(engineDir, "lib");

  const { binary, libraries } = findExtractedFiles(sourceDir);
  if (!binary) {
    throw Object.assign(new Error("TTS engine binary missing from archive"), {
      code: "ENGINE_BINARY_MISSING",
    });
  }

  // Wipe only now: the extraction lives elsewhere, so this cannot delete its
  // own source (which it did when both shared a directory).
  fs.rmSync(engineDir, { recursive: true, force: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });

  const binaryTarget = getBinaryPath();
  fs.copyFileSync(binary, binaryTarget);
  fs.chmodSync(binaryTarget, 0o755);

  for (const library of libraries) {
    const name = path.basename(library);
    fs.copyFileSync(library, path.join(libDir, name));
    if (process.platform === "win32") {
      fs.copyFileSync(library, path.join(binDir, name));
    }
  }

  fs.writeFileSync(
    getMarkerPath(),
    JSON.stringify(
      {
        version: ENGINE_VERSION,
        binary: path.basename(binaryTarget),
        libraries: libraries.map((library) => path.basename(library)),
        platform: process.platform,
        arch: process.arch,
      },
      null,
      2
    )
  );

  debugLogger.info("Kokoro TTS engine installed", {
    version: ENGINE_VERSION,
    libraries: libraries.length,
  });

  return binaryTarget;
}

// One install at a time: two Settings windows, or an impatient second click,
// must not race to write the same directory.
let inFlight = null;

/**
 * Downloads and installs the engine if it is not already present.
 *
 * `onProgress` receives `{ phase, percentage, downloadedBytes, totalBytes }`
 * where phase is "downloading" | "extracting" | "complete".
 */
async function ensureEngine({ onProgress } = {}) {
  if (isEngineInstalled()) {
    return { success: true, alreadyInstalled: true, path: getBinaryPath() };
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const url = getEngineDownloadUrl();
    if (!url) {
      throw Object.assign(
        new Error(`No Kokoro engine build for ${process.platform}-${process.arch}`),
        { code: "ENGINE_UNSUPPORTED_PLATFORM" }
      );
    }

    const engineDir = getEngineDir();
    fs.mkdirSync(engineDir, { recursive: true });

    // Room for the archive plus the four files it yields. The extraction is
    // filtered, so it never needs space for the whole distribution.
    await checkDiskSpace(engineDir, ARCHIVE_SIZE_BYTES * 3);

    const archivePath = path.join(engineDir, "engine.tar.bz2");
    // Outside the install directory on purpose — see installFromExtract.
    const extractDir = path.join(getSafeTempDir(), `kokoro-engine-${process.pid}`);
    const { signal, abort } = createDownloadSignal();

    try {
      await downloadFile(url, archivePath, {
        signal,
        expectedSize: ARCHIVE_SIZE_BYTES,
        onProgress: (downloadedBytes, totalBytes) => {
          const percentage =
            totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : undefined;
          onProgress?.({ phase: "downloading", percentage, downloadedBytes, totalBytes });
        },
      });

      onProgress?.({ phase: "extracting", percentage: 100 });
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      await extractEngine(archivePath, extractDir);

      const binaryPath = installFromExtract(extractDir);
      onProgress?.({ phase: "complete", percentage: 100 });
      return { success: true, path: binaryPath };
    } catch (error) {
      // Leave nothing half-written: a surviving marker over a missing or
      // partial binary would report "installed" and then fail at speak time.
      fs.rmSync(getMarkerPath(), { force: true });
      debugLogger.warn("Kokoro engine install failed", { error: error.message });
      throw error;
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.rmSync(archivePath, { force: true });
      abort();
    }
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

module.exports = {
  getEngineDir,
  getBinaryPath,
  isEngineInstalled,
  ensureEngine,
  ENGINE_VERSION,
};
