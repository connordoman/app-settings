import { describe, expect, test } from "bun:test";

import {
  asArray,
  describeOverride,
  controlValue,
  formatDateTimeInput,
  formatJsonInput,
  formatValue,
  isEnforced,
  isMultiSelect,
  numberStep,
  optionFromToken,
  optionToken,
  parseJsonInput,
  parseNumberInput,
  selectOptions,
  settingStatus,
  sourceForLayer,
  sourceLabel,
  validateValue,
  valuesEqual,
  visibleOverride,
  withValue,
} from "@/registry/app-settings/lib/app-settings/values";
import { resolution, setting } from "./fixtures";

describe("validateValue", () => {
  test("BOOLEAN takes only booleans", () => {
    const flag = setting({ type: "BOOLEAN" });
    expect(validateValue(flag, true)).toBeNull();
    expect(validateValue(flag, "true")?.rule).toBe("type");
  });

  test("NUMBER honours bounds and the integer flag", () => {
    const rate = setting({
      type: "NUMBER",
      type_config: { min: 1, max: 10, integer: true },
    });

    expect(validateValue(rate, 5)).toBeNull();
    expect(validateValue(rate, 0)?.rule).toBe("min");
    expect(validateValue(rate, 11)?.rule).toBe("max");
    expect(validateValue(rate, 1.5)?.rule).toBe("integer");
    expect(validateValue(rate, Number.NaN)?.rule).toBe("type");
  });

  test("STRING honours length and pattern", () => {
    const slug = setting({
      type: "STRING",
      type_config: { min_length: 2, max_length: 5, pattern: "[a-z]+" },
    });

    expect(validateValue(slug, "abc")).toBeNull();
    expect(validateValue(slug, "a")?.rule).toBe("min_length");
    expect(validateValue(slug, "abcdef")?.rule).toBe("max_length");
    expect(validateValue(slug, "AB")?.rule).toBe("pattern");
  });

  test("a pattern is anchored to the whole value", () => {
    const slug = setting({ type: "STRING", type_config: { pattern: "a+" } });
    expect(validateValue(slug, "aaa")).toBeNull();
    expect(validateValue(slug, "aaab")?.rule).toBe("pattern");
  });

  test("a pattern JavaScript cannot read is not treated as a failure", () => {
    const odd = setting({ type: "STRING", type_config: { pattern: "(?P<name>x)" } });
    expect(validateValue(odd, "anything")).toBeNull();
  });

  test("DATETIME needs an offset", () => {
    const cutoff = setting({ type: "DATETIME" });
    expect(validateValue(cutoff, "2026-01-02T15:04:05Z")).toBeNull();
    expect(validateValue(cutoff, "2026-01-02T15:04")?.rule).toBe("type");
  });

  test("SELECT values must be offered", () => {
    const tier = setting({
      type: "SELECT",
      type_config: { type: "NUMBER", options: [["Low", 1], ["High", 2]] },
    });

    expect(validateValue(tier, 1)).toBeNull();
    expect(validateValue(tier, 3)?.rule).toBe("option");
  });

  test("a multiple SELECT takes a list of offered values", () => {
    const regions = setting({
      type: "SELECT",
      type_config: { options: [["EU", "eu"], ["US", "us"]], multiple: true },
    });

    expect(validateValue(regions, ["eu", "us"])).toBeNull();
    expect(validateValue(regions, "eu")?.rule).toBe("type");
    expect(validateValue(regions, ["eu", "apac"])?.rule).toBe("option");
  });

  test("JSON takes anything serialisable", () => {
    const payload = setting({ type: "JSON" });
    expect(validateValue(payload, { a: [1, 2] })).toBeNull();
    expect(validateValue(payload, null)).toBeNull();
    expect(validateValue(payload, Number.POSITIVE_INFINITY)?.rule).toBe("json");
  });
});

describe("state", () => {
  test("an override is only reported when the user may see it", () => {
    const hidden = setting({
      override: { group_id: "g1", enforced: true, visible: false },
    });
    const shown = setting({
      override: { group_id: "g1", enforced: true, visible: true },
    });

    expect(visibleOverride(hidden)).toBeUndefined();
    expect(visibleOverride(shown)?.group_id).toBe("g1");

    // Enforcement still holds the control down, visible or not.
    expect(isEnforced(hidden)).toBe(true);
    expect(settingStatus(hidden).overridden).toBe(false);
    expect(settingStatus(hidden).enforced).toBe(true);
  });

  test("describeOverride names the group and what it replaced", () => {
    const text = describeOverride({
      group_id: "beta",
      enforced: true,
      visible: true,
      replaced_value: 5,
    });

    expect(text).toContain("enforced by group beta");
    expect(text).toContain("replacing 5");
  });

  test("sourceLabel and sourceForLayer agree on the layers", () => {
    expect(sourceLabel("INTERMEDIATE")).toBe("Group");
    expect(sourceForLayer("group")).toBe("INTERMEDIATE");
    expect(sourceForLayer("personal")).toBe("PERSONAL");
    expect(sourceForLayer("server")).toBe("SERVER");
  });
});

