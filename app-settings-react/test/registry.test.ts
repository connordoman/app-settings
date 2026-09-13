import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The registry manifest is the published contract: a wrong target or a missing
 * dependency installs code that does not compile in someone else's project, and
 * nothing in this package's own type-check would notice.
 */

const script = "scripts/build-registry.ts";

describe("registry", () => {
  test("the manifest passes its own checks", async () => {
    const result = Bun.spawnSync(["bun", script, "--check"]);

    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("the root manifest reaches the same items through include", async () => {
    const result = Bun.spawnSync(["bun", script, "--check", "--registry", "../registry.json"]);

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("7 items");
  });

  test("every item declares a title and a description for the CLI to show", async () => {
    const registry = await Bun.file("registry.json").json();

    for (const item of registry.items) {
      expect(item.title, `${item.name} has no title`).toBeTruthy();
      expect(item.description, `${item.name} has no description`).toBeTruthy();
    }
  });

  test("every file installs under an app-settings directory of its own", async () => {
    const registry = await Bun.file("registry.json").json();

    for (const item of registry.items) {
      for (const file of item.files ?? []) {
        expect(file.target, `${item.name}: ${file.path}`).toMatch(
          /^@(ui|lib|hooks)\/app-settings\//,
        );
      }
    }
  });

  test("the built output in r/ is current", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "app-settings-registry-"));

    try {
      const build = Bun.spawnSync(["bun", script, "--out", temporary]);
      expect(build.exitCode).toBe(0);

      const built = (await readdir(temporary)).sort();
      expect((await readdir("r")).sort()).toEqual(built);

      for (const name of built) {
        const fresh = await Bun.file(join(temporary, name)).text();
        const committed = await Bun.file(join("r", name)).text();
        expect(committed, `r/${name} is stale: run 'just build'`).toBe(fresh);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
