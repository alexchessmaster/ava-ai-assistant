/**
 * Every IPC channel for local Kokoro speech, registered from one place.
 *
 * Upstream keeps all handlers in `ipcHandlers.js`. This fork avoids adding to
 * that file so merges stay small, and `ipcMain.handle` can be called from
 * anywhere — so the handlers live here and `main.js` calls `register()` once.
 * That is the only line this feature adds to the main process.
 *
 * The channel names follow the upstream conventions in `preload.js`: kebab-case
 * channels, `invoke` for request/response, and a `-progress` suffixed event
 * channel for streamed updates.
 */

const fs = require("fs");
const { ipcMain } = require("electron");

const debugLogger = require("./debugLogger");
const engine = require("./kokoroEngine");
const tts = require("./kokoroTts");
const download = require("./kokoroDownload");
const { getEngineDownloadUrl } = require("./kokoroModels");

/**
 * Reads the synthesized WAV back to the renderer and removes it.
 *
 * Main owns the temp file so the renderer never handles a path, and the bytes
 * are deleted as soon as they are in memory — a read-aloud reply should not
 * leave audio lying in the temp directory.
 */
function readAndRemove(wavPath) {
  const buffer = fs.readFileSync(wavPath);
  fs.rmSync(wavPath, { force: true });
  return buffer;
}

function toErrorPayload(error) {
  return {
    error: error.message,
    code: error.code || "KOKORO_ERROR",
    detail: error.detail,
  };
}

function register({ windowManager } = {}) {
  // WAVs from a previous crash are cleaned once, now, rather than on every
  // synthesis.
  tts.cleanupStaleOutputs();

  const send = (channel, payload) => {
    try {
      windowManager?.sendToControlPanel?.(channel, payload);
    } catch {
      // No control panel open; the download continues and the UI re-reads
      // state when it next mounts.
    }
  };

  ipcMain.handle("kokoro-status", async () => {
    return {
      success: true,
      // False on Windows, where the engine needs a PE import rewrite that this
      // fork has not ported (see kokoroModels.ENGINE_ARCHIVES). The UI reports
      // that rather than offering an install it cannot complete.
      supported: Boolean(getEngineDownloadUrl()),
      engineInstalled: engine.isEngineInstalled(),
      engineVersion: engine.ENGINE_VERSION,
      models: download.listModels(),
      downloading: download.isDownloading(),
    };
  });

  /**
   * One action installs everything: the engine first, then the chosen bundle.
   * The engine is ~35 MB and the bundle is ~350 MB, so they are reported as
   * distinct phases under the same progress channel — the UI shows "Preparing
   * engine" then "Downloading model" without needing two buttons or two flows.
   */
  ipcMain.handle("kokoro-install", async (_event, modelId) => {
    try {
      await engine.ensureEngine({
        onProgress: (progress) => {
          send("kokoro-download-progress", {
            model: modelId,
            type: "engine",
            phase: progress.phase,
            percentage: progress.percentage,
            downloaded_bytes: progress.downloadedBytes,
            total_bytes: progress.totalBytes,
          });
        },
      });

      const result = await download.downloadModel(modelId, (progress) => {
        send("kokoro-download-progress", progress);
      });

      send("kokoro-download-progress", { model: modelId, type: "complete", percentage: 100 });
      return { success: true, path: result.path };
    } catch (error) {
      debugLogger.warn("Kokoro install failed", { modelId, error: error.message });
      const payload = toErrorPayload(error);
      send("kokoro-download-progress", { model: modelId, type: "error", ...payload });
      return { success: false, ...payload };
    }
  });

  ipcMain.handle("kokoro-cancel-download", async (_event, modelId) => {
    return download.cancelDownload(modelId);
  });

  ipcMain.handle("kokoro-delete-model", async (_event, modelId) => {
    try {
      const result = download.deleteModel(modelId);
      tts.stop();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, ...toErrorPayload(error) };
    }
  });

  ipcMain.handle("kokoro-voices", async (_event, modelId) => {
    try {
      return { success: true, voices: await tts.listVoices(modelId) };
    } catch (error) {
      return { success: false, voices: [], ...toErrorPayload(error) };
    }
  });

  /**
   * Synthesizes one chunk and returns the audio bytes.
   *
   * A missing engine or model is reported as a failure rather than silently
   * falling back, so the renderer decides: it falls back to the OS voices only
   * when Kokoro is genuinely absent, and surfaces a real synthesis error
   * otherwise.
   */
  ipcMain.handle("kokoro-synthesize", async (_event, payload = {}) => {
    const { modelId, text, voiceId = 0, speed = 1 } = payload;
    try {
      const { wavPath, bytes } = await tts.synthesize({ modelId, text, voiceId, speed });
      const audio = readAndRemove(wavPath);
      return { success: true, audio, bytes };
    } catch (error) {
      if (error.code === "KOKORO_CANCELLED") {
        return { success: false, code: "KOKORO_CANCELLED" };
      }
      debugLogger.debug("Kokoro synthesis request failed", {
        modelId,
        code: error.code,
        error: error.message,
      });
      return { success: false, ...toErrorPayload(error) };
    }
  });

  ipcMain.handle("kokoro-stop", async () => {
    tts.stop();
    return { success: true };
  });
}

module.exports = { register };
