import { FileText, X } from "../icons";
import { formatBytes } from "../../utils/formatBytes";
import { cn } from "../lib/utils";
import type { ChatAttachment } from "./types";

interface AttachmentTrayProps {
  attachments: ChatAttachment[];
  onRemove: (id: string) => void;
  className?: string;
}

/** The files staged for the message being composed, above the input pill. */
export function AttachmentTray({ attachments, onRemove, className }: AttachmentTrayProps) {
  if (attachments.length === 0) return null;

  return (
    <ul className={cn("flex flex-wrap items-center gap-2", className)}>
      {attachments.map((attachment) => {
        const label = `Remove ${attachment.name}`;

        return (
          <li key={attachment.id} className="relative">
            {attachment.kind === "image" ? (
              <img
                src={`data:${attachment.mediaType};base64,${attachment.image}`}
                alt={attachment.name}
                title={attachment.name}
                width={40}
                height={40}
                decoding="async"
                draggable={false}
                className="size-10 rounded-lg border border-border/50 object-cover"
              />
            ) : (
              <span
                title={attachment.name}
                className="inline-flex max-w-56 items-center gap-2 rounded-lg border border-border/50 bg-surface-raised/70 py-1.5 ps-2.5 pe-3"
              >
                <FileText size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-medium text-foreground">
                    {attachment.name}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {attachment.truncated
                      ? `${formatBytes(attachment.bytes)} · truncated`
                      : formatBytes(attachment.bytes)}
                  </span>
                </span>
              </span>
            )}
            <button
              type="button"
              onClick={() => onRemove(attachment.id)}
              aria-label={label}
              title={label}
              className="absolute -end-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border border-border/60 bg-surface-raised text-muted-foreground shadow-sm transition-colors hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
            >
              <X size={9} strokeWidth={2} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
