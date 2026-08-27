import { z } from "zod";
import { ChatErrorCode } from "./errors.js";

export const SourceSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  /** "Site > H1 > H2" — the chunk breadcrumb, used for citation display. */
  breadcrumb: z.string(),
});
export type Source = z.infer<typeof SourceSchema>;

export const ChatRequestSchema = z.object({
  /** Absent on the first message; the server mints and returns one. */
  conversationId: z.string().uuid().nullable().default(null),
  message: z.string().min(1).max(4000),
  /** Set only when the site enables signed identity mode. */
  user: z
    .object({ id: z.string().max(200), hmac: z.string().max(200) })
    .nullable()
    .default(null),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/**
 * The SSE envelope.
 *
 * WARNING: this shape is a forever-contract. A customer pasted a script tag
 * and may not touch it for years, so the API must keep serving old widget
 * versions. Add fields; never remove or repurpose one.
 */
export type ChatStreamEvent =
  | { type: "start"; conversationId: string; messageId: string }
  | { type: "sources"; sources: Source[] }
  | { type: "delta"; text: string }
  | { type: "done"; finishReason: "stop" | "length" | "refusal" }
  | { type: "error"; code: ChatErrorCode; message: string };

export function encodeSSE(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
