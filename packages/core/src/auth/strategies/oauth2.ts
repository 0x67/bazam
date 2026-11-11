import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { defineAuthStrategy, type AuthContext } from "../strategy.ts";
import { applyHeader } from "./api-key.ts";
import { basicAuthorization } from "./basic.ts";
import { loginPrompt, PERSON_LOGIN_TIMEOUT_MS } from "./session-cookie.ts";

const Client = {
  tokenUrl: z.url(),
  clientId: z.string().min(1),
  /** Left out for a public client, which names itself in the token request instead. */
  clientSecret: z.string().min(1).optional(),
  /** How the secret reaches the token endpoint: HTTP Basic (client_secret_basic) or form fields (client_secret_post). */
  clientAuth: z.enum(["basic", "post"]).default("basic"),
  scope: z.string().min(1).optional(),
};

const ClientCredentials = z.strictObject({
  grant: z.literal("client-credentials"),
  ...Client,
  clientSecret: z.string().min(1),
});
type ClientCredentials = z.infer<typeof ClientCredentials>;

const AuthorizationCode = z.strictObject({
  grant: z.literal("authorization-code"),
  ...Client,
  authorizeUrl: z.url(),
  /** The browser login stops when the page reaches it. */
  redirectUri: z.url(),
  timeoutMs: z.number().int().positive().default(PERSON_LOGIN_TIMEOUT_MS),
});
type AuthorizationCode = z.infer<typeof AuthorizationCode>;

const OAuth2Config = z.discriminatedUnion("grant", [
  ClientCredentials,
  z.strictObject({ grant: z.literal("refresh-token"), ...Client, refreshToken: z.string().min(1) }),
  AuthorizationCode,
]);
type OAuth2Config = z.infer<typeof OAuth2Config>;

type Token = {
  accessToken: string;
  refreshToken?: string;
  /** Left out when the token endpoint gives no expires_in. */
  expiresAt?: string;
};

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive().optional(),
});

const OAuthError = z.object({ error: z.string() });

export const oauth2Strategy = defineAuthStrategy<OAuth2Config, Token>({
  name: "oauth2",
  config: OAuth2Config,
  cacheable: true,
  needsPerson: (settings) => settings["grant"] === "authorization-code",
  canRefresh: (token, settings) =>
    token.refreshToken !== undefined || settings["grant"] === "client-credentials",
  acquire: async (config, ctx) => {
    switch (config.grant) {
      case "client-credentials":
        return clientCredentials(config, ctx);
      case "refresh-token":
        return requestToken(
          config,
          { grant_type: "refresh_token", refresh_token: config.refreshToken },
          ctx,
          config.refreshToken,
        );
      case "authorization-code":
        return authorizationCode(config, ctx);
    }
  },
  refresh: async (token, config, ctx) => {
    if (token.refreshToken !== undefined) {
      try {
        return await requestToken(
          config,
          { grant_type: "refresh_token", refresh_token: token.refreshToken },
          ctx,
          token.refreshToken,
        );
      } catch (error) {
        // a refused refresh token, such as one a restarted server forgot, gives way to the grant below
        if (config.grant !== "client-credentials") throw error;
      }
    }
    // a client credentials token often comes without a refresh token, and its grant needs no person
    if (config.grant === "client-credentials") return clientCredentials(config, ctx);
    throw new Error(`the oauth2 token of ${ctx.identity} has no refresh token`);
  },
  expiresAt: (token) => (token.expiresAt === undefined ? undefined : new Date(token.expiresAt)),
  apply: (token, target) => applyHeader(target, "authorization", `Bearer ${token.accessToken}`),
  secrets: (token) =>
    token.refreshToken === undefined
      ? [token.accessToken]
      : [token.accessToken, token.refreshToken],
});

function clientCredentials(config: ClientCredentials, ctx: AuthContext): Promise<Token> {
  const grant: Record<string, string> = { grant_type: "client_credentials" };
  if (config.scope !== undefined) grant["scope"] = config.scope;
  return requestToken(config, grant, ctx);
}

/** Lets the person log in through the browser, then redeems the code with the PKCE verifier. */
async function authorizationCode(config: AuthorizationCode, ctx: AuthContext): Promise<Token> {
  if (ctx.browser === undefined)
    throw new Error(`the oauth2 login of ${ctx.identity} needs a driver that offers browser.login`);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  if (config.scope !== undefined) url.searchParams.set("scope", config.scope);
  const { finalUrl } = await ctx.browser.login({
    url,
    until: { urlMatches: `${config.redirectUri}*` },
    prompt: loginPrompt(
      "oauth2",
      ctx.identity,
      { steps: [`Log in as ${ctx.identity} and allow access.`] },
      config.timeoutMs,
    ),
    timeoutMs: config.timeoutMs,
  });
  const code = codeFromRedirect(finalUrl, new URL(config.redirectUri), state);
  return requestToken(
    config,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    },
    ctx,
  );
}

function formEncoded(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function codeFromRedirect(finalUrl: URL, redirectUri: URL, state: string): string {
  if (finalUrl.origin !== redirectUri.origin || finalUrl.pathname !== redirectUri.pathname) {
    throw new Error(
      `the login ended at ${finalUrl.origin}${finalUrl.pathname}, not at the redirect URI`,
    );
  }
  const error = finalUrl.searchParams.get("error");
  if (error !== null) throw new Error(`the authorization server answered ${error}`);
  if (finalUrl.searchParams.get("state") !== state)
    throw new Error(
      "the state in the redirect differs from the one the login sent, so its code is refused",
    );
  const code = finalUrl.searchParams.get("code");
  if (code === null) throw new Error("the redirect carries no code");
  return code;
}

/** Posts the grant to the token endpoint; a response without a refresh token keeps `refreshToken`. */
async function requestToken(
  config: OAuth2Config,
  grant: Record<string, string>,
  ctx: AuthContext,
  refreshToken?: string,
): Promise<Token> {
  const form = new URLSearchParams(grant);
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  });
  if (config.clientSecret === undefined) {
    form.set("client_id", config.clientId);
  } else if (config.clientAuth === "post") {
    form.set("client_id", config.clientId);
    form.set("client_secret", config.clientSecret);
  } else {
    // RFC 6749 2.3.1 form-encodes both before Basic joins them
    headers.set(
      "authorization",
      basicAuthorization(formEncoded(config.clientId), formEncoded(config.clientSecret)),
    );
  }
  const body = new TextEncoder().encode(form.toString());
  const response = await ctx.http.send({
    method: "POST",
    url: new URL(config.tokenUrl),
    headers,
    body,
  });
  const parsed = TokenResponse.safeParse(response.body);
  if (response.status < 200 || response.status >= 300 || !parsed.success) {
    // only the OAuth error code: the rest of the body may echo what was sent
    const error = OAuthError.safeParse(response.body);
    throw new Error(
      `the token endpoint answered ${response.status} to the ${form.get("grant_type")} grant${error.success ? ` (${error.data.error})` : ""} with no usable token`,
    );
  }
  const token: Token = { accessToken: parsed.data.access_token };
  const nextRefreshToken = parsed.data.refresh_token ?? refreshToken;
  if (nextRefreshToken !== undefined) token.refreshToken = nextRefreshToken;
  if (parsed.data.expires_in !== undefined)
    token.expiresAt = new Date(ctx.now().getTime() + parsed.data.expires_in * 1000).toISOString();
  return token;
}
