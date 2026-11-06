import { html } from "hono/html"
import type { HtmlEscapedString } from "hono/utils/html"

type Markup = HtmlEscapedString | Promise<HtmlEscapedString>

export function page(title: string, content: Markup): Markup {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} | Demo app</title>
    <link rel="stylesheet" href="/style.css">
    <script src="/passkey.js" defer></script>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      ${content}
    </main>
  </body>
</html>`
}

export function errorMessage(message: string | undefined): Markup | "" {
  return message ? html`<p role="alert" data-testid="error">${message}</p>` : ""
}
