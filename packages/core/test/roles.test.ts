import { describe, expect, it } from "vite-plus/test";
import { bindRoles, RoleRefused, roleBindings, type RolesConfig } from "../src/case/roles.ts";

const roles: RolesConfig = {
  tester: { identities: ["alice", "bob"], default: "alice" },
  admin: { identities: ["ops"] },
};

describe("roleBindings", () => {
  it("takes a request over the default", () => {
    expect(roleBindings(roles, { tester: "bob" }).get("tester")).toBe("bob");
  });

  it("uses the default when nothing is requested", () => {
    expect(roleBindings(roles, {}).get("tester")).toBe("alice");
  });

  it("leaves a role with no request and no default unbound", () => {
    expect(roleBindings(roles, {}).has("admin")).toBe(false);
  });

  it("refuses an unknown role, naming the known ones", () => {
    expect(() => roleBindings(roles, { guest: "alice" })).toThrow(
      new RoleRefused('unknown role "guest"; roles: tester, admin'),
    );
    expect(() => roleBindings({}, { guest: "alice" })).toThrow("roles: none");
  });

  it("refuses an identity the role does not list", () => {
    expect(() => roleBindings(roles, { tester: "ops" })).toThrow(
      new RoleRefused("role tester lists alice, bob, not ops"),
    );
  });
});

describe("bindRoles", () => {
  const bindings = new Map([["tester", "bob"]]);

  it("rewrites as in a step, a request payload, a challenge trigger and a guided observe", () => {
    const value = {
      steps: [
        { open: "https://app.example.test", as: "tester" },
        { request: { method: "GET", url: "/me", as: "tester" } },
        { challenge: { kind: "otp-email", trigger: { tap: { id: "go" }, as: "tester" } } },
        { guided: { do: "look", observe: { expect: { visible: "x" }, as: "tester" } } },
      ],
    };
    expect(bindRoles(value, bindings)).toEqual({
      steps: [
        { open: "https://app.example.test", as: "bob" },
        { request: { method: "GET", url: "/me", as: "bob" } },
        { challenge: { kind: "otp-email", trigger: { tap: { id: "go" }, as: "bob" } } },
        { guided: { do: "look", observe: { expect: { visible: "x" }, as: "bob" } } },
      ],
    });
  });

  it("rewrites an identity placeholder in any string, and leaves an escaped one", () => {
    expect(
      bindRoles(
        {
          fill: {
            value: "${identity.tester.email} and ${identity.tester.phone.national}",
            raw: "$${identity.tester.email}",
          },
        },
        bindings,
      ),
    ).toEqual({
      fill: { value: "${identity.bob.email} and ${identity.bob.phone.national}", raw: "$${identity.tester.email}" },
    });
  });

  it("leaves an unbound role and a key that is not as alone", () => {
    const value = { open: "x", as: "admin", note: "${identity.admin.email}", who: "tester" };
    expect(bindRoles(value, bindings)).toEqual(value);
  });

  it("does not change its input", () => {
    const value = { as: "tester" };
    bindRoles(value, bindings);
    expect(value).toEqual({ as: "tester" });
  });
});
