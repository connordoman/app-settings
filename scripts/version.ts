#!/usr/bin/env bun
/**
 * Keeps every artifact in this repository on one version.
 *
 * The Go module takes its version from the git tag alone, so the committed
 * files below are what can drift: the SDK's package.json, the registry's
 * package.json, the SDK range the registry installs, the ref its README pins,
 * and the SDK's changelog. A release tags a commit where all of them agree.
 *
 *   bun scripts/version.ts current          # print the version
 *   bun scripts/version.ts check [v1.2.3]   # fail on any disagreement, or a mismatch with the tag
 *   bun scripts/version.ts set 1.2.3        # write the version everywhere
 */

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const REPO_URL = "https://github.com/connordoman/app-settings";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;

/** A place a version is written, found by a pattern whose first group is the version. */
interface Pin {
  file: string;
  what: string;
  pattern: RegExp;
  format: (version: string) => string;
}

const PINS: Pin[] = [
  {
    file: "app-settings-js/package.json",
    what: "SDK package version",
    pattern: new RegExp(String.raw`^  "version": "(${VERSION})"`, "gm"),
    format: (version) => `  "version": "${version}"`,
  },
  {
    file: "app-settings-react/package.json",
    what: "registry package version",
    pattern: new RegExp(String.raw`^  "version": "(${VERSION})"`, "gm"),
    format: (version) => `  "version": "${version}"`,
  },
  {
    file: "app-settings-react/registry.json",
    what: "SDK range the registry installs",
    pattern: new RegExp(String.raw`"app-settings-js@\^(${VERSION})"`, "g"),
    format: (version) => `"app-settings-js@^${version}"`,
  },
  {
    file: "app-settings-react/README.md",
    what: "install ref in the registry README",
    pattern: new RegExp(String.raw`connordoman/app-settings/([\w-]+)#v(${VERSION})`, "g"),
    format: (version) => `connordoman/app-settings/$1#v${version}`,
  },
];

const CHANGELOG = "app-settings-js/CHANGELOG.md";

const [command, argument] = process.argv.slice(2);

switch (command) {
  case "current":
    console.log(await current());
    break;
  case "check":
    await check(argument);
    break;
  case "set":
    await set(argument);
    break;
  default:
    fail("usage: version.ts current | check [tag] | set <version>");
}

// --- commands --------------------------------------------------------------

/** The SDK's version, which every other pin is checked against. */
async function current(): Promise<string> {
  const found = await read(PINS[0] as Pin);
  if (found.length !== 1) fail(`expected one version in ${PINS[0]?.file}, found ${found.length}`);
  return found[0] as string;
}

async function check(tag?: string): Promise<void> {
  const expected = tag ? normalize(tag) : await current();
  const problems: string[] = [];

  for (const pin of PINS) {
    const found = await read(pin);
    if (found.length === 0) problems.push(`${pin.file}: no ${pin.what} found`);
    for (const version of found) {
      if (version !== expected) problems.push(`${pin.file}: ${pin.what} is ${version}, not ${expected}`);
    }
  }

  const changelog = await Bun.file(resolve(ROOT, CHANGELOG)).text();
  if (!changelog.includes(`## [${expected}]`)) {
    problems.push(`${CHANGELOG}: no "## [${expected}]" entry`);
  }

  problems.push(...(await checkModulePath(expected)));

  if (problems.length > 0) {
    console.error(`versions disagree with ${expected}:\n`);
    for (const problem of problems) console.error(`  • ${problem}`);
    console.error(`\nrun 'just bump ${expected}' to align them`);
    process.exit(1);
  }

  console.log(`versions aligned at ${expected}`);
}

async function set(input?: string): Promise<void> {
  if (!input) fail("usage: version.ts set <version>");
  const next = normalize(input);
  const previous = await current();

  const moduleProblems = await checkModulePath(next);
  if (moduleProblems.length > 0) {
    // Moving the module path rewrites every import, which is a change to make
    // deliberately and review on its own, not as a side effect of a bump.
    fail(`${moduleProblems.join("\n")}\nchange the module path in its own commit first`);
  }

  for (const pin of PINS) {
    const path = resolve(ROOT, pin.file);
    const text = await Bun.file(path).text();
    if ((await read(pin)).length === 0) fail(`${pin.file}: no ${pin.what} found to update`);
    await Bun.write(path, text.replace(pin.pattern, (match, ...groups) => pin.format(next).replace("$1", String(groups[0]))));
  }

  await stampChangelog(previous, next);
  console.log(`${previous} → ${next}`);
}

// --- pins ------------------------------------------------------------------

/** Every version a pin currently holds. */
async function read(pin: Pin): Promise<string[]> {
  const text = await Bun.file(resolve(ROOT, pin.file)).text();
  // A pattern with a leading capture (the README's item name) keeps the version last.
  return [...text.matchAll(pin.pattern)].map((match) => match[match.length - 1] as string);
}

/** Go puts majors from 2 up in the module path, so the path must agree with the version. */
async function checkModulePath(version: string): Promise<string[]> {
  const goMod = await Bun.file(resolve(ROOT, "go.mod")).text();
  const modulePath = /^module\s+(\S+)/m.exec(goMod)?.[1] ?? "";
  const major = Number(version.split(".")[0]);
  const suffix = /\/v(\d+)$/.exec(modulePath)?.[1];

  if (major >= 2 && suffix !== String(major)) {
    return [`go.mod: module ${modulePath} needs a /v${major} suffix for ${version}`];
  }
  if (major < 2 && suffix !== undefined) {
    return [`go.mod: module ${modulePath} has a /v${suffix} suffix, but ${version} is below v2`];
  }
  return [];
}

// --- changelog -------------------------------------------------------------

/**
 * Turns the Unreleased section into a dated entry. A release with nothing for
 * the SDK still gets one, so a reader never wonders whether a version was skipped.
 */
async function stampChangelog(previous: string, next: string): Promise<void> {
  const path = resolve(ROOT, CHANGELOG);
  let text = await Bun.file(path).text();
  if (text.includes(`## [${next}]`)) return;

  const unreleased = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|\n\[Unreleased\]:)/.exec(text);
  if (!unreleased) fail(`${CHANGELOG}: no "## [Unreleased]" section`);

  const body = (unreleased[1] as string).trim();
  const date = new Date().toISOString().slice(0, 10);
  const entry = [
    "## [Unreleased]",
    "",
    `## [${next}] — ${date}`,
    "",
    body || "No changes to this package; released to stay aligned with App Settings.",
    "",
  ].join("\n");

  text = text.replace(unreleased[0], entry);
  text = text.replace(
    /^\[Unreleased\]: .*$/m,
    `[Unreleased]: ${REPO_URL}/compare/v${next}...HEAD\n[${next}]: ${REPO_URL}/compare/v${previous}...v${next}`,
  );

  await Bun.write(path, text);
}

// --- helpers ---------------------------------------------------------------

function normalize(input: string): string {
  const version = input.replace(/^v/, "");
  if (!SEMVER.test(version)) fail(`"${input}" is not a semantic version`);
  return version;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}
