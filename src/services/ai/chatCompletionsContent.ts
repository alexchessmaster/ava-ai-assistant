/**
 * Translates the AI SDK's content parts into the shape an OpenAI-compatible
 * Chat Completions endpoint expects: text stays text, and an attached image
 * becomes an `image_url` part carrying a data URL.
 *
 * The raw Chat Completions transports (the LAN/self-hosted lane, plus the
 * dictation route's shared caller) write the request body themselves, so they
 * cannot hand the SDK's own part shape to the wire.
 *
 * `includeImages` is false where the transport has no image lane at all — then
 * only the text survives, because sending an `image_url` part to a text-only
 * server fails the whole request.
 */
export function toChatCompletionsContent(
  parts: Array<Record<string, unknown>>,
  includeImages: boolean
): string | Array<Record<string, unknown>> {
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");

  if (!includeImages) return text;

  const images = parts
    .filter((part) => part.type === "image" && typeof part.image === "string" && part.image)
    .map((part) => ({
      type: "image_url",
      image_url: {
        url: `data:${typeof part.mediaType === "string" ? part.mediaType : "image/jpeg"};base64,${part.image}`,
      },
    }));

  return images.length === 0 ? text : [{ type: "text", text }, ...images];
}
