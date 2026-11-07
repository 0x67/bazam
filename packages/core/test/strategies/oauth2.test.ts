import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { BrowserLogin, BrowserLoginRequest, StorageState } from "../../src/auth/index.ts";
import { oauth2Strategy } from "../../src/auth/strategies/index.ts";
import { authContext, draft, redacted, sendWith, serve, type LocalServer, type ReceivedRequest } from "./support.ts";

const CLIENT_SECRETS = new Map([
  ["fake-client", "fake-client-secret"],
  ["fake-special-client", "fake-secret+a:b"],
]);
const PUBLIC_CLIENT = "fake-public-client";

/** Follows the authorize redirect the way a browser would and stops at the redirect URI, optionally with another state. */
class RedirectLogin implements BrowserLogin {
  readonly requests: BrowserLoginRequest[] = [];
  readonly #state: string | undefined;

  constructor(state?: string) {
    this.#state = state;
  }

  async login(request: BrowserLoginRequest): Promise<{ state: StorageState; finalUrl: URL }> {
    this.requests.push(request);
    const response = await fetch(request.url, { redirect: "manual" });
    const finalUrl = new URL(response.headers.get("location") ?? "");
    if (this.#state !== undefined) finalUrl.searchParams.set("state", this.#state);
    return { state: { cookies: [], origins: [] }, finalUrl };
  }
}

/** Checks client_secret_basic, whose halves are form-decoded after base64 (RFC 6749 2.3.1), or client_secret_post. */
function isConfidentialClient(request: ReceivedRequest, form: URLSearchParams): boolean {
  const authorization = request.headers.authorization;
  if (authorization === undefined)
    return form.has("client_secret") && CLIENT_SECRETS.get(form.get("client_id") ?? "") === form.get("client_secret");
  const pair = Buffer.from(authorization.replace(/^Basic /, ""), "base64").toString("utf8");
  const colon = pair.indexOf(":");
  const formDecoded = (part: string) => new URLSearchParams(`value=${part}`).get("value") ?? "";
  return colon >= 0 && CLIENT_SECRETS.get(formDecoded(pair.slice(0, colon))) === formDecoded(pair.slice(colon + 1));
}

function json(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** An authorization server that checks client authentication, single-use refresh tokens and PKCE. */
function authorizationServer() {
  const accessTokens = new Set<string>();
  const codes = new Map<string, { challenge: string | null; method: string | null; redirectUri: string | null }>();

  const issue = (response: ServerResponse, extra: object = {}) => {
    const accessToken = `fake-access-${accessTokens.size + 1}`;
    accessTokens.add(accessToken);
    json(response, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, ...extra });
  };

  const token = (request: ReceivedRequest, response: ServerResponse) => {
    const form = new URLSearchParams(request.body);
    const confidential = isConfidentialClient(request, form);
    const isPublic =
      request.headers.authorization === undefined &&
      form.get("client_id") === PUBLIC_CLIENT &&
      !form.has("client_secret");
    if (!confidential && !isPublic)
      return json(response, 401, { error: "invalid_client", error_description: "fake-client-secret was wrong" });
    switch (form.get("grant_type")) {
      case "client_credentials":
        return confidential ? issue(response) : json(response, 400, { error: "unauthorized_client" });
      case "refresh_token":
        if (form.get("refresh_token") === "fake-refresh-1") return issue(response, { refresh_token: "fake-refresh-2" });
        // this one is not rotated
        if (form.get("refresh_token") === "fake-refresh-2") return issue(response);
        return json(response, 400, { error: "invalid_grant" });
      case "authorization_code": {
        const grant = codes.get(form.get("code") ?? "");
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        const valid =
          grant?.method === "S256" && grant.challenge === challenge && grant.redirectUri === form.get("redirect_uri");
        codes.delete(form.get("code") ?? "");
        return valid
          ? issue(response, { refresh_token: "fake-refresh-1" })
          : json(response, 400, { error: "invalid_grant" });
      }
      default:
        return json(response, 400, { error: "unsupported_grant_type" });
    }
  };

  return (request: ReceivedRequest, response: ServerResponse) => {
    switch (`${request.method} ${request.url.pathname}`) {
      case "GET /oauth/authorize": {
        const query = request.url.searchParams;
        const code = `fake-code-${codes.size + 1}`;
        codes.set(code, {
          challenge: query.get("code_challenge"),
          method: query.get("code_challenge_method"),
          redirectUri: query.get("redirect_uri"),
        });
        const location = new URL(query.get("redirect_uri") ?? "");
        location.searchParams.set("code", code);
        location.searchParams.set("state", query.get("state") ?? "");
        return response.writeHead(302, { location: location.href }).end();
      }
      case "POST /oauth/token":
        return token(request, response);
      case "GET /api/oauth/whoami": {
        const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
        return response.writeHead(accessTokens.has(bearer) ? 200 : 401).end();
      }
      default:
        return response.writeHead(404).end();
    }
  };
}

describe("oauth2Strategy", () => {
  let server: LocalServer;
  let confidential: { tokenUrl: string; clientId: string; clientSecret: string };
  let authorizationCode: Record<string, string>;
  const whoami = () => draft("GET", `${server.origin}/api/oauth/whoami`);
  const tokenRequests = () =>
    server.received
      .filter((request) => request.url.pathname === "/oauth/token")
      .map((request) => new URLSearchParams(request.body));

  beforeAll(async () => {
    server = await serve(authorizationServer());
    confidential = {
      tokenUrl: `${server.origin}/oauth/token`,
      clientId: "fake-client",
      clientSecret: "fake-client-secret",
    };
    authorizationCode = {
      grant: "authorization-code",
      tokenUrl: `${server.origin}/oauth/token`,
      authorizeUrl: `${server.origin}/oauth/authorize`,
      clientId: PUBLIC_CLIENT,
      redirectUri: `${server.origin}/callback`,
    };
  });

  afterAll(() => server.close());

  it("gets a client credentials token the API accepts and expires it after expires_in", async () => {
    const now = new Date("2026-11-07T09:00:00.000Z");
    const settings = { grant: "client-credentials", ...confidential, scope: "orders" };

    const { credential, response } = await sendWith(
      oauth2Strategy,
      settings,
      whoami(),
      authContext({ now: () => now }),
    );

    expect(response.status).toBe(200);
    expect(oauth2Strategy.expiresAt?.(credential)).toEqual(new Date("2026-11-07T10:00:00.000Z"));
    expect(Object.fromEntries(tokenRequests().at(-1) ?? [])).toEqual({
      grant_type: "client_credentials",
      scope: "orders",
    });
  });

  it("refreshes a client credentials token, which has no refresh token, by running the grant again", async () => {
    const ctx = authContext();
    const config = oauth2Strategy.config.parse({ grant: "client-credentials", ...confidential });
    const first = await oauth2Strategy.acquire(config, ctx);

    const second = await oauth2Strategy.refresh?.(first, config, ctx);

    expect(first.refreshToken).toBeUndefined();
    expect(second?.accessToken).not.toBe(first.accessToken);
    expect(tokenRequests().at(-1)?.get("grant_type")).toBe("client_credentials");
  });

  it("rotates the refresh token and keeps the last one when the server sends none", async () => {
    const ctx = authContext();
    const config = oauth2Strategy.config.parse({
      grant: "refresh-token",
      ...confidential,
      refreshToken: "fake-refresh-1",
    });

    const acquired = await oauth2Strategy.acquire(config, ctx);
    const refreshed = await oauth2Strategy.refresh?.(acquired, config, ctx);

    expect(acquired.refreshToken).toBe("fake-refresh-2");
    expect(refreshed?.refreshToken).toBe("fake-refresh-2");
    expect(
      tokenRequests()
        .slice(-2)
        .map((form) => form.get("refresh_token")),
    ).toEqual(["fake-refresh-1", "fake-refresh-2"]);
  });

  it("logs in through the browser with an S256 challenge and redeems the code with its verifier", async () => {
    const login = new RedirectLogin();

    const { credential, response } = await sendWith(
      oauth2Strategy,
      authorizationCode,
      whoami(),
      authContext({ browser: login }),
    );

    expect(response.status).toBe(200);
    expect(credential.refreshToken).toBe("fake-refresh-1");
    const [request] = login.requests;
    expect(request?.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(request?.until).toEqual({ urlMatches: `${server.origin}/callback*` });
    expect(request?.prompt).toMatchObject({
      ask: "action",
      title: "Log in as customer",
      steps: ["Sign in as customer and allow access."],
    });
    // a public client names itself in the form and sends no Authorization header
    expect(tokenRequests().at(-1)?.get("client_id")).toBe(PUBLIC_CLIENT);
  });

  it("refuses the code when the redirect carries another state than the login sent", async () => {
    const ctx = authContext({ browser: new RedirectLogin("fake-forged-state") });

    await expect(oauth2Strategy.acquire(oauth2Strategy.config.parse(authorizationCode), ctx)).rejects.toThrow(
      "the state in the redirect differs from the one the login sent, so its code is refused",
    );
  });

  it("a refused grant names the status and the OAuth error code, not the rest of the body", async () => {
    const config = oauth2Strategy.config.parse({
      grant: "client-credentials",
      ...confidential,
      clientSecret: "fake-wrong-secret",
    });

    const failure = await oauth2Strategy.acquire(config, authContext()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "the token endpoint answered 401 to the client_credentials grant (invalid_client)",
    );
  });

  it("form-encodes the client id and secret before joining them for HTTP Basic", async () => {
    const settings = {
      grant: "client-credentials",
      ...confidential,
      clientId: "fake-special-client",
      clientSecret: "fake-secret+a:b",
    };

    const { response } = await sendWith(oauth2Strategy, settings, whoami(), authContext());

    expect(response.status).toBe(200);
    expect(server.received.at(-2)?.headers.authorization).toBe(
      `Basic ${Buffer.from("fake-special-client:fake-secret%2Ba%3Ab").toString("base64")}`,
    );
  });

  it("sends the client id and secret as form fields with clientAuth: post", async () => {
    const settings = { grant: "client-credentials", ...confidential, clientAuth: "post" };

    const { response } = await sendWith(oauth2Strategy, settings, whoami(), authContext());

    expect(response.status).toBe(200);
    expect(server.received.at(-2)?.headers.authorization).toBeUndefined();
    expect(Object.fromEntries(tokenRequests().at(-1) ?? [])).toEqual({
      grant_type: "client_credentials",
      client_id: "fake-client",
      client_secret: "fake-client-secret",
    });
  });

  it("can refresh a token that holds a refresh token or comes from client credentials, not an authorization-code token without one", () => {
    expect(
      oauth2Strategy.canRefresh?.(
        { accessToken: "fake-access-1", refreshToken: "fake-refresh-1" },
        { grant: "authorization-code" },
      ),
    ).toBe(true);
    expect(oauth2Strategy.canRefresh?.({ accessToken: "fake-access-1" }, { grant: "client-credentials" })).toBe(true);
    expect(oauth2Strategy.canRefresh?.({ accessToken: "fake-access-1" }, { grant: "authorization-code" })).toBe(false);
  });

  it("needs a person only for the authorization-code grant, reading unresolved settings", () => {
    expect(oauth2Strategy.needsPerson?.({ grant: "authorization-code", clientId: "${secret.CLIENT_ID}" })).toBe(true);
    expect(oauth2Strategy.needsPerson?.({ grant: "client-credentials", clientSecret: "${secret.CLIENT_SECRET}" })).toBe(
      false,
    );
  });

  it("the redactor masks the bearer header and the credential's tokens", async () => {
    const request = whoami();

    const { credential } = await sendWith(
      oauth2Strategy,
      authorizationCode,
      request,
      authContext({ browser: new RedirectLogin() }),
    );
    const secrets = oauth2Strategy.secrets(credential);

    expect(redacted(secrets, `Authorization: ${request.headers.get("authorization")}`)).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redacted(secrets, JSON.stringify(credential))).not.toMatch(/fake-access|fake-refresh/);
  });
});
