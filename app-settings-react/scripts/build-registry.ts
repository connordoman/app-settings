#!/usr/bin/env bun
/**
 * Builds and checks the App Settings shadcn registry.
 *
 * The registry is installable straight from GitHub, so a build is not needed to
 * publish it — `shadcn add connordoman/app-settings/setting-field` reads
 * `registry.json` from the repository. What this script produces is the hosted
 * form: one JSON file per item with its sources inlined, which is what a
 * namespaced registry (`@app-settings/setting-field`) resolves against.
 *
 * It also checks what the JSON schema cannot: that every file exists, that
 * every target lands where the CLI will rewrite imports to, and that every
 * import is covered by a declared dependency. A missing `registryDependencies`
 * entry is the failure mode that matters — it installs code that does not
 * compile in someone else's project.
 *
 *   bun run scripts/build-registry.ts            # write r/
 *   bun run scripts/build-registry.ts --check    # validate only
 *   bun run scripts/build-registry.ts --base-url https://example.com/r
 */

import { dirname, join, relative, resolve } from "node:path";

/** Where a namespaced install resolves items from, by default. */
const DEFAULT_BASE_URL =
  "https://raw.githubusercontent.com/connordoman/app-settings/main/app-settings-react/r";

/** The GitHub address prefix an item of this registry is referred to by. */
const GITHUB_PREFIX = "connordoman/app-settings/";

/** Imports every React project already has, so they need no declaration. */
const AMBIENT_PACKAGES = new Set(["react", "react-dom", "react/jsx-runtime"]);

/** Placeholders the CLI resolves against the consumer's components.json. */
const TARGET_PLACEHOLDERS = ["@ui/", "@components/", "@lib/", "@hooks/", "~/"];

interface RegistryFile {
  path: string;
  type: string;
  target?: string;
  content?: string;
}

interface RegistryItem {
  name: string;
  type: string;
  title?: string;
  description?: string;
  dependencies?: string[];
  devDependencies?: string[];
  registryDependencies?: string[];
  files?: RegistryFile[];
  [key: string]: unknown;
}

interface Registry {
  $schema?: string;
  name?: string;
  homepage?: string;
  include?: string[];
  items?: RegistryItem[];
}

