#!/usr/bin/env bun
/**
 * Builds the publishable package into dist/ and then checks that what it built
 * actually works.
 *
 * The verification is not ceremony. Two of the steps here fail silently if they
 * regress: Bun's bundler resolves a `./x.ts` specifier but not `./x.js`, so a
 * wrong extension yields a bundle of re-exports with no implementation and a
 * zero exit code; and TypeScript emits declarations carrying whatever specifier
 * the source used, which is a `.ts` path that does not exist in dist/. Both
 * produce a package that installs cleanly and then fails at the consumer.
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const entry = join(root, "src/index.ts");

await step("clean", async () => {
  await rm(dist, { recursive: true, force: true });
});

await step("bundle esm + cjs", async () => {
  for (const [format, naming] of [
    ["esm", "[dir]/[name].js"],
    ["cjs", "[dir]/[name].cjs"],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: dist,
      format,
      target: "node",
      naming,
      sourcemap: "linked",
    });

    if (!result.success) {
      throw new Error(`${format} build failed:\n${result.logs.join("\n")}`);
    }
  }
});

await step("emit declarations", async () => {
  await $`bunx tsc -p ${join(root, "tsconfig.build.json")}`.cwd(root).quiet();
});

await step("rewrite declaration specifiers", async () => {
  // TypeScript keeps the source's own `.ts` specifier in its output, and
  // `rewriteRelativeImportExtensions` is not honoured by the compiler this
  // project pins. dist/ holds `.d.ts` files, so the specifier must say `.js`.
  let rewritten = 0;
  for (const file of await readdir(dist)) {
    if (!file.endsWith(".d.ts") && !file.endsWith(".d.ts.map")) continue;

    const path = join(dist, file);
    const before = await readFile(path, "utf8");
    const after = before.replace(/(from\s*"\.\/[a-z]+)\.ts"/g, '$1.js"');
    if (after !== before) {
      await writeFile(path, after);
      rewritten++;
    }
  }
  return `${rewritten} file(s)`;
});

await step("emit CommonJS declarations", async () => {
  // package.json says `type: module`, so every .d.ts is read as an ESM
  // declaration. The `require` condition resolves to a CommonJS file, and
  // pairing it with ESM types makes the package "masquerade as ESM" — the
  // consumer's compiler models the wrong module system. A .d.cts sibling for
  // each declaration fixes it; `./x.cjs` resolves to `x.d.cts` the same way
  // `./x.js` resolves to `x.d.ts`.
  let written = 0;
  for (const file of await readdir(dist)) {
    if (!file.endsWith(".d.ts")) continue;

    const contents = await readFile(join(dist, file), "utf8");
    const commonjs = contents
      .replace(/(from\s*"\.\/[a-z]+)\.js"/g, '$1.cjs"')
      // The declaration map names the .d.ts file, so it does not describe this copy.
      .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
      .trimEnd() + "\n";

    await writeFile(join(dist, file.replace(/\.d\.ts$/, ".d.cts")), commonjs);
    written++;
  }
  return `${written} file(s)`;
});

await step("slim sourcemaps", async () => {
  // Bun embeds every source in `sourcesContent`, and the package also ships
  // src/ for the declaration maps to point at. Keeping both duplicates the
  // whole library in the tarball, so drop the copy: `../src/x.ts` resolves
  // from dist/ to a file that is published alongside it.
  let saved = 0;
  for (const file of await readdir(dist)) {
    if (!file.endsWith(".js.map") && !file.endsWith(".cjs.map")) continue;

    const path = join(dist, file);
    const map = JSON.parse(await readFile(path, "utf8")) as {
      sources: string[];
      sourcesContent?: unknown;
    };
    if (!map.sourcesContent) continue;

    if (!map.sources.every((source) => existsSync(join(dist, source)))) {
      throw new Error(`${file} references sources that are not published; keeping sourcesContent`);
    }

    const before = (await readFile(path)).byteLength;
    delete map.sourcesContent;
    await writeFile(path, JSON.stringify(map));
    saved += before - (await readFile(path)).byteLength;
  }
  return `${Math.round(saved / 1024)}KB smaller`;
});

await step("verify bundles carry an implementation", async () => {
  for (const file of ["index.js", "index.cjs"]) {
    const path = join(dist, file);
    if (!existsSync(path)) throw new Error(`dist/${file} was never written`);

    const contents = await readFile(path, "utf8");
    // The give-away for an unresolved bundle: exported names, no class bodies.
    if (!contents.includes("class AppSettingsError") || !contents.includes("class AppSettingsClient")) {
      throw new Error(
        `dist/${file} is ${contents.length} bytes and contains no implementation.\n\n` +
          "Two known causes, both of which exit zero and produce a file that is not valid JavaScript:\n" +
          "  1. A src/ import used a .js specifier. Bun's bundler resolves ./x.ts, not ./x.js.\n" +
          "  2. package.json declares `sideEffects`. Bun 1.4.0 then tree-shakes every module\n" +
          "     out of a pure re-export barrel, leaving `export { ... }` with nothing bound.\n" +
          "     The field has to stay out until that is fixed upstream.",
      );
    }
    if (contents.length < 10_000) {
      throw new Error(`dist/${file} is only ${contents.length} bytes; expected the whole library`);
    }
  }
});

await step("verify every declaration import resolves", async () => {
  for (const file of await readdir(dist)) {
    const commonjs = file.endsWith(".d.cts");
    if (!file.endsWith(".d.ts") && !commonjs) continue;

    const contents = await readFile(join(dist, file), "utf8");
    for (const match of contents.matchAll(/from\s*"(\.\/[^"]+)"/g)) {
      const specifier = match[1];
      if (!specifier) continue;

      if (specifier.endsWith(".ts")) {
        throw new Error(`dist/${file} imports "${specifier}", which will not exist for a consumer`);
      }
      // A .d.cts must reference .cjs siblings, a .d.ts must reference .js ones;
      // crossing them is what reintroduces the module-system mismatch.
      const expected = commonjs ? ".cjs" : ".js";
      if (!specifier.endsWith(expected)) {
        throw new Error(`dist/${file} imports "${specifier}", but should reference a ${expected} sibling`);
      }
      const target = specifier.replace(/^\.\//, "").replace(/\.c?js$/, commonjs ? ".d.cts" : ".d.ts");
      if (!existsSync(join(dist, target))) {
        throw new Error(`dist/${file} imports "${specifier}", but dist/${target} is missing`);
      }
    }
  }
});

await step("smoke-test esm and cjs from outside the package", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "app-settings-smoke-"));
  try {
    // Exercise the real entry points the way a consumer's runtime would, with
    // a stub fetch so the check needs no server.
    const body = JSON.stringify({
      environment: "production",
      role: "user",
      settings: [
        { id: "1", name: "dark_mode", type: "BOOLEAN", role: "user", scope: "PERSONAL",
          platform: "web", environment: "production", value: true, source: "PERSONAL" },
      ],
      resolved_at: "2026-01-02T20:04:05Z",
    });

    const assertions = `
      const client = new AppSettingsClient({
        baseUrl: "https://settings.test",
        apiKey: "as_smoke",
        environment: "production",
        fetch: async () => new Response(${JSON.stringify(body)}, {
          status: 200, headers: { "content-type": "application/json" },
        }),
      });
      const snapshot = await client.resolveUser("alice");
      if (snapshot.boolean("dark_mode") !== true) throw new Error("snapshot read failed");
      if (toInstant(new Date(0)) !== "1970-01-01T00:00:00.000Z") throw new Error("toInstant failed");
      const store = createSettingsStore(client, { userId: "alice" });
      await store.refresh();
      if (store.getSnapshot().status !== "ready") throw new Error("store failed");
      if (store.getSnapshot() !== store.getSnapshot()) throw new Error("state identity unstable");
    `;

    await writeFile(
      join(sandbox, "esm.mjs"),
      `import { AppSettingsClient, createSettingsStore, toInstant } from ${JSON.stringify(join(dist, "index.js"))};\n${assertions}\nconsole.log("esm ok");`,
    );
    await writeFile(
      join(sandbox, "cjs.cjs"),
      `const { AppSettingsClient, createSettingsStore, toInstant } = require(${JSON.stringify(join(dist, "index.cjs"))});\n(async () => {${assertions}\nconsole.log("cjs ok");})();`,
    );

    // Node is the runtime that actually distinguishes ESM from CJS, so use it
    // when it is present and fall back to Bun when it is not.
    const runtime = (await $`which node`.quiet().nothrow()).exitCode === 0 ? "node" : "bun";
    await $`${runtime} ${join(sandbox, "esm.mjs")}`.quiet();
    await $`${runtime} ${join(sandbox, "cjs.cjs")}`.quiet();
    return `via ${runtime}`;
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

console.log("\nbuild ok — dist/ is publishable");

/** Runs one build step, reporting it on a single line. */
async function step(name: string, run: () => Promise<string | void>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await run();
    const suffix = detail ? ` (${detail})` : "";
    console.log(`  ok    ${name}${suffix} — ${Date.now() - started}ms`);
  } catch (error) {
    console.error(`  FAIL  ${name}\n\n${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
