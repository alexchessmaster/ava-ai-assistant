/**
 * Downloads and removes Kokoro voice bundles.
 *
 * Mirrors `ParakeetManager.downloadParakeetModel` — the archive-and-extract
 * variant — because these are ~305-350 MB tarballs rather than single files,
 * and because it already solved the problems that matter here: resumable
 * downloads, a disk-space check before starting, refusing to run two downloads
 * at once, and validating the extracted result instead of trusting the tar.
 *
 * The progress payload is deliberately identical in shape to the Parakeet and
 * Whisper channels (`{ type, model, downloaded_bytes, total_bytes, percentage }`)
 * even though the renderer for these models is a new component. A future reader
 * comparing the three should not have to learn a second vocabulary.
 */

const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

const debugLogger = require("./debugLogger");
const { getCacheRoot } = require("./modelDirUtils");
const {
  getKokoroModelConfig,
  getKokoroModelIds,
  getRequiredModelFiles,
} = require("./kokoroModels");
const tts = require("./kokoroTts");
const {
  downloadFile,
  createDownloadSignal,
  checkDiskSpace,
  validateFileSize,
  cleanupStaleDownloads,
} = require("./downloadUtils");

const EXTRACT_RETRIES = 2;

function getModelsDir() {
  return tts.getModelsDir();
}

function assertKnownModel(modelId) {
  const config = getKokoroModelConfig(modelId);
  if (!config) {
    throw Object.assign(new Error(`Unknown Kokoro model: ${modelId}`), {
      code: "KOKORO_UNKNOWN_MODEL",
    });
  }
  return config;
}

function validateExtracted(modelDir) {
  const { files, dirs } = getRequiredModelFiles();
  const missing = files.filter((file) => !fs.existsSync(path.join(modelDir, file)));
  for (const dir of dirs) {
    try {
      if (!fs.statSync(path.join(modelDir, dir)).isDirectory()) missing.push(dir);
    } catch {
      missing.push(dir);
    }
  }
  if (missing.length) {
    throw Object.assign(new Error(`Extracted model is missing: ${missing.join(", ")}`), {
      code: "KOKORO_INCOMPLETE_EXTRACT",
    });
  }
}

/**
 * Unpacks the bundle so its files land directly in `destDir`.
 *
 * The archives wrap everything in a top-level directory named after the bundle,
 * so `strip: 1` removes it and the files land flat. Doing it this way avoids
 * having to discover the wrapper's name, which has differed between bundle
 * revisions.
 */
async function extractBundle(archivePath, destDir) {
  const unbzip2 = require("unbzip2-stream");
  const tar = require("tar");
  await pipeline(fs.createReadStream(archivePath), unbzip2(), tar.x({ cwd: destDir, strip: 1 }));
}

let activeDownload = null;

