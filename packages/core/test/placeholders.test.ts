import { describe, expect, it } from "vite-plus/test";
import { escapePlaceholders, findPlaceholders, resolvePlaceholders, UnresolvedPlaceholder, type PlaceholderSources } from "../src/env/index.ts";

function sources(overrides: Partial<PlaceholderSources> = {}): PlaceholderSources {
  const vars: Record<string, string> = { API_URL: "https://api.uat.example.test" };
  const secrets: Record<string, string> = { PARTNER_KEY_ID: "fake-key-id-0001" };
  const identities: Record<string, Record<string, string>> = {
    customer: { email: "admin-1@example.test", phone: "+447700900123" },
  };
  const run: Record<string, string> = { id: "20261106-101530-a1b2", "random(1, 9, 2)": "4.37" };
  const saved: Record<string, string> = { orderId: "ord-17" };
  return {
    env: (key) => vars[key],
    secret: async (key) => secrets[key],
    identity: (name, field) => identities[name]?.[field],
    run: (expression) => run[expression],
    case: (key) => saved[key],
    locale: "en",
    ...overrides,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("resolvePlaceholders", () => {
  it("resolves each namespace", async () => {
    const step = {
      request: {
        method: "POST",
        url: "${env.API_URL}/orders/${case.orderId}",
        headers: { "X-Key-Id": "${secret.PARTNER_KEY_ID}" },
        json: { email: "${identity.customer.email}", amount: "${run.random(1, 9, 2)}", note: "run ${run.id}" },
      },
    };

    expect(await resolvePlaceholders(step, sources())).toEqual({
      request: {
        method: "POST",
        url: "https://api.uat.example.test/orders/ord-17",
        headers: { "X-Key-Id": "fake-key-id-0001" },
        json: { email: "admin-1@example.test", amount: "4.37", note: "run 20261106-101530-a1b2" },
      },
    });
  });

  it("keeps $${ literal", async () => {
    expect(await resolvePlaceholders("$${env.API_URL} and $$${env.API_URL}", sources())).toBe(
      "${env.API_URL} and $${env.API_URL}",
    );
  });

  it("throws UnresolvedPlaceholder naming the placeholder", async () => {
    const error = await rejectionOf(resolvePlaceholders({ steps: ["${env.APP_URL}/login"] }, sources()));

    expect(error).toBeInstanceOf(UnresolvedPlaceholder);
    expect((error as UnresolvedPlaceholder).placeholder).toBe("${env.APP_URL}");
    expect((error as UnresolvedPlaceholder).message).toContain("${env.APP_URL}");
  });

  it("throws for an unknown namespace, a missing path and an identity without a field", async () => {
    for (const text of ["${param.email}", "${env}", "${env.}", "${identity.customer}", "${}"]) {
      const error = await rejectionOf(resolvePlaceholders(text, sources()));
      expect((error as UnresolvedPlaceholder).placeholder).toBe(text);
    }
  });

  it("throws when a source hands back an inherited member instead of a string", async () => {
    const vars: Record<string, string> = {};
    const error = await rejectionOf(resolvePlaceholders("${env.constructor}", sources({ env: (key) => vars[key] })));

    expect(error).toBeInstanceOf(UnresolvedPlaceholder);
  });

  it("resolves a phone form from an identity field", async () => {
    expect(await resolvePlaceholders("${identity.customer.phone.domestic}", sources())).toBe("07700900123");
    expect(await resolvePlaceholders("${identity.customer.phone.countryName}", sources({ locale: "id-ID" }))).toBe("Inggris Raya");
  });

  it("composes several phone forms in one string", async () => {
    const picker = "${identity.customer.phone.countryName} (${identity.customer.phone.countryCode})";

    expect(await resolvePlaceholders(picker, sources())).toBe("United Kingdom (+44)");
  });

  it("prefers a literal field over a phone form", async () => {
    const fields: Record<string, string> = { phone: "+447700900123", "phone.national": "07700 900123" };
    const literal = sources({ identity: (_, field) => fields[field] });

    expect(await resolvePlaceholders("${identity.customer.phone.national}", literal)).toBe("07700 900123");
  });

  it("throws UnresolvedPlaceholder for an unknown phone form", async () => {
    const error = await rejectionOf(resolvePlaceholders("${identity.customer.phone.areaCode}", sources()));

    expect((error as UnresolvedPlaceholder).placeholder).toBe("${identity.customer.phone.areaCode}");
  });

  it("throws UnresolvedPlaceholder for a phone form of a field that holds no possible number", async () => {
    for (const text of ["${identity.customer.email.national}", "${identity.customer.fax.national}"]) {
      const error = await rejectionOf(resolvePlaceholders(text, sources()));
      expect((error as UnresolvedPlaceholder).placeholder).toBe(text);
    }
  });

  it("leaves numbers, booleans, null and keys alone and does not scan resolved text again", async () => {
    const secret = sources({ secret: async () => "pa${env.API_URL}ss" });

    expect(await resolvePlaceholders({ "${env.API_URL}": [1, true, null, "${secret.X}"] }, secret)).toEqual({
      "${env.API_URL}": [1, true, null, "pa${env.API_URL}ss"],
    });
  });

  it("asks the sources one placeholder at a time in document order", async () => {
    const asked: string[] = [];
    const recording = sources({
      run: (expression) => {
        asked.push(expression);
        return "1";
      },
      secret: async (key) => {
        await Promise.resolve();
        asked.push(key);
        return "fake-secret";
      },
    });

    await resolvePlaceholders({ a: "${run.a}", b: ["${secret.B}", "${run.c} ${run.d}"] }, recording);

    expect(asked).toEqual(["a", "B", "c", "d"]);
  });
});

describe("findPlaceholders", () => {
  it("lists each unescaped placeholder once, in order of appearance", () => {
    const steps = [
      { request: { url: "${env.API_URL}/orders", json: { id: "${case.orderId}", raw: "$${env.SKIPPED}" } } },
      { note: "${env.API_URL} again, then ${secret.TOKEN}" },
    ];

    expect(findPlaceholders(steps)).toEqual(["${env.API_URL}", "${case.orderId}", "${secret.TOKEN}"]);
  });
});

describe("escapePlaceholders", () => {
  it("gives text that resolves back to itself, placeholders and escapes included", async () => {
    const answer = "${secret.PARTNER_KEY_ID} and $${env.API_URL}";

    expect(await resolvePlaceholders(escapePlaceholders(answer), sources())).toBe(answer);
  });
});
