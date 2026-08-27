import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ChatStreamEvent, Source, WidgetConfig } from "@groundwork/contracts";
import { styles } from "./styles.js";

/**
 * The launcher icon is owner-supplied and rendered as raw HTML, so it is an
 * injection vector into their own visitors' pages. Allow shape markup only:
 * no script/style/iframe, no event handlers, no javascript: URLs.
 */
function sanitizeIcon(raw: string): string {
  return raw
    .replace(/<\/?(script|style|iframe|object|embed|link|meta)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href|src)\s*=\s*("|')?\s*javascript:[^"'>\s]*/gi, "");
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  error?: boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Answers come back as markdown-ish text (the model isn't told to avoid it,
 * and site content it draws from often has its own structure). Left raw, a
 * visitor sees literal ** and * — this renders the safe subset we actually
 * expect: bold, italics, inline code, links, and lists. Everything is
 * HTML-escaped before any tag is introduced, since the source text is the
 * model's answer plus content pulled from the customer's own site, which is
 * untrusted the same way the launcher icon is (see sanitizeIcon above).
 */
function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
}

function renderMarkdown(raw: string): string {
  const lines = raw.split("\n");
  const blocks: string[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const bullet = /^\s*[-*]\s+(.*)/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)/.exec(line);
    const tag = bullet ? "ul" : "ol";

    if (bullet || numbered) {
      flushPara();
      const items: string[] = [];
      const re = bullet ? /^\s*[-*]\s+(.*)/ : /^\s*\d+\.\s+(.*)/;
      while (i < lines.length) {
        const m = re.exec(lines[i]!);
        if (!m) break;
        items.push(`<li>${renderInline(m[1]!)}</li>`);
        i++;
      }
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (line.trim() === "") {
      flushPara();
    } else {
      para.push(line);
    }
    i++;
  }
  flushPara();
  return blocks.join("");
}

/**
 * Remember the conversation across a page reload, scoped per site key so one
 * customer's widget never touches another's storage even on the same host
 * (e.g. a staging domain running two widgets). Storage can throw — Safari
 * private mode, a full quota, a host CSP — and none of that may break the page.
 */
const convKey = (siteKey: string) => `groundwork:conv:${siteKey}`;

function readStoredConversation(siteKey: string): string | null {
  try {
    return localStorage.getItem(convKey(siteKey));
  } catch {
    return null;
  }
}

function writeStoredConversation(siteKey: string, conversationId: string): void {
  try {
    localStorage.setItem(convKey(siteKey), conversationId);
  } catch {
    /* never break the host page over storage */
  }
}

/**
 * Consume the SSE envelope. The event shape is a forever-contract: a customer's
 * page may be running a bundle from years ago, so this must tolerate unknown
 * event types rather than throwing on them.
 */
async function* streamChat(
  cfg: WidgetConfig,
  message: string,
  conversationId: string | null,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch(`${cfg.apiBaseUrl}/v1/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-site-key": cfg.siteKey },
    body: JSON.stringify({ message, conversationId }),
    signal,
  });

  if (!res.ok || !res.body) {
    yield { type: "error", code: "upstream_unavailable", message: "The assistant is temporarily unavailable." };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        yield JSON.parse(line.slice(6)) as ChatStreamEvent;
      } catch {
        /* ignore malformed frame rather than killing the stream */
      }
    }
  }
}

function Widget({ cfg }: { cfg: WidgetConfig }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const conversationId = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Returning visitor: reattach to the stored conversation and repaint what
  // they already asked, so reopening the widget after a reload doesn't look
  // like amnesia even though the model itself is stateless per request.
  useEffect(() => {
    const stored = readStoredConversation(cfg.siteKey);
    if (!stored) {
      setHistoryLoaded(true);
      return;
    }
    conversationId.current = stored;
    (async () => {
      try {
        const res = await fetch(`${cfg.apiBaseUrl}/v1/history/${stored}`, {
          headers: { "x-site-key": cfg.siteKey },
        });
        if (res.ok) {
          const data = (await res.json()) as { messages?: Msg[] };
          if (data.messages?.length) setMessages(data.messages);
        }
      } catch {
        /* stay on a fresh conversation rather than surface an error */
      } finally {
        setHistoryLoaded(true);
      }
    })();
  }, [cfg.apiBaseUrl, cfg.siteKey]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      setInput("");
      setBusy(true);
      setMessages((m) => [...m, { role: "user", content: trimmed }, { role: "assistant", content: "" }]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        for await (const ev of streamChat(cfg, trimmed, conversationId.current, controller.signal)) {
          if (ev.type === "start") {
            conversationId.current = ev.conversationId;
            writeStoredConversation(cfg.siteKey, ev.conversationId);
          } else if (ev.type === "sources") {
            setMessages((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              if (last) next[next.length - 1] = { ...last, sources: ev.sources };
              return next;
            });
          } else if (ev.type === "delta") {
            setMessages((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              if (last) next[next.length - 1] = { ...last, content: last.content + ev.text };
              return next;
            });
          } else if (ev.type === "error") {
            setMessages((m) => {
              const next = [...m];
              next[next.length - 1] = { role: "assistant", content: ev.message, error: true };
              return next;
            });
          }
        }
      } catch {
        setMessages((m) => {
          const next = [...m];
          next[next.length - 1] = { role: "assistant", content: "Connection lost.", error: true };
          return next;
        });
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, cfg],
  );

  const showSuggested = historyLoaded && messages.length === 0 && cfg.suggestedQuestions.length > 0;

  return (
    <div class="root">
      {open && (
        <div class="panel" role="dialog" aria-label={cfg.assistantName}>
          <div class="header">
            {cfg.avatarUrl && <img class="avatar" src={cfg.avatarUrl} alt="" />}
            <span class="name">{cfg.assistantName}</span>
            <button onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>

          <div class="log" ref={logRef}>
            <div class="msg assistant">{cfg.greeting}</div>
            {messages.map((m, i) => (
              <div class="turn" key={i}>
                <div class={`msg ${m.role}${m.error ? " error" : ""}`}>
                  {m.content ? (
                    m.role === "assistant" && !m.error ? (
                      <span dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                    ) : (
                      m.content
                    )
                  ) : busy && i === messages.length - 1 ? (
                    <span class="dots"><i /><i /><i /></span>
                  ) : null}
                </div>
                {m.sources && m.sources.length > 0 && (
                  <div class="sources">
                    {m.sources.map((s) => (
                      <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.title}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {showSuggested && (
            <div class="suggested">
              {cfg.suggestedQuestions.map((q) => (
                <button onClick={() => void send(q)}>{q}</button>
              ))}
            </div>
          )}

          <form
            class="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <input
              value={input}
              placeholder={cfg.placeholder}
              onInput={(e) => setInput((e.target as HTMLInputElement).value)}
              aria-label={cfg.placeholder}
            />
            <button type="submit" disabled={busy || !input.trim()}>Send</button>
          </form>

          {cfg.showBranding && <div class="branding">Powered by Groundwork</div>}
        </div>
      )}

      <button class="launcher" onClick={() => setOpen((o) => !o)} aria-label={open ? "Close chat" : "Open chat"}>
        {cfg.launcher.icon ? (
          <span dangerouslySetInnerHTML={{ __html: sanitizeIcon(cfg.launcher.icon) }} />
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" />
          </svg>
        )}
      </button>
    </div>
  );
}

/** Mount into a closed Shadow DOM so host CSS cannot reach in. */
(function mount() {
  const cfg = (window as unknown as Record<string, unknown>).__GROUNDWORK_CONFIG__ as
    | WidgetConfig
    | undefined;
  if (!cfg) return;

  const host = document.createElement("div");
  host.setAttribute("data-groundwork", "");
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const sheet = document.createElement("style");
  sheet.textContent = styles(cfg);
  shadow.appendChild(sheet);

  const mountPoint = document.createElement("div");
  shadow.appendChild(mountPoint);
  render(<Widget cfg={cfg} />, mountPoint);

  // Replace the loader's queueing stub and drain anything queued before boot.
  const w = window as unknown as Record<string, unknown>;
  const queued = (w.Groundwork as { __queue?: [string, unknown[]][] })?.__queue ?? [];
  const api = {
    open: () => host.dispatchEvent(new CustomEvent("groundwork:open")),
    close: () => host.dispatchEvent(new CustomEvent("groundwork:close")),
    version: "__WIDGET_VERSION__",
  };
  w.Groundwork = api;
  for (const [method, args] of queued) {
    const fn = (api as unknown as Record<string, unknown>)[method];
    if (typeof fn === "function") (fn as (...a: unknown[]) => void)(...args);
  }
})();
