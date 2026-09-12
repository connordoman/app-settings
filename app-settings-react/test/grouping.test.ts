import { describe, expect, test } from "bun:test";

import {
  groupSettings,
  settingLabel,
  shortName,
} from "@/registry/app-settings/lib/app-settings/grouping";
import { setting } from "./fixtures";

const settings = [
  setting({ name: "billing.currency" }),
  setting({ name: "signups.enabled" }),
  setting({ name: "billing.tax_rate" }),
  setting({ name: "maintenance" }),
];

describe("groupSettings", () => {
  test("without a grouper everything lands in one section", () => {
    const groups = groupSettings(settings);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("General");
    expect(groups[0]?.settings).toHaveLength(4);
  });

  test("prefix reads a dotted name and keeps the server's order within a section", () => {
    const groups = groupSettings(settings, { by: "prefix" });

    expect(groups.map((group) => group.key)).toEqual(["billing", "signups", "__general__"]);
    expect(groups[0]?.settings.map((one) => one.name)).toEqual([
      "billing.currency",
      "billing.tax_rate",
    ]);
    expect(groups[0]?.title).toBe("Billing");
  });

  test("order puts the named sections first and leaves the rest behind them", () => {
    const groups = groupSettings(settings, { by: "prefix", order: ["signups"] });

    expect(groups[0]?.key).toBe("signups");
  });

  test("titles override a heading", () => {
    const groups = groupSettings(settings, {
      by: "prefix",
      titles: { billing: "Billing & tax" },
    });

    expect(groups[0]?.title).toBe("Billing & tax");
  });

  test("a function groups by anything", () => {
    const groups = groupSettings(settings, { by: (one) => one.platform });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("web");
  });
});

describe("labels", () => {
  test("a label is built from the last segment of a name", () => {
    expect(shortName(setting({ name: "billing.tax_rate" }))).toBe("tax_rate");
    expect(settingLabel(setting({ name: "billing.tax_rate" }))).toBe("Tax Rate");
    expect(settingLabel(setting({ name: "maxRetries" }))).toBe("Max Retries");
  });
});
