import { HostNotAllowed } from "@bazam/core/env";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { httpHookResolver } from "../src/otp-http-hook.ts";
import { builtinKind, challenge, closeServers, context, serveJson, type Reply } from "./support.ts";

const RECIPIENT = "customer@example.test";
const OTP_SMS = builtinKind("otp-sms");

/** Answers GET /test/otp?recipient=<RECIPIENT> with `body`, and 404 for anyone else. */
function fakeHook(body: unknown): (url: URL) => Reply {
  return (url) =>
    url.pathname === "/test/otp" && url.searchParams.get("recipient") === RECIPIENT
      ? { status: 200, body }
      : { status: 404 };
}

async function resolveFrom(origin: string, field: string, recipient = RECIPIENT) {
  const url = `${origin}/test/otp?recipient=${encodeURIComponent(recipient)}`;
  return httpHookResolver.resolve(challenge("otp-sms", { url, field }), context(), OTP_SMS);
}

describe("httpHookResolver", () => {
  afterEach(closeServers);

  it("returns the value at params.field from the hook", async () => {
    const origin = await serveJson(fakeHook({ code: "123456" }));
    expect(await resolveFrom(origin, "code")).toEqual({ kind: "value", value: "123456" });
  });

  it("follows a dot path with array indexes and turns a number into text", async () => {
    const origin = await serveJson(fakeHook({ data: { codes: [{ value: 654321 }] } }));
    expect(await resolveFrom(origin, "data.codes[0].value")).toEqual({ kind: "value", value: "654321" });
  });

  it("returns undefined when the hook answers 404", async () => {
    const origin = await serveJson(fakeHook({ code: "123456" }));
    expect(await resolveFrom(origin, "code", "nobody@example.test")).toBeUndefined();
  });

  it("fails naming the field when the answer holds no value there", async () => {
    const origin = await serveJson(fakeHook({ otp: "123456" }));
    await expect(resolveFrom(origin, "code")).rejects.toThrow("the hook's answer holds no text or number at code");
  });

  it("refuses a hook outside the env hosts", async () => {
    await expect(resolveFrom("http://otp.example.test", "code")).rejects.toBeInstanceOf(HostNotAllowed);
  });
});
