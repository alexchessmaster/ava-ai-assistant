/**
 * Text extracted from the files a user attached to their message, wrapped so
 * the model can tell it apart from the user's own words.
 *
 * This is request-only: it is folded into the message sent to the model, never
 * into the displayed message or the stored conversation. A 40-page PDF pasted
 * into `Message.content` would otherwise be re-rendered and re-persisted with
 * every turn.
 *
 * Mirrors `buildAgentRequestText` in utils/agentSelectionContext.ts.
 */
export interface AttachmentDocument {
  name: string;
  text: string;
}

export function buildAttachmentRequestText(text: string, documents: AttachmentDocument[]): string {
  if (documents.length === 0) return text;

  // File names are sanitized in the main process (no quotes or angle brackets),
  // so they are safe to interpolate into the attribute.
  const blocks = documents.map((doc) => `<file name="${doc.name}">\n${doc.text}\n</file>`);
  // A message can be an attachment alone, and it shouldn't lead with blank lines.
  return [text, ...blocks].filter(Boolean).join("\n\n");
}
