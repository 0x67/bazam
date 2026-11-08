import * as playwright from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { locate } from "../src/selectors.ts";
import { ENGINES } from "./support/site.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// each page has both attributes, so a lookup by the other page's attribute finds the other element
const PAGE = `
<p data-qa="total">qa total</p>
<p data-test="total">test total</p>
<div id="host"></div>
<script>
  document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = '<p data-qa="inside">in the shadow root</p>';
</script>
`;

describe.each(ENGINES)("locate on %s", (engine) => {
  let browser: playwright.Browser;

  beforeAll(async () => {
    browser = await playwright[engine].launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  async function page(): Promise<playwright.Page> {
    const opened = await browser.newPage();
    await opened.setContent(PAGE);
    return opened;
  }

  it("finds { id } by each page's own attribute on two pages at once", async () => {
    const [first, second] = await Promise.all([page(), page()]);
    const texts = await Promise.all([
      locate(first, { id: "total" }, "data-qa").textContent(),
      locate(second, { id: "total" }, "data-test").textContent(),
      locate(first, { id: "inside" }, "data-qa").textContent(),
    ]);
    expect(texts).toEqual(["qa total", "test total", "in the shadow root"]);
  });

  it("finds an { id } that holds quotes, a backslash and a line break", async () => {
    const id = 'say "hi" \\ to\nthem';
    const opened = await page();
    await opened.evaluate((value) => document.querySelector("[data-test=total]")?.setAttribute("data-test", value), id);
    expect(await locate(opened, { id }, "data-test").textContent()).toBe("test total");
  });
});
