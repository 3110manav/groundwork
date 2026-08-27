/**
 * The loader. ~2KB, and a forever-contract.
 *
 * A customer pasted this script tag and may not touch it for three years, so
 * everything here must keep working against every future API. Its only jobs
 * are: read the site key, fetch config, resolve a bundle version, inject it.
 * Resist every temptation to add logic — this is the file we cannot fix in
 * the field.
 */
declare const __WIDGET_VERSION__: string;

interface BootConfig {
  configVersion: string;
  apiBaseUrl: string;
  [k: string]: unknown;
}

type QueuedCall = [method: string, args: unknown[]];

(function boot() {
  const script = document.currentScript as HTMLScriptElement | null;
  const siteKey = script?.dataset.siteKey;
  if (!siteKey) {
    console.warn("[groundwork] missing data-site-key");
    return;
  }

  // Allow self-hosted deployments to point at their own API without editing
  // the bundle. Never hard-code our domain.
  const apiBase =
    script?.dataset.apiBase ??
    (script?.src ? new URL(script.src).origin : "") ;

  const cdnBase = script?.src ? new URL(".", script.src).href : "/";

  // Queue any calls made before the real bundle lands, so
  // Groundwork.open() works immediately after the tag.
  const queue: QueuedCall[] = [];
  const stub = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) =>
      prop === "__queue"
        ? queue
        : (...args: unknown[]) => queue.push([prop, args]),
  });
  (window as unknown as Record<string, unknown>).Groundwork = stub;

  const load = async () => {
    try {
      const res = await fetch(`${apiBase}/v1/config/${encodeURIComponent(siteKey)}`, {
        credentials: "omit",
      });
      if (!res.ok) return;
      const config = (await res.json()) as BootConfig;

      (window as unknown as Record<string, unknown>).__GROUNDWORK_CONFIG__ = config;

      const el = document.createElement("script");
      el.async = true;
      el.src = `${cdnBase}w/${__WIDGET_VERSION__}/widget.js`;
      document.head.appendChild(el);
    } catch {
      /* never break the host page */
    }
  };

  // Do not compete with the customer's own LCP.
  if ("requestIdleCallback" in window) {
    (window as unknown as { requestIdleCallback: (cb: () => void, o?: object) => void })
      .requestIdleCallback(load, { timeout: 3000 });
  } else {
    setTimeout(load, 1200);
  }
})();