describe("control values", () => {
  test("an unset setting starts from a type-appropriate empty", () => {
    expect(controlValue(setting({ type: "BOOLEAN", source: "UNSET" }))).toBe(false);
    expect(controlValue(setting({ type: "STRING", source: "UNSET" }))).toBe("");
    expect(
      controlValue(setting({ type: "NUMBER", source: "UNSET", type_config: { min: 3 } })),
    ).toBe(3);
    expect(
      controlValue(
        setting({ type: "SELECT", source: "UNSET", type_config: { multiple: true } }),
      ),
    ).toEqual([]);
  });

  test("options carry a string token for values that are not strings", () => {
    const tier = setting({
      type: "SELECT",
      type_config: { options: [["Off", false], ["On", true]] },
    });

    const options = selectOptions(tier);
    expect(options.map((option) => option.token)).toEqual(["false", "true"]);
    expect(optionFromToken(tier, "true")?.value).toBe(true);
    expect(optionToken("plain")).toBe("plain");
    expect(isMultiSelect(tier)).toBe(false);
  });

  test("numberStep follows the integer flag", () => {
    expect(numberStep({ integer: true })).toBe(1);
    expect(numberStep({})).toBe("any");
  });

  test("asArray takes either shape", () => {
    expect(asArray(["a"])).toEqual(["a"]);
    expect(asArray("a")).toEqual(["a"]);
    expect(asArray(null)).toEqual([]);
  });
});

describe("parsing and formatting", () => {
  test("an empty number field is not zero", () => {
    expect(parseNumberInput("")).toBeUndefined();
    expect(parseNumberInput("  ")).toBeUndefined();
    expect(parseNumberInput("4.5")).toBe(4.5);
    expect(parseNumberInput("abc")).toBeUndefined();
  });

  test("JSON round-trips and reports its own errors", () => {
    expect(parseJsonInput('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonInput("")).toEqual({ ok: true, value: null });

    const broken = parseJsonInput("{a:1}");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.problem.rule).toBe("json");

    expect(formatJsonInput({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatJsonInput(null)).toBe("");
  });

  test("a DATETIME renders for a datetime-local input in a named zone", () => {
    expect(formatDateTimeInput("2026-01-02T20:04:00Z", "UTC")).toBe("2026-01-02T20:04");
    expect(formatDateTimeInput("2026-01-02T20:04:00Z", "America/New_York")).toBe(
      "2026-01-02T15:04",
    );
    expect(formatDateTimeInput("", "UTC")).toBe("");
  });

  test("formatValue reads for a human", () => {
    expect(formatValue(setting({ type: "BOOLEAN", value: true, source: "SERVER" }))).toBe("On");
    expect(formatValue(setting({ type: "JSON", value: { a: 1 }, source: "SERVER" }))).toBe(
      '{"a":1}',
    );
    expect(formatValue(setting({ source: "UNSET" }))).toBe("—");

    const regions = setting({
      type: "SELECT",
      source: "SERVER",
      value: ["eu", "us"],
      type_config: { options: [["EU", "eu"], ["US", "us"]], multiple: true },
    });
    expect(formatValue(regions)).toBe("EU, US");
  });

  test("valuesEqual compares structurally", () => {
    expect(valuesEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(valuesEqual(1, 1)).toBe(true);
    expect(valuesEqual(null, undefined)).toBe(false);
  });
});

describe("withValue", () => {
  const response = resolution([
    setting({ name: "a", value: 1, source: "SERVER" }),
    setting({ name: "b", value: 2, source: "SERVER" }),
  ]);

  test("replaces one value and leaves the original alone", () => {
    const next = withValue(response, "a", 9, "PERSONAL");

    expect(next.settings[0]?.value).toBe(9);
    expect(next.settings[0]?.source).toBe("PERSONAL");
    expect(next.settings[1]).toBe(response.settings[1]);
    expect(response.settings[0]?.value).toBe(1);
  });

  test("a setting the resolution does not hold is not invented", () => {
    expect(withValue(response, "missing", 1)).toBe(response);
  });
});
