// How big is the model a local server is actually serving?
//
// The agent gives the tool registry to locally-served models only above a size
// floor: a small model handed a tool schema tends to ignore it or malform the
// call. Below the floor it gets no tools at all — so this has to be right,
// because the failure is silent and looks like the assistant denying it has any
// capabilities.
//
// Pure and unit-tested (test/models/localModelSize.test.js).

/** Below this, a locally-served model is not given the tool registry. */
export const LOCAL_TOOL_MIN_PARAMS_B = 4;

/**
 * Parameter count in billions, or 0 when the id does not say.
 *
 * The size is not always dashed on: Ollama tags its models `name:tag`, so
 * `gemma4:e4b` and `deepseek-r1:8b` are the normal shape, not the exception,
 * and `e4b` is an effective-parameter count that counts as one. Ids that carry
 * no size at all (`llama3:latest`) return 0 rather than guessing.
 */
export function estimateModelSizeB(modelId: string): number {
  if (typeof modelId !== "string") return 0;
  const match = modelId.match(/(?:^|[-_:.\s])e?(\d+(?:\.\d+)?)b(?![a-z0-9])/i);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * Whether a locally-served model should be given the tools.
 *
 * A model id that names a size below the floor is refused. One that names no
 * size at all is allowed through *when the server is the user's own*: they
 * chose both the server and the tag, an Ollama tag need not carry a size, and
 * withholding tools there produced an assistant that insisted it was "a
 * text-based AI" with nothing on screen to explain why. The app's own bundled
 * llama.cpp registry always names a size, so an unreadable id there stays
 * conservative.
 */
export function localModelSupportsTools({
  modelId,
  isSelfHosted = false,
}: {
  modelId: string;
  isSelfHosted?: boolean;
}): boolean {
  const sizeB = estimateModelSizeB(modelId);
  if (sizeB >= LOCAL_TOOL_MIN_PARAMS_B) return true;
  return isSelfHosted && sizeB === 0;
}
