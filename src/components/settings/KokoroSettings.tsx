import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { SectionHeader } from "../ui/SettingsSection";
import { DownloadProgressBar } from "../ui/DownloadProgressBar";
import { useSpeechStore } from "../../stores/speechStore";
import {
  KOKORO_MODEL_KEY,
  KOKORO_VOICE_KEY,
  kokoroBridge,
  refreshKokoroState,
  type KokoroDownloadProgress,
  type KokoroModelSummary,
  type KokoroVoice,
} from "../../stores/kokoroSpeech";

/**
 * Settings for the local Kokoro voice.
 *
 * Deliberately mounted inside an existing settings section rather than given a
 * nav entry of its own: section labels go through `t()`, and adding one would
 * mean adding a key to thirteen upstream locale files on every merge. The
 * strings below are plain English for the same reason — see the note in
 * `useSpeechControl.ts`, and add keys here if the fork ever wants translations.
 */
const PREVIEW_TEXT =
  "This is what the local voice sounds like. It runs on your machine, with nothing sent anywhere.";

function formatBytes(bytes: number): string {
  if (!bytes) return "0 MB";
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A blocked store means the preference does not persist; not worth failing.
  }
}

export default function KokoroSettings() {
  const [models, setModels] = useState<KokoroModelSummary[]>([]);
  const [engineInstalled, setEngineInstalled] = useState(false);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<KokoroDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<KokoroVoice[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedVoice, setSelectedVoice] = useState<number>(1);

  const speakingText = useSpeechStore((state) => state.speakingText);
  const speak = useSpeechStore((state) => state.speak);
  const stopSpeaking = useSpeechStore((state) => state.stop);
  const isPreviewing = speakingText === PREVIEW_TEXT;

  const api = kokoroBridge();

  const loadStatus = useCallback(async () => {
    if (!api?.kokoroStatus) {
      setLoading(false);
      return;
    }
    try {
      const status = await api.kokoroStatus();
      setSupported(status?.supported !== false);
      setEngineInstalled(Boolean(status?.engineInstalled));
      setModels(status?.models ?? []);
    } catch {
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // The chosen model and voice are read straight from localStorage by
  // `kokoroSpeech` at speak time, so the two stay in step through these keys.
  useEffect(() => {
    const storedModel = readStored(KOKORO_MODEL_KEY);
    const storedVoice = readStored(KOKORO_VOICE_KEY);
    if (storedVoice !== null) {
      const parsed = Number.parseInt(storedVoice, 10);
      if (Number.isInteger(parsed) && parsed >= 0) setSelectedVoice(parsed);
    }
    if (storedModel) setSelectedModel(storedModel);
  }, []);

  const downloaded = useMemo(() => models.filter((model) => model.downloaded), [models]);
  const activeModel = selectedModel || downloaded[0]?.id || "";
  // A string key rather than the array: `filter` returns a fresh array every
  // render, so depending on `downloaded` would re-run the effect forever. The
  // key changes only when the set of installed models actually changes.
  const installedKey = downloaded.map((model) => model.id).join(",");

  useEffect(() => {
    const installed = installedKey ? installedKey.split(",") : [];
    if (!activeModel || !installed.includes(activeModel)) {
      setVoices([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await api?.kokoroVoices?.(activeModel);
        if (!cancelled) setVoices(result?.voices ?? []);
      } catch {
        if (!cancelled) setVoices([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, activeModel, installedKey]);

  // Progress arrives on a channel; only the model being installed is rendered,
  // so a stale event from a previous run cannot resurrect a finished bar.
  //
  // Set imperatively in install() as well as kept in sync here: the engine
  // download starts the moment the IPC call lands, so the first progress event
  // can arrive before React has re-rendered with the new state, and a ref that
  // only updated on render would drop it.
  const installingRef = useRef<string | null>(null);
  useEffect(() => {
    installingRef.current = installingId;
  }, [installingId]);

  useEffect(() => {
    const subscribe = kokoroBridge()?.onKokoroDownloadProgress;
    if (!subscribe) return;
    return subscribe((payload) => {
      if (!installingRef.current) return;
      if (payload.type === "error") {
        setError(payload.error || "The download failed.");
        setInstallingId(null);
        setProgress(null);
        return;
      }
      if (payload.type === "complete") {
        setInstallingId(null);
        setProgress(null);
        void loadStatus().then(() => refreshKokoroState());
        return;
      }
      setProgress(payload);
    });
  }, [loadStatus]);

  const install = useCallback(
    async (modelId: string) => {
      if (!api?.kokoroInstall) return;
      setError(null);
      installingRef.current = modelId;
      setInstallingId(modelId);
      setProgress(null);
      try {
        const result = await api.kokoroInstall(modelId);
        if (!result?.success) {
          setError(result?.error || "The download failed.");
        }
      } catch (installError) {
        setError(installError instanceof Error ? installError.message : "The download failed.");
      } finally {
        setInstallingId(null);
        setProgress(null);
        await loadStatus();
        await refreshKokoroState();
      }
    },
    [api, loadStatus]
  );

  const remove = useCallback(
    async (modelId: string) => {
      if (!api?.kokoroDeleteModel) return;
      setError(null);
      await api.kokoroDeleteModel(modelId);
      await loadStatus();
      await refreshKokoroState();
    },
    [api, loadStatus]
  );

  const totalDisk = models.reduce((sum, model) => sum + (model.diskBytes || 0), 0);

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Local voice"
        description="Read replies aloud with a voice that runs on this machine. Nothing is sent to a service, and the voice is identical on every platform."
      />

      {loading ? (
        <p className="text-xs text-muted-foreground">Checking installed voices…</p>
      ) : !supported ? (
        // Windows, for now: the engine needs a PE import rewrite this fork has
        // not ported. Read-aloud still works there through the system voices.
        <p className="text-xs text-muted-foreground">
          The local voice is not available on this platform yet. Replies are still read aloud with
          your system voices.
        </p>
      ) : (
        <div className="rounded-lg border border-border/70">
          {models.map((model) => {
            const isInstalling = installingId === model.id;
            const canCancel = progress?.type === "progress" || progress?.type === "engine";

            return (
              <div key={model.id} className="px-3 py-3 border-b border-border/60 last:border-b-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{model.name}</span>
                      {model.recommended && !model.downloaded && (
                        <span className="text-[10px] uppercase tracking-wide text-primary">
                          Recommended
                        </span>
                      )}
                      {model.downloaded && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Installed
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{model.description}</p>
                    <p className="text-[11px] text-muted-foreground/80 mt-1">
                      {model.downloaded
                        ? `${formatBytes(model.diskBytes)} on disk`
                        : `${model.sizeMb} MB download`}
                      {" · "}
                      {model.license}
                    </p>
                  </div>

                  <div className="shrink-0 flex items-center gap-2">
                    {model.downloaded ? (
                      <>
                        <Button
                          variant={activeModel === model.id ? "default" : "outline"}
                          size="sm"
                          onClick={() => {
                            setSelectedModel(model.id);
                            writeStored(KOKORO_MODEL_KEY, model.id);
                          }}
                        >
                          {activeModel === model.id ? "In use" : "Use this"}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void remove(model.id)}>
                          Remove
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={Boolean(installingId)}
                        onClick={() => void install(model.id)}
                      >
                        {isInstalling ? "Installing…" : "Install"}
                      </Button>
                    )}
                  </div>
                </div>

                {isInstalling && (
                  <div className="mt-2">
                    <p className="text-[11px] text-muted-foreground">
                      {progress?.type === "engine"
                        ? "Preparing the speech engine…"
                        : progress?.type === "installing"
                          ? "Unpacking the voice…"
                          : "Downloading…"}
                    </p>
                    <DownloadProgressBar
                      modelName={model.name}
                      isInstalling={progress?.type === "installing" || progress?.type === "engine"}
                      progress={{
                        percentage: progress?.percentage ?? 0,
                        downloadedBytes: progress?.downloaded_bytes ?? 0,
                        totalBytes: progress?.total_bytes ?? 0,
                      }}
                    />
                    {canCancel && (
                      <button
                        type="button"
                        className="text-[11px] text-muted-foreground underline mt-1"
                        onClick={() => void api?.kokoroCancelDownload?.(model.id)}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {!models.length && (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              No voices available on this platform.
            </p>
          )}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {activeModel && voices.length > 0 && (
        <div className="rounded-lg border border-border/70 px-3 py-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Voice</p>
              <p className="text-xs text-muted-foreground">{voices.length} voices in this model.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => (isPreviewing ? stopSpeaking() : speak(PREVIEW_TEXT))}
            >
              {isPreviewing ? "Stop" : "Preview"}
            </Button>
          </div>

          <select
            value={selectedVoice}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              setSelectedVoice(next);
              writeStored(KOKORO_VOICE_KEY, String(next));
            }}
            className="w-full text-xs bg-transparent border border-border/70 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring/40"
          >
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        {engineInstalled
          ? `Speech engine installed. Voices use ${formatBytes(totalDisk)} of disk.`
          : "The speech engine downloads once, with the first voice you install."}
      </p>
    </div>
  );
}
