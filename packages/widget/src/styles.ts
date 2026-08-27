import type { WidgetConfig } from "@groundwork/contracts";

/**
 * Styles live inside the Shadow DOM, so the host page cannot reach in and we
 * cannot leak out. A widget that breaks a customer's checkout page gets
 * removed the same day — this isolation is non-negotiable.
 *
 * Theme values arrive as CSS custom properties so a config change is a
 * re-render, not a rebuild.
 */
export function styles(cfg: WidgetConfig): string {
  const t = cfg.theme;
  return `
:host { all: initial; }
* { box-sizing: border-box; }

.root {
  --primary: ${t.primary};
  --on-primary: ${t.onPrimary};
  --surface: ${t.surface};
  --text: ${t.text};
  --muted: ${t.textMuted};
  --user-bubble: ${t.userBubble};
  --radius: ${t.radius}px;
  font-family: ${t.fontFamily};
  font-size: 15px;
  line-height: 1.55;
  color: var(--text);
  position: fixed;
  ${cfg.launcher.position === "bottom-left" ? "left" : "right"}: ${cfg.launcher.offsetX}px;
  bottom: ${cfg.launcher.offsetY}px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  align-items: ${cfg.launcher.position === "bottom-left" ? "flex-start" : "flex-end"};
  gap: 12px;
}

.launcher {
  width: 56px; height: 56px;
  border: none; border-radius: 50%;
  background: var(--primary); color: var(--on-primary);
  cursor: pointer; display: grid; place-items: center;
  box-shadow: 0 4px 16px rgba(0,0,0,.18);
  transition: transform .15s ease;
}
.launcher:hover { transform: scale(1.05); }
.launcher:focus-visible { outline: 3px solid var(--primary); outline-offset: 3px; }

.panel {
  width: min(400px, calc(100vw - 32px));
  height: min(600px, calc(100vh - 120px));
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: 0 12px 48px rgba(0,0,0,.22);
  display: flex; flex-direction: column; overflow: hidden;
}

.header {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 16px;
  background: var(--primary); color: var(--on-primary);
  flex-shrink: 0;
}
.header .name { font-weight: 600; flex: 1; }
.header button {
  background: none; border: none; color: inherit;
  cursor: pointer; font-size: 20px; line-height: 1; padding: 4px;
}
.avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; }

.log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }

.turn { display: contents; }

.msg { max-width: 85%; padding: 9px 13px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; }
.msg.user { align-self: flex-end; background: var(--user-bubble); }
.msg.assistant { align-self: flex-start; background: rgba(127,127,127,.1); }

.sources { display: flex; flex-wrap: wrap; gap: 6px; align-self: flex-start; max-width: 85%; }
.sources a {
  font-size: 12px; color: var(--muted); text-decoration: none;
  border: 1px solid currentColor; border-radius: 999px; padding: 2px 9px;
}
.sources a:hover { color: var(--primary); }

.error { align-self: center; font-size: 13px; color: var(--muted); text-align: center; }

.suggested { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 12px; }
.suggested button {
  font: inherit; font-size: 13px; cursor: pointer;
  background: none; color: var(--primary);
  border: 1px solid var(--primary); border-radius: 999px; padding: 5px 11px;
}

.composer { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid rgba(127,127,127,.2); flex-shrink: 0; }
.composer input {
  flex: 1; font: inherit; padding: 9px 12px;
  border: 1px solid rgba(127,127,127,.3); border-radius: 999px;
  background: transparent; color: var(--text);
}
.composer input:focus { outline: 2px solid var(--primary); outline-offset: -1px; }
.composer button {
  border: none; border-radius: 999px; padding: 0 16px;
  background: var(--primary); color: var(--on-primary); cursor: pointer; font: inherit;
}
.composer button:disabled { opacity: .5; cursor: default; }

.branding { text-align: center; font-size: 11px; color: var(--muted); padding-bottom: 8px; }
.branding a { color: inherit; }

.dots { display: inline-flex; gap: 3px; }
.dots i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .4; animation: blink 1.2s infinite; }
.dots i:nth-child(2) { animation-delay: .2s; }
.dots i:nth-child(3) { animation-delay: .4s; }
@keyframes blink { 0%,60%,100% { opacity: .25 } 30% { opacity: .9 } }
@media (prefers-reduced-motion: reduce) {
  .dots i { animation: none; }
  .launcher { transition: none; }
}
`;
}
