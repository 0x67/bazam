// Passkey buttons on /login and /account/passkey. The server speaks the WebAuthn JSON
// shapes used by @simplewebauthn/server; this file converts them to and from the
// binary fields navigator.credentials expects.

const fromBase64url = (text) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0))

const toBase64url = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`)

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = await response.json()
  if (!response.ok) throw new Error(json.error ?? `${url} answered ${response.status}`)
  return json
}

const withIds = (descriptors = []) => descriptors.map((descriptor) => ({ ...descriptor, id: fromBase64url(descriptor.id) }))

async function registerPasskey() {
  const options = await postJson("/account/passkey/options", {})
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromBase64url(options.challenge),
      user: { ...options.user, id: fromBase64url(options.user.id) },
      excludeCredentials: withIds(options.excludeCredentials),
    },
  })
  await postJson("/account/passkey", {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64url(credential.response.clientDataJSON),
      attestationObject: toBase64url(credential.response.attestationObject),
      transports: credential.response.getTransports?.() ?? [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  })
  location.reload()
}

async function signInWithPasskey() {
  const email = byTestId("email")?.value ?? ""
  const options = await postJson("/login/passkey/options", { email })
  const credential = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: fromBase64url(options.challenge),
      allowCredentials: withIds(options.allowCredentials),
    },
  })
  const result = await postJson("/login/passkey", {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64url(credential.response.clientDataJSON),
      authenticatorData: toBase64url(credential.response.authenticatorData),
      signature: toBase64url(credential.response.signature),
      ...(credential.response.userHandle && { userHandle: toBase64url(credential.response.userHandle) }),
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  })
  location.assign(result.redirect)
}

function bind(buttonId, action) {
  const button = byTestId(buttonId)
  const status = byTestId("passkey-status")
  button?.addEventListener("click", async () => {
    status.textContent = "Waiting for your passkey..."
    try {
      await action()
    } catch (error) {
      status.textContent = `Passkey failed: ${error.message}`
    }
  })
}

bind("register-passkey", registerPasskey)
bind("sign-in-passkey", signInWithPasskey)
