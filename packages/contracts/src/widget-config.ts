import { z } from "zod";

/**
 * The public, CDN-cached widget configuration.
 *
 * This is served at /v1/config/:siteKey and consumed by the browser bundle.
 * It contains NOTHING secret — no provider key, no model id, no prompt.
 * Treat every field here as world-readable, because it is.
 */

const hex = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a hex colour");

export const ThemeSchema = z.object({
  primary: hex.default("#6E2F63"),
  onPrimary: hex.default("#FFFFFF"),
  surface: hex.default("#FFFFFF"),
  text: hex.default("#1C1720"),
  textMuted: hex.default("#6B6470"),
  userBubble: hex.default("#F2E7F0"),
  radius: z.number().int().min(0).max(32).default(12),
  fontFamily: z.string().max(200).default("system-ui, -apple-system, sans-serif"),
  /** "auto" follows the host page's prefers-color-scheme. */
  colorScheme: z.enum(["light", "dark", "auto"]).default("auto"),
});

export const LauncherSchema = z.object({
  position: z.enum(["bottom-right", "bottom-left"]).default("bottom-right"),
  offsetX: z.number().int().min(0).max(200).default(20),
  offsetY: z.number().int().min(0).max(200).default(20),
  /** Inline SVG string or a data: URI. Never a remote URL — CSP and privacy. */
  icon: z.string().max(8000).nullable().default(null),
  label: z.string().max(40).nullable().default(null),
});

export const WidgetConfigSchema = z.object({
  /** Bumped whenever any field below changes; part of the CDN cache key. */
  configVersion: z.string(),
  siteKey: z.string(),

  assistantName: z.string().min(1).max(60).default("Assistant"),
  avatarUrl: z.string().url().nullable().default(null),
  greeting: z.string().max(500).default("Hi — ask me anything about this site."),
  placeholder: z.string().max(120).default("Ask a question..."),
  suggestedQuestions: z.array(z.string().max(160)).max(6).default([]),
  locale: z.string().max(10).default("en"),

  theme: ThemeSchema,
  launcher: LauncherSchema,

  showBranding: z.boolean().default(true),
  /** When true the widget refuses to open without setUser({id, hmac}). */
  requireSignedIdentity: z.boolean().default(false),

  apiBaseUrl: z.string().url(),
});

export type WidgetConfig = z.infer<typeof WidgetConfigSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
