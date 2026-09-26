/**
 * Discord interaction signature verification, for the webhook delivery path.
 *
 * The Paperclip host does NOT authenticate this route. Its own comment on
 * `POST /api/plugins/:pluginId/webhooks/:endpointKey` says so outright:
 * "Signature verification is the plugin's responsibility." Without the check
 * below, anyone who can reach that URL can post a JSON body naming any
 * `member.user.id` they like, and the author allowlist — which reads exactly
 * that field — believes it.
 *
 * Discord signs the ASCII concatenation `timestamp + rawBody` with Ed25519,
 * using the application's key pair. The application's public key is 32 raw
 * bytes, published as 64 hex characters; the signature is 64 raw bytes, sent as
 * 128 hex characters in `X-Signature-Ed25519`, with the signed timestamp in
 * `X-Signature-Timestamp`.
 *
 * Dependency-free on purpose: `node:crypto` only, no new package.
 *
 * Everything here FAILS CLOSED and never throws. A missing, empty, non-hex, or
 * wrong-length key or signature returns `false`, as does a low-order key and a
 * timestamp outside the replay window. A caller therefore only ever has to
 * handle `true` and `false`, and the fallback for anything it does not
 * understand is refusal.
 */
import crypto from "node:crypto";

/** Discord's signature header. Compared case-insensitively — HTTP header names are. */
export const SIGNATURE_HEADER = "x-signature-ed25519";
/** Discord's signed-timestamp header. */
export const TIMESTAMP_HEADER = "x-signature-timestamp";

/** Raw Ed25519 public key length, in bytes. */
const PUBLIC_KEY_BYTES = 32;
/** Ed25519 signature length, in bytes. */
const SIGNATURE_BYTES = 64;

/**
 * The fixed DER SubjectPublicKeyInfo header for an Ed25519 key. `createPublicKey`
 * takes SPKI, and Discord publishes the 32 raw bytes, so the raw bytes are
 * wrapped in this prefix to make a key object.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const HEX = /^[0-9a-f]+$/;
/** Discord's timestamp is Unix seconds. Digits only: no sign, exponent, or point. */
const UNIX_SECONDS = /^[0-9]+$/;

/**
 * How far from now a signed timestamp may sit, in seconds, in either direction.
 *
 * Discord's own guidance is a few minutes; five is enough for clock skew between
 * Discord and this host and short enough that a captured delivery stops being
 * useful quickly. Without a bound a captured valid delivery replays forever, and
 * a replayed button click re-POSTs an approval with board authority.
 */
export const INTERACTION_TIMESTAMP_WINDOW_SECONDS = 300;

/**
 * The 14 canonical encodings of Ed25519's low-order points: the identity, the
 * order-2 point, the two of order 4, and the four of order 8, each in its
 * canonical form and in the non-canonical form its unused high bit or its
 * `y + p` representation gives.
 *
 * Why they are listed. Ed25519 accepts EVERY 32-byte string as a point, so
 * `createPublicKey` does not throw on any of these — measured on node v24.11.0,
 * all 14 load. Under a low-order key the crafted signature `R = identity, S = 0`
 * verifies for a large share of bodies, and under the identity key it verifies
 * for every body. So a placeholder, a value truncated to zeros, or a mis-pasted
 * key would silently turn this gate into accept-all. A key is compared against
 * this set, as normalized lowercase hex, before it is ever used.
 *
 * Derived, not remembered: the set was computed from the curve's 8-torsion
 * subgroup — every encoding of every point P with 8P = identity, canonical and
 * not — and each member was then confirmed to load in OpenSSL and to accept the
 * crafted signature. The test file asserts the count and the membership.
 */
export const ED25519_REJECTED_PUBLIC_KEYS: ReadonlySet<string> = new Set([
  // Order 4 (y = 0) and its high-bit variant.
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  // The identity, y = 1. Accepts the crafted signature for EVERY body.
  "0100000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000080",
  // Order 8.
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  // Order 2, y = p - 1.
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  // y = p, the non-canonical encoding of y = 0.
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  // y = p + 1, the non-canonical encoding of the identity.
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
]);

/** What a configured `discordPublicKey` value is. */
export type DiscordPublicKeyClassification = "unset" | "malformed" | "usable";

/**
 * Sort a configured public key into unset, malformed, or usable.
 *
 * The three cases mean different things to an operator, which is why they are
 * distinguished: unset is a legitimate gateway-only install, malformed is always
 * a configuration mistake and worth reporting at bootstrap, and only usable may
 * be handed to a verification.
 */
export function classifyDiscordPublicKey(value: unknown): DiscordPublicKeyClassification {
  if (value == null) return "unset";
  if (typeof value !== "string") return "malformed";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "unset";
  const normalized = normalizeHex(trimmed, PUBLIC_KEY_BYTES);
  if (!normalized) return "malformed";
  if (ED25519_REJECTED_PUBLIC_KEYS.has(normalized)) return "malformed";
  return "usable";
}

