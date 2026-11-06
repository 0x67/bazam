import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { basicStrategy } from "../../src/auth/strategies/index.ts";
import { FakeBrowserSession } from "../support/fake-browser.ts";
import { authContext, draft, redacted, sendWith, serve, type LocalServer } from "./support.ts";

const SETTINGS = { user: "fake-user", password: "fake-password" };

describe("basicStrategy", () => {
  let server: LocalServer;

  beforeAll(async () => {
    server = await serve((request, response) => {
      const [scheme, encoded = ""] = (request.headers.authorization ?? "").split(" ");
      const pair = Buffer.from(encoded, "base64").toString("utf8");
      response.writeHead(scheme === "Basic" && pair === "fake-user:fake-password" ? 200 : 401).end();
    });
  });

  afterAll(() => server.close());

  it("sends user and password in a Basic header the server accepts", async () => {
    const { response } = await sendWith(basicStrategy, SETTINGS, draft("GET", `${server.origin}/api/basic/whoami`), authContext());

    expect(response.status).toBe(200);
  });

  it("sets the Authorization header on a browser session", async () => {
    const session = new FakeBrowserSession();

    await basicStrategy.apply({ user: "fake-user", password: "fake-password" }, { kind: "browser", session }, SETTINGS);

    expect(session.extraHeaders).toEqual({ authorization: `Basic ${Buffer.from("fake-user:fake-password").toString("base64")}` });
  });

  it("the redactor masks the Authorization header and the password in the credential", async () => {
    const request = draft("GET", `${server.origin}/api/basic/whoami`);

    const { credential } = await sendWith(basicStrategy, SETTINGS, request, authContext());
    const secrets = basicStrategy.secrets(credential);

    expect(redacted(secrets, `Authorization: ${request.headers.get("authorization")}`)).toBe("Authorization: Basic [redacted]");
    expect(redacted(secrets, JSON.stringify(credential))).toBe('{"user":"fake-user","password":"[redacted]"}');
  });
});
