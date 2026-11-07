import type { Selector } from "@bazam/core/case";
import { selectors, type Locator, type Page } from "playwright";

type AriaRole = Parameters<Page["getByRole"]>[0];

// Playwright reads the test id attribute from one process-wide setting when getByTestId builds its selector
let testIdAttribute = "data-testid";

export function locate(page: Page, selector: Selector, idAttribute: string): Locator {
  if ("id" in selector) {
    if (idAttribute !== testIdAttribute) {
      selectors.setTestIdAttribute(idAttribute);
      testIdAttribute = idAttribute;
    }
    return page.getByTestId(selector.id);
  }
  if ("role" in selector) {
    // an unknown role matches nothing, which the step then reports
    const role = selector.role as AriaRole;
    return selector.name === undefined ? page.getByRole(role) : page.getByRole(role, { name: selector.name });
  }
  if ("text" in selector) return page.getByText(selector.text);
  return page.locator(selector.css);
}

/** The selector as an author reads it, for check names. */
export function describeSelector(selector: Selector): string {
  if ("id" in selector) return `id=${selector.id}`;
  if ("role" in selector)
    return selector.name === undefined ? `role=${selector.role}` : `role=${selector.role}[name="${selector.name}"]`;
  if ("text" in selector) return `text="${selector.text}"`;
  return `css=${selector.css}`;
}