/**
 * The normalized form of a usable public key, or `null` for an unset or
 * malformed one. A caller that only needs "can I verify with this" uses this.
 */
export function normalizeDiscordPublicKey(value: unknown): string | null {
  if (classifyDiscordPublicKey(value) !== "usable") return null;
  return (value as string).trim().toLowerCase();
}

/**
 * Read one header, whatever case the caller sent its name in.
 *
 * An array value takes its FIRST element: a duplicated signature header is not
 * a signature over a joined string, and joining would produce a value no
 * signer ever signed. The first value is the one a well-behaved caller sent.
 *
 * Returns `null` for a missing, empty, whitespace-only, or empty-array value,
 * and for absent headers. Surrounding whitespace is trimmed.
 */
export function readSignatureHeader(
  headers: Record<string, string | string[]> | null | undefined,
  name: string,
): string | null {
  if (!headers || typeof headers !== "object") return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first !== "string") return null;
    const trimmed = first.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/** A hex string of exactly `bytes` bytes, lowercased — or null if it is not one. */
function normalizeHex(value: unknown, bytes: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length !== bytes * 2) return null;
  if (!HEX.test(normalized)) return null;
  return normalized;
}

export interface DiscordSignatureInput {
  /** The Discord application's public key: 64 hex characters. Public, not a secret. */
  publicKey: string | null | undefined;
  /** The `X-Signature-Ed25519` value: 128 hex characters. */
  signature: string | null | undefined;
  /** The `X-Signature-Timestamp` value, exactly as sent — it is part of the signed data. */
  timestamp: string | null | undefined;
  /** The exact request body bytes, as the UTF-8 string the host hands over. */
  rawBody: string | null | undefined;
  /**
   * The current time in milliseconds, for the replay window. Injected by tests
   * so none of them depends on the wall clock. Anything but a finite number,
   * including an absent value, falls back to `Date.now()`.
   */
  nowMs?: number;
}

/**
 * True only when `signature` is a genuine Ed25519 signature over
 * `timestamp + rawBody` under `publicKey`, and `timestamp` is inside the replay
 * window. False for anything else, including every malformed input, and
 * including a low-order public key. Never throws.
 */
export function verifyDiscordInteractionSignature(input: DiscordSignatureInput): boolean {
  try {
    // A low-order key is refused here, not just normalized: OpenSSL loads every
    // 32-byte value as a point, so without this the crafted `R = identity, S = 0`
    // signature would verify and the gate would fail OPEN.
    const publicKeyHex = normalizeDiscordPublicKey(input?.publicKey);
    if (!publicKeyHex) return false;

    const signatureHex = normalizeHex(input?.signature, SIGNATURE_BYTES);
    if (!signatureHex) return false;

    const timestamp = input?.timestamp;
    // Digits only, and used verbatim below: it is part of the signed data, so it
    // is never trimmed or reformatted between the check and the verification.
    if (typeof timestamp !== "string" || !UNIX_SECONDS.test(timestamp)) return false;
    const signedSeconds = Number(timestamp);
    if (!Number.isSafeInteger(signedSeconds)) return false;
    const nowMs = typeof input?.nowMs === "number" && Number.isFinite(input.nowMs)
      ? input.nowMs
      : Date.now();
    const ageSeconds = Math.abs(nowMs / 1000 - signedSeconds);
    if (ageSeconds > INTERACTION_TIMESTAMP_WINDOW_SECONDS) return false;

    const rawBody = input?.rawBody;
    // An empty body carries no interaction. Refusing it keeps a signed-but-empty
    // delivery from reaching a handler that would have to guess what it meant.
    if (typeof rawBody !== "string" || rawBody.length === 0) return false;

    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });

    return crypto.verify(
      null,
      Buffer.from(timestamp + rawBody, "utf8"),
      key,
      Buffer.from(signatureHex, "hex"),
    );
  } catch {
    // Nothing above is expected to throw: the shape checks run first and the
    // reject set covers the encodings OpenSSL would otherwise load happily.
    // This is the belt on the braces — any surprise from `node:crypto` is a
    // refusal, not a crash.
    return false;
  }
}

/**
 * The same check, taken straight off a host webhook delivery.
 *
 * `delivery` is the `PluginWebhookInput` shape: the inbound headers and the
 * exact raw body. `publicKey` is the configured Discord application public key;
 * unset, malformed, or low-order means nothing can be verified, so this returns
 * `false`. `nowMs` is the replay window's clock; tests pass it, callers do not.
 */
export function verifyDiscordWebhookSignature(
  delivery: { headers?: Record<string, string | string[]>; rawBody?: string } | null | undefined,
  publicKey: string | null | undefined,
  nowMs?: number,
): boolean {
  return verifyDiscordInteractionSignature({
    publicKey,
    signature: readSignatureHeader(delivery?.headers, SIGNATURE_HEADER),
    timestamp: readSignatureHeader(delivery?.headers, TIMESTAMP_HEADER),
    rawBody: delivery?.rawBody,
    nowMs,
  });
}