/** One item plus where its files were declared, since `include` shifts that. */
interface LoadedItem {
  item: RegistryItem;
  /** Directory the item's file paths are relative to. */
  root: string;
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const baseUrl = (valueOf("--base-url") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const outDir = resolve(valueOf("--out") ?? "r");
const registryPath = resolve(valueOf("--registry") ?? "registry.json");

const problems: string[] = [];

const root = await loadRegistry(registryPath);
const items = root.items;
const byName = new Map(items.map((entry) => [entry.item.name, entry]));

await checkItems();

if (problems.length > 0) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"} found:\n`);
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

if (checkOnly) {
  console.log(
    `registry ok — ${items.length} items, ${items.reduce((total, entry) => total + (entry.item.files?.length ?? 0), 0)} files`,
  );
  process.exit(0);
}

await build();

// --- loading ---------------------------------------------------------------

async function loadRegistry(
  path: string,
): Promise<{ registry: Registry; items: LoadedItem[] }> {
  const file = Bun.file(path);
  if (!(await file.exists())) fail(`no registry at ${rel(path)}`);

  const registry = (await file.json()) as Registry;
  const here = dirname(path);
  const loaded: LoadedItem[] = (registry.items ?? []).map((item) => ({ item, root: here }));

  // `include` composes registries; a nested file's paths are relative to it.
  for (const included of registry.include ?? []) {
    const nested = await loadRegistry(resolve(here, included));
    loaded.push(...nested.items);
  }

  return { registry, items: loaded };
}

// --- checking --------------------------------------------------------------

async function checkItems(): Promise<void> {
  for (const { item, root: itemRoot } of items) {
    if (!item.name) problems.push("an item has no name");
    if (!item.type?.startsWith("registry:")) {
      problems.push(`${item.name}: type "${item.type}" is not a registry type`);
    }
    if (!item.title) problems.push(`${item.name}: no title, which is what the CLI shows`);
    if (!item.description) problems.push(`${item.name}: no description`);

    for (const dependency of item.registryDependencies ?? []) {
      if (!dependency.startsWith(GITHUB_PREFIX)) continue;
      const name = dependency.slice(GITHUB_PREFIX.length);
      if (!byName.has(name)) {
        problems.push(`${item.name}: depends on "${dependency}", which this registry has no item for`);
      }
    }

    for (const file of item.files ?? []) {
      const absolute = resolve(itemRoot, file.path);
      if (!(await Bun.file(absolute).exists())) {
        problems.push(`${item.name}: ${file.path} does not exist`);
        continue;
      }

      if (!file.target) {
        problems.push(`${item.name}: ${file.path} has no target, so it would land by type alone`);
      } else if (!TARGET_PLACEHOLDERS.some((prefix) => file.target?.startsWith(prefix))) {
        problems.push(
          `${item.name}: target "${file.target}" starts with no placeholder, so it would be written to a literal path`,
        );
      } else {
        checkTargetMatchesImportPath(item.name, file);
      }
    }
  }

  await checkImports();
}

/**
 * The CLI rewrites `@/registry/<anything>/ui/x` to the consumer's ui alias plus
 * `/x`. If the target does not agree with that, a file lands in one place and
 * its siblings import it from another.
 */
function checkTargetMatchesImportPath(itemName: string, file: RegistryFile): void {
  const match = /^registry\/[^/]+\/(lib|hooks|ui)\/(.+)$/.exec(file.path);
  if (!match) {
    problems.push(
      `${itemName}: ${file.path} is not under registry/<namespace>/{lib,hooks,ui}/, so its imports will not be rewritten`,
    );
    return;
  }

  const [, slot, rest] = match;
  const placeholder = slot === "ui" ? "@ui/" : slot === "lib" ? "@lib/" : "@hooks/";
  const expected = `${placeholder}${rest}`;

  if (file.target !== expected) {
    problems.push(
      `${itemName}: ${file.path} targets "${file.target}" but its imports rewrite to "${expected}"`,
    );
  }
}

async function checkImports(): Promise<void> {
  // Every file this registry ships, by the import path that reaches it.
  const owners = new Map<string, string>();
  for (const { item, root: itemRoot } of items) {
    for (const file of item.files ?? []) {
      owners.set(withoutExtension(resolve(itemRoot, file.path)), item.name);
    }
  }

  for (const { item, root: itemRoot } of items) {
    const reachable = closure(item.name);

    for (const file of item.files ?? []) {
      const absolute = resolve(itemRoot, file.path);
      const source = await Bun.file(absolute).text();

      for (const specifier of importsOf(source)) {
        // A sibling in this registry.
        if (specifier.startsWith("@/registry/")) {
          const target = withoutExtension(resolve(itemRoot, specifier.replace(/^@\//, "")));
          const owner = owners.get(target);
          if (!owner) {
            problems.push(`${item.name}: ${file.path} imports "${specifier}", which no item ships`);
          } else if (!reachable.has(owner)) {
            problems.push(
              `${item.name}: ${file.path} imports "${specifier}" from item "${owner}", which is not in its registryDependencies`,
            );
          }
          continue;
        }

        // A shadcn primitive, which the consumer may or may not already have.
        const primitive = /^@\/components\/ui\/([^/]+)$/.exec(specifier);
        if (primitive) {
          const name = primitive[1] as string;
          if (!reachable.has(`ui:${name}`)) {
            problems.push(
              `${item.name}: ${file.path} imports the "${name}" primitive, which is not in its registryDependencies`,
            );
          }
          continue;
        }

        // `cn` comes with every shadcn project.
        if (specifier === "@/lib/utils") continue;

        // Anything else is an npm package.
        const packageName = packageOf(specifier);
        if (AMBIENT_PACKAGES.has(packageName)) continue;
        if (!reachable.has(`npm:${packageName}`)) {
          problems.push(
            `${item.name}: ${file.path} imports "${packageName}", which is not in its dependencies`,
          );
        }
      }
    }
  }
}

/**
 * Everything an item can rely on: itself, the items it depends on, and their
 * dependencies — npm and shadcn ones included, tagged so they cannot collide
 * with item names.
 */
function closure(name: string): Set<string> {
  const seen = new Set<string>();
  const queue = [name];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);

    const entry = byName.get(current);
    if (!entry) continue;

    for (const dependency of entry.item.dependencies ?? []) {
      seen.add(`npm:${packageOf(stripVersion(dependency))}`);
    }
    for (const dependency of entry.item.registryDependencies ?? []) {
      if (dependency.startsWith(GITHUB_PREFIX)) {
        queue.push(dependency.slice(GITHUB_PREFIX.length));
      } else if (!dependency.includes("/") && !dependency.includes(":")) {
        seen.add(`ui:${dependency}`);
      }
    }
  }

  return seen;
}

// --- building --------------------------------------------------------------

async function build(): Promise<void> {
  const catalog: Registry = {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    name: root.registry.name,
    homepage: root.registry.homepage,
    items: [],
  };

  for (const { item, root: itemRoot } of items) {
    const files: RegistryFile[] = [];
    for (const file of item.files ?? []) {
      files.push({
        ...file,
        content: await Bun.file(resolve(itemRoot, file.path)).text(),
      });
    }

    const hosted: RegistryItem = {
      $schema: "https://ui.shadcn.com/schema/registry-item.json",
      ...item,
      // A hosted item cannot resolve a GitHub address in the same repository,
      // so its siblings are pointed at their own hosted URLs instead.
      registryDependencies: (item.registryDependencies ?? []).map((dependency) =>
        dependency.startsWith(GITHUB_PREFIX)
          ? `${baseUrl}/${dependency.slice(GITHUB_PREFIX.length)}.json`
          : dependency,
      ),
      ...(files.length > 0 ? { files } : {}),
    } as RegistryItem;

    if ((hosted.registryDependencies as string[]).length === 0) {
      delete hosted.registryDependencies;
    }

    await Bun.write(join(outDir, `${item.name}.json`), `${JSON.stringify(hosted, null, 2)}\n`);

    // The catalog lists items without their contents, for `shadcn list`.
    const { files: _files, ...summary } = item;
    catalog.items?.push(summary as RegistryItem);
  }

  await Bun.write(join(outDir, "registry.json"), `${JSON.stringify(catalog, null, 2)}\n`);

  console.log(`wrote ${items.length + 1} files to ${rel(outDir)}/`);
  console.log(`namespace install: shadcn registry add @app-settings=${baseUrl}/{name}.json`);
}

// --- helpers ---------------------------------------------------------------

/** Every module specifier in a source file, from imports and re-exports. */
function importsOf(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bimport\s+(?:type\s+)?[^;'"]*?from\s*["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
    }
  }

  return [...found];
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

/** `zod@^3.20.0` → `zod`, leaving a scope's leading @ alone. */
function stripVersion(dependency: string): string {
  const at = dependency.lastIndexOf("@");
  return at > 0 ? dependency.slice(0, at) : dependency;
}

function withoutExtension(path: string): string {
  return path.replace(/\.(tsx?|jsx?)$/, "");
}

function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function rel(path: string): string {
  return relative(process.cwd(), path) || ".";
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}
