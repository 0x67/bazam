import { Hono } from "hono"
import { html } from "hono/html"
import type { DemoDeps } from "./deps.ts"
import { formText } from "./form.ts"
import { errorMessage, page } from "./layout.ts"
import { requireSignIn, type SignedIn } from "./session.ts"
import type { User } from "./store.ts"

interface Country {
  region: string
  name: string
  callingCode: string
  trunkPrefix: string // dialed before a national number inside the country, empty where there is none
}

const UNITED_KINGDOM: Country = { region: "GB", name: "United Kingdom", callingCode: "44", trunkPrefix: "0" }
const COUNTRIES: readonly Country[] = [
  UNITED_KINGDOM,
  { region: "ID", name: "Indonesia", callingCode: "62", trunkPrefix: "0" },
  { region: "US", name: "United States", callingCode: "1", trunkPrefix: "" },
]

// the four ways apps lay out a phone field, each with its own form on the page
const PICKERS = ["select", "search", "full", "local"] as const
type Picker = (typeof PICKERS)[number]
type SavedNumbers = Partial<Record<Picker, string>>

const SEPARATORS = /[\s().-]/g

export function phoneRoutes({ store }: DemoDeps): Hono<SignedIn> {
  const app = new Hono<SignedIn>()
  // keyed by the user object, so /test/reset forgets saved numbers along with the account
  const saved = new WeakMap<User, SavedNumbers>()

  app.get("/profile/phone", requireSignIn(store), (c) => c.html(phonePage(saved.get(c.get("user")) ?? {})))

  app.post("/profile/phone/:picker", requireSignIn(store), async (c) => {
    const picker = PICKERS.find((name) => name === c.req.param("picker"))
    if (!picker) return c.notFound()
    const numbers = saved.get(c.get("user")) ?? {}
    const e164 = e164From(picker, await c.req.parseBody())
    if (!e164) return c.html(phonePage(numbers, "That is not a phone number we can read."), 400)
    numbers[picker] = e164
    saved.set(c.get("user"), numbers)
    return c.html(phonePage(numbers))
  })

  return app
}

function e164From(picker: Picker, form: Record<string, unknown>): string | undefined {
  const number = formText(form, "number")
  switch (picker) {
    case "select":
      return withCountry(
        COUNTRIES.find((country) => country.region === formText(form, "country")),
        number,
      )
    case "search":
      return withCountry(countryByCallingCode(formText(form, "country")), number)
    case "full":
      return fullNumber(number)
    case "local":
      return withCountry(UNITED_KINGDOM, number)
  }
}

// the search list submits text such as "🇬🇧 +44", and a person may type just "44"
function countryByCallingCode(text: string): Country | undefined {
  const code = /\+?(\d{1,3})/.exec(text)?.[1]
  return COUNTRIES.find((country) => country.callingCode === code)
}

// takes the national number with or without the trunk prefix
function withCountry(country: Country | undefined, typed: string): string | undefined {
  const digits = typed.replace(SEPARATORS, "")
  if (!country || !/^\d+$/.test(digits)) return undefined
  const { callingCode, trunkPrefix } = country
  const national = trunkPrefix && digits.startsWith(trunkPrefix) ? digits.slice(trunkPrefix.length) : digits
  return e164Of(callingCode + national)
}

function fullNumber(typed: string): string | undefined {
  const compact = typed.replace(SEPARATORS, "")
  return compact.startsWith("+") ? e164Of(compact.slice(1)) : undefined
}

// E.164 allows at most 15 digits after the plus
function e164Of(digits: string): string | undefined {
  return /^\d{8,15}$/.test(digits) ? `+${digits}` : undefined
}

// regional indicator symbols start at U+1F1E6 for A
function flagOf(region: string): string {
  return String.fromCodePoint(...region.split("").map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65))
}

function phonePage(numbers: SavedNumbers, error?: string) {
  return page(
    "Phone number",
    html`
    ${errorMessage(error)}
    <form method="post" action="/profile/phone/select">
      <h2>Country select</h2>
      <label>Country
        <select name="country" data-testid="select-country">
          ${COUNTRIES.map((country) => html`<option value="${country.region}">${country.name} (+${country.callingCode})</option>`)}
        </select>
      </label>
      <label>Number <input type="tel" name="number" required data-testid="select-number"></label>
      <button type="submit" data-testid="select-save">Save</button>
      ${savedNumber(numbers, "select")}
    </form>
    <form method="post" action="/profile/phone/search">
      <h2>Searchable country list</h2>
      <label>Country <input name="country" list="calling-codes" autocomplete="off" required data-testid="search-country"></label>
      <datalist id="calling-codes">
        ${COUNTRIES.map((country) => html`<option value="${flagOf(country.region)} +${country.callingCode}">${country.name}</option>`)}
      </datalist>
      <label>Number <input type="tel" name="number" required data-testid="search-number"></label>
      <button type="submit" data-testid="search-save">Save</button>
      ${savedNumber(numbers, "search")}
    </form>
    <form method="post" action="/profile/phone/full">
      <h2>Full number</h2>
      <label>Number with country code <input type="tel" name="number" required data-testid="full-number"></label>
      <button type="submit" data-testid="full-save">Save</button>
      ${savedNumber(numbers, "full")}
    </form>
    <form method="post" action="/profile/phone/local">
      <h2>Local number</h2>
      <p>Country: <span data-testid="local-country">${UNITED_KINGDOM.name} (+${UNITED_KINGDOM.callingCode})</span></p>
      <label>Number <input type="tel" name="number" required data-testid="local-number"></label>
      <button type="submit" data-testid="local-save">Save</button>
      ${savedNumber(numbers, "local")}
    </form>`,
  )
}

function savedNumber(numbers: SavedNumbers, picker: Picker) {
  const number = numbers[picker]
  return number ? html`<p>Saved: <output data-testid="${picker}-saved">${number}</output></p>` : ""
}
