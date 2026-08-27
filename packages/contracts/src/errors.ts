import { z } from "zod";

/**
 * One error taxonomy across every provider.
 *
 * Provider adapters map their native failures onto this enum. Nothing
 * provider-specific escapes the adapter boundary, and nothing that reveals
 * the site owner's billing state ever reaches an end user's browser.
 */
export const ChatErrorCode = z.enum([
  "rate_limited",        // ours or the provider's — retryable
  "provider_auth",       // the stored key is invalid/revoked  -> owner-facing
  "provider_quota",      // owner is out of credit at the provider -> owner-facing
  "budget_exceeded",     // OUR per-site spend ceiling tripped
  "content_refused",     // provider declined to answer
  "context_too_large",   // budgeter failed to fit the prompt
  "no_answer",           // retrieval confidence gate fired (not an error path
                         // for the user, but the widget renders it distinctly)
  "upstream_unavailable",
  "invalid_request",
  "internal",
]);
export type ChatErrorCode = z.infer<typeof ChatErrorCode>;

/** What the end user is allowed to see, per code. */
const USER_SAFE_MESSAGE: Record<ChatErrorCode, string> = {
  rate_limited: "Too many messages just now. Try again in a moment.",
  provider_auth: "The assistant is temporarily unavailable.",
  provider_quota: "The assistant is temporarily unavailable.",
  budget_exceeded: "The assistant is temporarily unavailable.",
  content_refused: "I can't help with that one.",
  context_too_large: "That question was too long for me to process.",
  no_answer: "I couldn't find that on this site.",
  upstream_unavailable: "The assistant is temporarily unavailable.",
  invalid_request: "Something went wrong with that request.",
  internal: "Something went wrong.",
};

/**
 * Codes that mean "the site owner must act". These raise a dashboard alert
 * and an email, while the browser still only sees the bland message above.
 */
export const OWNER_ACTIONABLE: ReadonlySet<ChatErrorCode> = new Set<ChatErrorCode>([
  "provider_auth",
  "provider_quota",
  "budget_exceeded",
]);

export class ChatError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    /** Internal detail. Logged, never serialised to the widget. */
    readonly detail?: string,
    readonly retryable = false,
  ) {
    super(detail ?? code);
    this.name = "ChatError";
  }

  /** The only representation that may cross the network to a browser. */
  toPublic(): { code: ChatErrorCode; message: string } {
    return { code: this.code, message: USER_SAFE_MESSAGE[this.code] };
  }
}
