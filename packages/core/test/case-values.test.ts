import { describe, expect, it } from "vite-plus/test";
import { CaseValues } from "../src/run/case-values.ts";

describe("CaseValues", () => {
  it("starts with id and title but lists only what is set after", () => {
    const values = new CaseValues("SHOP-001", "Title");
    expect(values.get("id")).toBe("SHOP-001");
    expect(values.get("title")).toBe("Title");
    expect(values.saved()).toEqual({});
  });

  it("keeps the last value of a name set twice, in first-save order", () => {
    const values = new CaseValues("SHOP-001", "Title");
    values.set("b", "1");
    values.set("a", "2");
    values.set("b", "3");
    expect(Object.entries(values.saved())).toEqual([
      ["b", "3"],
      ["a", "2"],
    ]);
  });

  it("keeps a re-saved seeded key at its first-save position", () => {
    const values = new CaseValues("SHOP-001", "Title");
    values.set("order", "1");
    values.set("id", "other");
    expect(Object.keys(values.saved())).toEqual(["order", "id"]);
  });

  it("lists a step that saves id", () => {
    const values = new CaseValues("SHOP-001", "Title");
    values.set("id", "other");
    expect(values.saved()).toEqual({ id: "other" });
  });
});
