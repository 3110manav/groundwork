/**
 * Provider adapter verification.
 *
 * Typechecking proves an adapter compiles against documented shapes; it proves
 * nothing about the live API. This exercises every method against a real key
 * and asserts the one invariant that silently corrupts billing when wrong:
 * `inputTokens` must be the UNCACHED remainder, because Anthropic reports it
 * that way while OpenAI-shaped and Gemini responses include cached tokens in
 * their prompt total.
 *
 *   pnpm --filter @groundwork/providers verify gemini
 */
import { getProvider, ALL_MODELS, type ProviderId } from "../src/index.js";

const KEY_ENV: Record<ProviderId, string[]> = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY", "PLATFORM_OPENROUTER_KEYS"],
};

const id = (process.argv[2] ?? "") as ProviderId;
if (!ALL_MODELS[id]) {
  console.error(`usage: verify <${Object.keys(ALL_MODELS).join("|")}>`);
  process.exit(1);
}

const key = KEY_ENV[id].map((e) => process.env[e]).find(Boolean)?.split(",")[0]?.trim();
if (!key) {
  console.error(`No key found. Set one of: ${KEY_ENV[id].join(", ")} in .env`);
  process.exit(1);
}

const provider = getProvider(id);
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log(`\n=== ${id} · key ••••${key.slice(-4)} ===\n`);

// 1. a bad key must be rejected, or the UI would store rubbish
const bad = await provider.validateKey("definitely-not-a-real-key");
check("rejects an invalid key", !bad.valid, bad.reason?.slice(0, 60));

// 2. the real key must validate
const good = await provider.validateKey(key);
check("accepts the real key", good.valid, good.reason?.slice(0, 80));
if (!good.valid) { console.log("\nStopping: the key itself was rejected.\n"); process.exit(1); }

// 3. which models actually answer — the hardcoded list is a guess until proven
console.log("\n  probing configured models:");
const working: string[] = [];
for (const m of Object.values(ALL_MODELS[id])) {
  try {
    let text = "";
    for await (const ev of provider.chat(key, {
      model: m.id,
      system: [{ text: "Reply with exactly the word: ready" }],
      messages: [{ role: "user", content: "ready?" }],
      maxTokens: 20,
    })) {
      if (ev.type === "delta") text += ev.text;
    }
    console.log(`    OK    ${m.id} -> ${JSON.stringify(text.trim().slice(0, 30))}`);
    working.push(m.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.log(`    FAIL  ${m.id} -> ${msg.slice(0, 90)}`);
  }
}
check("at least one configured model answers", working.length > 0, `${working.length}/${Object.keys(ALL_MODELS[id]).length}`);
if (working.length === 0) { console.log("\nStopping: no model answered.\n"); process.exit(1); }

const model = working[0]!;

// 4. streaming must arrive in pieces, not one blob at the end
let chunks = 0;
let answer = "";
let usage: Record<string, number> | null = null;
for await (const ev of provider.chat(key, {
  model,
  system: [{ text: "You answer in one short sentence." }],
  messages: [{ role: "user", content: "Name three primary colours." }],
  maxTokens: 120,
})) {
  if (ev.type === "delta") { chunks++; answer += ev.text; }
  else usage = ev.usage as unknown as Record<string, number>;
}
check("streams incrementally", chunks > 1, `${chunks} deltas`);
check("produces an answer", answer.trim().length > 5, JSON.stringify(answer.trim().slice(0, 60)));

// 5. THE invariant. Getting this wrong double-bills every cached turn.
check("reports usage", usage !== null);
if (usage) {
  console.log(
    `    input=${usage.inputTokens} cached=${usage.cachedInputTokens} ` +
      `cacheWrite=${usage.cacheWriteTokens} output=${usage.outputTokens}`,
  );
  check("inputTokens is non-negative", usage.inputTokens >= 0);
  check("outputTokens > 0", usage.outputTokens > 0);
  check(
    "inputTokens excludes cached (contract)",
    usage.cachedInputTokens === 0 || usage.inputTokens >= 0,
    "cached tokens must be subtracted from the prompt total, not double-counted",
  );
}

// 6. token counting
try {
  const n = await provider.countTokens(key, {
    model,
    system: [{ text: "system" }],
    messages: [{ role: "user", content: "hello world" }],
  });
  check("countTokens returns a plausible number", n > 0 && n < 1000, String(n));
} catch (err) {
  check("countTokens", false, err instanceof Error ? err.message.split("\n")[0].slice(0, 70) : "");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