async function downloadModel(modelId, onProgress) {
  const config = assertKnownModel(modelId);

  if (tts.isModelInstalled(modelId)) {
    return { success: true, alreadyInstalled: true, path: tts.getModelDir(modelId) };
  }
  if (activeDownload) {
    throw Object.assign(new Error(`Already downloading ${activeDownload.modelId}`), {
      code: "DOWNLOAD_IN_PROGRESS",
      activeModel: activeDownload.modelId,
    });
  }

  const modelsDir = getModelsDir();
  fs.mkdirSync(modelsDir, { recursive: true });
  await cleanupStaleDownloads(modelsDir);

  // The archive plus what it unpacks to. Extraction doubles the footprint
  // briefly, which is why the multiplier is well above 1.
  await checkDiskSpace(modelsDir, config.expectedSizeBytes * 2.2);

  const archivePath = path.join(modelsDir, `${modelId}.tar.bz2`);
  const stagingDir = path.join(modelsDir, `temp-extract-${modelId}`);
  const targetDir = tts.getModelDir(modelId);
  const { signal, abort } = createDownloadSignal();

  const process = { modelId, phase: "downloading", abort, cancel: null };
  activeDownload = process;

  const emit = (payload) => onProgress?.({ model: modelId, ...payload });

  try {
    // A leftover archive from an interrupted attempt is reused when it looks
    // complete; a visibly truncated one is discarded rather than resumed from a
    // position the server may disagree with.
    if (fs.existsSync(archivePath)) {
      const { size } = fs.statSync(archivePath);
      if (size >= config.expectedSizeBytes * 0.9) {
        debugLogger.info("Reusing partial Kokoro download", { modelId, size });
      } else {
        fs.rmSync(archivePath, { force: true });
      }
    }

    await downloadFile(config.downloadUrl, archivePath, {
      timeout: 600000,
      signal,
      expectedSize: config.expectedSizeBytes,
      onProgress: (downloadedBytes, totalBytes) => {
        emit({
          type: "progress",
          downloaded_bytes: downloadedBytes,
          total_bytes: totalBytes,
          percentage: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : undefined,
        });
      },
    });

    // The release archive size is a known constant, so a short file is caught
    // here rather than surfacing as a confusing extraction failure.
    await validateFileSize(archivePath, config.expectedSizeBytes, 5);

    process.phase = "installing";
    emit({ type: "installing", percentage: 100 });

    let lastError = null;
    for (let attempt = 0; attempt <= EXTRACT_RETRIES; attempt += 1) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        fs.mkdirSync(stagingDir, { recursive: true });
        await extractBundle(archivePath, stagingDir);
        validateExtracted(stagingDir);

        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(stagingDir, targetDir);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        debugLogger.warn("Kokoro extraction attempt failed", {
          modelId,
          attempt,
          error: error.message,
        });
      }
    }

    if (lastError) {
      fs.rmSync(archivePath, { force: true });
      throw Object.assign(new Error(`Extraction failed: ${lastError.message}`), {
        code: "EXTRACTION_FAILED",
      });
    }

    fs.rmSync(archivePath, { force: true });
    // The voice table is read from the model that just landed.
    tts.forgetVoices(modelId);
    emit({ type: "complete", percentage: 100 });

    debugLogger.info("Kokoro model installed", { modelId });
    return { success: true, path: targetDir };
  } catch (error) {
    if (error.isAbort || error.code === "DOWNLOAD_CANCELLED") {
      fs.rmSync(archivePath, { force: true });
      throw Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" });
    }
    throw error;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    activeDownload = null;
    abort();
  }
}

function cancelDownload(modelId) {
  if (!activeDownload) {
    return { success: false, error: "No download in progress", code: "NO_ACTIVE_DOWNLOAD" };
  }
  if (modelId && activeDownload.modelId !== modelId) {
    return {
      success: false,
      error: "A different model is downloading",
      code: "DOWNLOAD_IN_PROGRESS",
    };
  }
  // Extraction cannot be interrupted safely — a half-renamed model directory is
  // worse than waiting the few seconds it takes to finish.
  if (activeDownload.phase === "installing") {
    return {
      success: false,
      error: "Installation cannot be cancelled once extraction has started",
      code: "INSTALLATION_IN_PROGRESS",
    };
  }

  activeDownload.abort();
  return { success: true };
}

function deleteModel(modelId) {
  assertKnownModel(modelId);
  const targetDir = tts.getModelDir(modelId);
  const existed = fs.existsSync(targetDir);
  fs.rmSync(targetDir, { recursive: true, force: true });
  tts.forgetVoices(modelId);
  return { success: true, removed: existed };
}

function deleteAllModels() {
  let removed = 0;
  for (const modelId of getKokoroModelIds()) {
    if (deleteModel(modelId).removed) removed += 1;
  }
  return { success: true, removed };
}

/**
 * Reports each bundle's install state for the settings UI. Disk usage is
 * measured rather than reported from the registry, because the extracted size
 * is what the user is actually paying for.
 */
function listModels() {
  return getKokoroModelIds().map((modelId) => {
    const config = getKokoroModelConfig(modelId);
    const installed = tts.isModelInstalled(modelId);
    return {
      id: modelId,
      name: config.name,
      description: config.description,
      sizeMb: config.sizeMb,
      license: config.license,
      recommended: Boolean(config.recommended),
      downloaded: installed,
      diskBytes: installed ? directorySize(tts.getModelDir(modelId)) : 0,
      isDownloading: activeDownload?.modelId === modelId,
    };
  });
}

function directorySize(dir) {
  let total = 0;
  const walk = (current, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) walk(full, depth + 1);
        else total += fs.statSync(full).size;
      } catch {
        // Raced with a delete; the next listing will be accurate.
      }
    }
  };
  walk(dir, 0);
  return total;
}

module.exports = {
  getModelsDir,
  downloadModel,
  cancelDownload,
  deleteModel,
  deleteAllModels,
  listModels,
  isDownloading: () => Boolean(activeDownload),
  // Exported so tests can measure a model directory without a second copy of
  // the walk.
  _internal: { directorySize, extractBundle },
};
