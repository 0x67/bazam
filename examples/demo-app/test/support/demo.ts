import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

// the same variables docker-compose.yml reads for its host ports
export const APP_URL = `http://localhost:${process.env.DEMO_APP_PORT ?? "3300"}`
export const MAILPIT_URL = `http://localhost:${process.env.DEMO_MAILPIT_HTTP_PORT ?? "8325"}`

await waitUntilUp([`${APP_URL}/login`, `${MAILPIT_URL}/readyz`])

export function newEmail(): string {
  return `user-${randomUUID().slice(0, 8)}@example.test`
}

// fetch with a cookie jar, no redirect following, relative to APP_URL
export class Visitor {
  private readonly cookies = new Map<string, string>()

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.cookies.size > 0) {
      headers.set("Cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "))
    }
    const response = await fetch(new URL(path, APP_URL), { ...init, headers, redirect: "manual" })
    for (const line of response.headers.getSetCookie()) this.storeCookie(line)
    return response
  }

  postForm(path: string, fields: Record<string, string>): Promise<Response> {
    return this.request(path, { method: "POST", body: new URLSearchParams(fields) })
  }

  postJson(path: string, body: unknown): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name)
  }

  private storeCookie(line: string): void {
    const [pair = ""] = line.split(";")
    const separator = pair.indexOf("=")
    const name = pair.slice(0, separator)
    const value = pair.slice(separator + 1)
    if (value === "" || /max-age=0/i.test(line)) this.cookies.delete(name)
    else this.cookies.set(name, value)
  }
}

export async function signInByEmail(visitor: Visitor, email: string): Promise<void> {
  await visitor.postForm("/login", { email })
  const response = await visitor.postForm("/login/verify", { email, code: await mailedCode(email) })
  if (response.headers.get("location") !== "/dashboard")
    throw new Error(`sign-in for ${email} failed: ${response.status}`)
}

// the newest sign-in code Mailpit received for the recipient
export async function mailedCode(recipient: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const query = encodeURIComponent(`to:"${recipient}"`)
    const search = await getJson<{ messages: { ID: string }[] }>(
      `${MAILPIT_URL}/api/v1/search?query=${query}`,
    )
    const id = search.messages[0]?.ID
    if (id) {
      const message = await getJson<{ Text: string }>(`${MAILPIT_URL}/api/v1/message/${id}`)
      const code = /\b(\d{6})\b/.exec(message.Text)?.[1]
      if (code) return code
    }
    await sleep(100)
  }
  throw new Error(`no sign-in mail for ${recipient}`)
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return (await response.json()) as T
}

async function waitUntilUp(urls: string[]): Promise<void> {
  const deadline = Date.now() + 30_000
  for (const url of urls) {
    while (
      !(await fetch(url).then(
        (r) => r.ok,
        () => false,
      ))
    ) {
      if (Date.now() > deadline)
        throw new Error(`${url} is not up; start it with docker compose up -d`)
      await sleep(250)
    }
  }
}
