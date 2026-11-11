import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"

// A software passkey: ES256 key, "none" attestation, user present and verified.
// It answers the JSON options the demo returns with the JSON a browser would post back.

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>

const FLAG_USER_PRESENT = 0x01
const FLAG_USER_VERIFIED = 0x04
const FLAG_ATTESTED_CREDENTIAL = 0x40

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(16)
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" })
  private readonly origin: string
  private signCount = 0

  constructor(origin: string) {
    this.origin = origin
  }

  register(options: { challenge: string; rp: { id: string } }) {
    const clientDataJSON = this.clientData("webauthn.create", options.challenge)
    const jwk = this.keys.publicKey.export({ format: "jwk" })
    const coseKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    )
    const length = Buffer.alloc(2)
    length.writeUInt16BE(this.credentialId.length)
    const authData = Buffer.concat([
      this.authDataHeader(
        options.rp.id,
        FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_ATTESTED_CREDENTIAL,
      ),
      Buffer.alloc(16), // aaguid
      length,
      this.credentialId,
      coseKey,
    ])
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    )
    return {
      id: this.credentialId.toString("base64url"),
      rawId: this.credentialId.toString("base64url"),
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    }
  }

  assert(options: { challenge: string; rpId: string }) {
    const clientDataJSON = this.clientData("webauthn.get", options.challenge)
    this.signCount += 1
    const authenticatorData = this.authDataHeader(
      options.rpId,
      FLAG_USER_PRESENT | FLAG_USER_VERIFIED,
    )
    const signed = Buffer.concat([
      authenticatorData,
      createHash("sha256").update(clientDataJSON).digest(),
    ])
    return {
      id: this.credentialId.toString("base64url"),
      rawId: this.credentialId.toString("base64url"),
      type: "public-key",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authenticatorData.toString("base64url"),
        signature: sign("sha256", signed, this.keys.privateKey).toString("base64url"),
      },
      clientExtensionResults: {},
    }
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }))
  }

  private authDataHeader(rpId: string, flags: number): Buffer {
    const header = Buffer.alloc(37)
    createHash("sha256").update(rpId).digest().copy(header, 0)
    header.writeUInt8(flags, 32)
    header.writeUInt32BE(this.signCount, 33)
    return header
  }
}

// the CBOR subset WebAuthn attestation needs: integers, text, bytes and maps
function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value)
  if (typeof value === "string")
    return Buffer.concat([cborHead(3, Buffer.byteLength(value)), Buffer.from(value)])
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value])
  return Buffer.concat([
    cborHead(5, value.size),
    ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]),
  ])
}

function cborHead(majorType: number, argument: number): Buffer {
  if (argument < 24) return Buffer.from([(majorType << 5) | argument])
  if (argument < 256) return Buffer.from([(majorType << 5) | 24, argument])
  return Buffer.from([(majorType << 5) | 25, argument >> 8, argument & 0xff])
}
