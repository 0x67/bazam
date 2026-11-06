export interface DemoConfig {
  port: number
  // public origin the browser uses; passkeys are bound to its host name
  origin: URL
  smtp: { host: string; port: number }
  testHooks: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv): DemoConfig {
  const port = Number(env.PORT ?? 3000)
  return {
    port,
    origin: new URL(env.DEMO_ORIGIN ?? `http://localhost:${port}`),
    smtp: { host: env.SMTP_HOST ?? "localhost", port: Number(env.SMTP_PORT ?? 1025) },
    testHooks: env.DEMO_TEST_HOOKS === "1",
  }
}

// Fixed demo credentials. They are public on purpose and listed in README.md.
export const DEMO_API_KEY = "demo-api-key"
export const DEMO_BASIC_USER = { username: "demo", password: "demo-password" }
export const DEMO_OAUTH_CLIENT = { id: "demo-client", secret: "demo-client-secret" }
export const DEMO_HMAC_KEY = { id: "demo-partner", secret: "demo-hmac-secret" }
export const DEMO_PIN = "2468"
// RFC 6238 test key "12345678901234567890" in base32; every enrollment uses it when test hooks are on
export const DEMO_TOTP_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
