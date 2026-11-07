import { describe, expect, it } from "vite-plus/test";
import { phoneForm, type PhoneForm } from "../src/env/index.ts";

function formsOf(e164: string, locale: string): Record<PhoneForm, string | undefined> {
  const forms: PhoneForm[] = [
    "e164",
    "countryCode",
    "callingCode",
    "region",
    "countryName",
    "flag",
    "national",
    "domestic",
  ];
  return Object.fromEntries(forms.map((form) => [form, phoneForm(e164, form, locale)])) as Record<
    PhoneForm,
    string | undefined
  >;
}

describe("phoneForm", () => {
  // +44 7700 900xxx is a fictional range that belongs to no one country
  it("formats every form of a UK mobile number", () => {
    expect(formsOf("+447700900123", "en")).toEqual({
      e164: "+447700900123",
      countryCode: "+44",
      callingCode: "44",
      region: "GB",
      countryName: "United Kingdom",
      flag: "\u{1F1EC}\u{1F1E7}",
      national: "7700900123",
      domestic: "07700900123",
    });
  });

  it("names the country in the given locale", () => {
    expect(phoneForm("+447700900123", "countryName", "id-ID")).toBe("Inggris Raya");
  });

  it("adds no trunk prefix for a US number", () => {
    expect(phoneForm("+12025550123", "region", "en")).toBe("US");
    expect(phoneForm("+12025550123", "national", "en")).toBe("2025550123");
    expect(phoneForm("+12025550123", "domestic", "en")).toBe("2025550123");
  });

  it("normalizes a number written with spaces", () => {
    expect(phoneForm("+44 7700 900123", "e164", "en")).toBe("+447700900123");
  });

  it("returns undefined for a value that is not a possible number", () => {
    for (const text of ["+4477009", "07700900123", "ops@example.test", "call +447700900123", ""]) {
      expect(phoneForm(text, "e164", "en")).toBeUndefined();
    }
  });

  it("returns undefined for a number with an extension", () => {
    for (const text of ["+447700900123 x5", "+447700900123;ext=5", "+12025550123 #12"]) {
      expect(phoneForm(text, "domestic", "en")).toBeUndefined();
      expect(phoneForm(text, "e164", "en")).toBeUndefined();
    }
  });
});
