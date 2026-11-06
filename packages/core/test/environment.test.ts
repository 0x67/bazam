import { describe, expect, it } from "vitest";
import { CaseSpec, type RequestStep } from "../src/case/index.ts";
import {
  assertHostAllowed,
  assertProdSafe,
  assertProdWrite,
  EnvsConfig,
  HostNotAllowed,
  ProdCaseRefused,
  ProdWriteRefused,
  type Environment,
} from "../src/env/index.ts";

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

const envs = EnvsConfig.parse({
  uat: {
    production: false,
    vars: { APP_URL: "https://uat.app.example.test" },
    hosts: ["UAT.App.Example.Test", "api.uat.example.test"],
    challenges: { "otp-email": ["otp-mailpit", "human"] },
    locale: "id-ID",
  },
  prod: { production: true, hosts: ["app.example.test"] },
});
const uat = envs["uat"]!;
const prod = envs["prod"]!;

function caseSpec(prodSafe: boolean): CaseSpec {
  return CaseSpec.parse({
    id: "OPS-PROD-001",
    title: "Reads the dashboard",
    stage: "regression",
    risk: "low",
    targets: ["web"],
    prod_safe: prodSafe,
  });
}

describe("EnvsConfig", () => {
  it("parses each env under its name with lower case hosts and defaults, locale en among them", () => {
    expect(uat).toEqual<Environment>({
      name: "uat",
      production: false,
      vars: { APP_URL: "https://uat.app.example.test" },
      hosts: new Set(["uat.app.example.test", "api.uat.example.test"]),
      challenges: { "otp-email": ["otp-mailpit", "human"] },
      locale: "id-ID",
    });
    expect(prod).toEqual<Environment>({
      name: "prod",
      production: true,
      vars: {},
      hosts: new Set(["app.example.test"]),
      challenges: {},
      locale: "en",
    });
  });

  it("rejects a locale that is not a BCP 47 tag", () => {
    const result = EnvsConfig.safeParse({ uat: { production: false, hosts: ["uat.app.example.test"], locale: "en_US" } });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["uat", "locale"]]);
  });

  it("rejects a host written as a URL or with a port", () => {
    const result = EnvsConfig.safeParse({
      uat: { production: false, hosts: ["https://uat.app.example.test", "uat.app.example.test:8443"] },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ["uat", "hosts", 0],
      ["uat", "hosts", 1],
    ]);
  });

  it("requires the production flag", () => {
    const result = EnvsConfig.safeParse({ uat: { hosts: ["uat.app.example.test"] } });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["uat", "production"]]);
  });
});

describe("assertHostAllowed", () => {
  it("blocks a host outside the list", () => {
    const error = thrownBy(() => assertHostAllowed(uat, new URL("https://api.example.test/orders")));

    expect(error).toBeInstanceOf(HostNotAllowed);
    expect((error as HostNotAllowed).host).toBe("api.example.test");
    expect((error as HostNotAllowed).message).toContain("api.example.test");
  });

  it("allows a listed host whatever the scheme, port or letter case of the URL", () => {
    expect(() => assertHostAllowed(uat, new URL("https://UAT.app.example.test/login"))).not.toThrow();
    expect(() => assertHostAllowed(uat, new URL("http://api.uat.example.test:8081/orders"))).not.toThrow();
  });

  it("blocks a subdomain of a listed host and a URL without a host", () => {
    expect(() => assertHostAllowed(uat, new URL("https://evil.uat.app.example.test/"))).toThrow(HostNotAllowed);
    expect(() => assertHostAllowed(uat, new URL("file:///etc/hosts"))).toThrow(HostNotAllowed);
  });
});

describe("assertProdSafe", () => {
  it("refuses a production case without prod_safe", () => {
    expect(() => assertProdSafe(prod, caseSpec(false))).toThrow(ProdCaseRefused);
    expect(() => assertProdSafe(prod, caseSpec(true))).not.toThrow();
  });

  it("runs a case without prod_safe outside production", () => {
    expect(() => assertProdSafe(uat, caseSpec(false))).not.toThrow();
  });
});

describe("assertProdWrite", () => {
  it("refuses a non-GET without write", () => {
    const step: RequestStep = { method: "POST", url: "${env.API_URL}/orders" };

    expect(() => assertProdWrite(prod, step.method, step)).toThrow(ProdWriteRefused);
    expect(() => assertProdWrite(prod, "head", {})).toThrow(ProdWriteRefused);
  });

  it("allows GET, a non-GET with write: true, and any method outside production", () => {
    expect(() => assertProdWrite(prod, "get", {})).not.toThrow();
    expect(() => assertProdWrite(prod, "DELETE", { write: true })).not.toThrow();
    expect(() => assertProdWrite(uat, "POST", {})).not.toThrow();
  });
});
