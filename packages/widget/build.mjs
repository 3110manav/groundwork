import { build, context } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const version = JSON.parse(readFileSync("./package.json", "utf8")).version;
const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });

/**
 * Two artifacts, deliberately.
 *
 * 1. w.js — the loader. Customers paste this into their HTML and may never
 *    touch it again, so it must stay backward-compatible essentially forever.
 *    Keep it tiny and dumb: fetch config, resolve version, load the bundle.
 *    It is the one file we cannot fix in the field.
 *
 * 2. /w/<version>/widget.js — the real bundle, at an IMMUTABLE versioned path.
 *    Roll forward, roll back, or stage a release without touching customer HTML.
 */
const shared = {
  bundle: true,
  format: "iife",
  target: ["es2020"],
  minify: !watch,
  sourcemap: true,
  define: { __WIDGET_VERSION__: JSON.stringify(version) },
  jsx: "automatic",
  jsxImportSource: "preact",
};

const targets = [
  { entryPoints: ["src/loader.ts"], outfile: "dist/w.js", ...shared },
  { entryPoints: ["src/widget.tsx"], outfile: `dist/w/${version}/widget.js`, ...shared },
];

if (watch) {
  for (const t of targets) {
    const ctx = await context(t);
    await ctx.watch();
  }
  console.log("widget: watching");
} else {
  for (const t of targets) await build(t);
  writeFileSync("dist/version.json", JSON.stringify({ latest: version }));
  console.log(`widget: built v${version}`);
}
