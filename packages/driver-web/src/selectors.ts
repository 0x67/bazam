import type { Selector } from "@bazam/core/case";
import type { Locator, Page } from "playwright";

type AriaRole = Parameters<Page["getByRole"]>[0];

export function locate(page: Page, selector: Selector, idAttribute: string): Locator {
  // getByTestId reads one process-wide attribute, so two targets with different attributes would race over it
  if ("id" in selector) return page.locator(`[${idAttribute}="${cssString(selector.id)}"]`);
  if ("role" in selector) {
    // an unknown role matches nothing, which the step then reports
    const role = selector.role as AriaRole;
    return selector.name === undefined
      ? page.getByRole(role)
      : page.getByRole(role, { name: selector.name });
  }
  if ("text" in selector) return page.getByText(selector.text);
  return page.locator(selector.css);
}

/** The selector as an author reads it, for check names. */
export function describeSelector(selector: Selector): string {
  if ("id" in selector) return `id=${selector.id}`;
  if ("role" in selector)
    return selector.name === undefined
      ? `role=${selector.role}`
      : `role=${selector.role}[name="${selector.name}"]`;
  if ("text" in selector) return `text="${selector.text}"`;
  return `css=${selector.css}`;
}

/** The text escaped for a double-quoted CSS string. */
function cssString(text: string): string {
  return text
    .replace(/["\\]/g, "\\$&")
    .replace(/[\n\r\f]/g, (end) => `\\${end.charCodeAt(0).toString(16)} `);
}
