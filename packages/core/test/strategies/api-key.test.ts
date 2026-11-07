import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { apiKeyStrategy } from "../../src/auth/strategies/index.ts";
import { FakeBrowserSession } from "../support/fake-browser.ts";
import { authContext, draft, redacted, sendWith, serve, type LocalServer } from "./support.ts";

const KEY = "fake-api-key";

describe("apiKeyStrategy", () => {
  let server: LocalServer;

  beforeAll(async () => {
    server = await serve((request, response) => {
      const key = request.headers["x-api-key"] ?? request.url.searchParams.get("api_key");
      response.writeHead(key === KEY ? 200 : 401).end();
    });
  });

  afterAll(() => server.close());

  it("sends the key in the configured header", async () => {
    const { response } = await sendWith(apiKeyStrategy, { key: KEY, header: "X-Api-Key" }, draft("GET", `${server.origin}/api/key/whoami`), authContext());

    expect(response.status).toBe(200);
    expect(server.received.at(-1)?.headers["x-api-key"]).toBe(KEY);
  });

  it("sends the key as a query parameter and keeps the other parameters", async () => {
    const request = draft("GET", `${server.origin}/api/key/whoami?page=2`);

    const { response } = await sendWith(apiKeyStrategy, { key: KEY, query: "api_key" }, request, authContext());

    expect(response.status).toBe(200);
    expect(Object.fromEntries(server.received.at(-1)?.url.searchParams ?? [])).toEqual({ page: "2", api_key: KEY });
  });

  it("sets the header on a browser session and refuses a query key there", async () => {
    const session = new FakeBrowserSession();
    const credential = { key: KEY };

    await apiKeyStrategy.apply(credential, { kind: "browser", session }, { key: KEY, header: "X-Api-Key" });

    expect(session.extraHeaders).toEqual({ "X-Api-Key": KEY });
    await expect(apiKeyStrategy.apply(credential, { kind: "browser", session }, { key: KEY, query: "api_key" })).rejects.toThrow(
      "an api key in the query parameter api_key cannot apply to a browser",
    );
  });

  it("the redactor masks the key in the header and in the credential", async () => {
    const request = draft("GET", `${server.origin}/api/key/whoami`);

    const { credential } = await sendWith(apiKeyStrategy, { key: KEY, header: "X-Api-Key" }, request, authContext());
    const secrets = apiKeyStrategy.secrets(credential);

    expect(redacted(secrets, `X-Api-Key: ${request.headers.get("x-api-key")}`)).toBe("X-Api-Key: [redacted]");
    expect(redacted(secrets, JSON.stringify(credential))).toBe('{"key":"[redacted]"}');
  });
});
