import type { StepHandler } from "@bazam/core/driver";
import { definePlugin, PLUGIN_API_VERSION } from "@bazam/core/plugin";
import { pageFor } from "@bazam/driver-web";
import { z } from "zod";

const PageText = z.strictObject({
  /** The data-testid of the element to read. */
  id: z.string().min(1),
  /** The name to save the text under, read back as `${case.<name>}`. */
  save: z.string().min(1),
});

const pageText: StepHandler<z.infer<typeof PageText>> = {
  kind: "page-text",
  schema: PageText,
  // pageFor needs the identity's browser context, which opensBrowser asks the run to open and log in first
  opensBrowser: true,
  async run(written, ctx) {
    // the payload arrives as written, so resolve fills its placeholders before a field is read
    const { id, save } = await ctx.resolve(written);
    const page = await pageFor(ctx);
    const text = await page.getByTestId(id).textContent({ timeout: 10_000 });
    if (text === null) throw new Error(`the element ${id} holds no text`);
    ctx.values.set(save, text.trim());
  },
};

/**
 * Adds the step `page-text`, which reads the text of one element off the page the step's identity is on.
 * List it in `plugins:` as `./plugins/page-step/manifest.ts`; it runs in-process on the playwright driver.
 */
export default definePlugin({
  name: "demo-page-step",
  apiVersion: PLUGIN_API_VERSION,
  steps: [pageText],
});
