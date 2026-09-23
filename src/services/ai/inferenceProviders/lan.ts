import type { InferenceProvider } from "./types";
import { buildApiUrl } from "../../../config/constants";
import { getSettings } from "../../../stores/settingsStore";
import logger from "../../../utils/logger";
import { resolveSelfHostedOpenAIBase } from "../openaiBase";

export const lanProvider: InferenceProvider = {
  id: "lan",
  // Self-hosted servers are usually OpenAI-compatible and increasingly serve
  // multimodal models (Ollama's gemma4:e4b), and the shared Chat Completions
  // caller now carries image parts. Which of their models actually see is not
  // knowable here, so the gate decides per request rather than per provider.
  supportsImages: true,
  async call({ text, model, agentName, config, ctx }) {
    const isAgentCall = !!config.lanUrl;
    const settings = getSettings();
    const lanUrl = (config.lanUrl || settings.cleanupRemoteUrl).trim();
    logger.logReasoning("LAN_START", { url: lanUrl, agentName, model });

    try {
      const baseUrl = resolveSelfHostedOpenAIBase(lanUrl);
      const endpoint = buildApiUrl(baseUrl, "/chat/completions");
      const apiKey =
        config.customApiKey?.trim() ||
        (isAgentCall ? "" : settings.cleanupCustomApiKey?.trim()) ||
        "";
      const resolvedModel = model?.trim() || "default";
      return await ctx.callChatCompletionsApi(
        endpoint,
        apiKey,
        resolvedModel,
        text,
        agentName,
        config,
        "LAN"
      );
    } catch (error) {
      logger.logReasoning("LAN_ERROR", {
        url: lanUrl,
        error: (error as Error).message,
        errorType: (error as Error).name,
      });
      throw error;
    }
  },
};
