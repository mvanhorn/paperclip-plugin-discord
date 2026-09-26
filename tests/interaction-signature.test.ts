import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Discord interaction signature verification.
//
// The Paperclip host does NOT verify a webhook signature — its own route
// comment says "Signature verification is the plugin's responsibility" — so
// this module is the only thing standing between the interactions webhook and
// an unauthenticated caller who can spell a JSON body.
//
// Every test here signs with a REAL Ed25519 keypair generated in the test, so
// nothing is asserted against a hand-copied fixture that could drift from what
// Discord actually sends.
// ---------------------------------------------------------------------------

import {
  readSignatureHeader,
  verifyDiscordInteractionSignature,
  verifyDiscordWebhookSignature,
  classifyDiscordPublicKey,
  normalizeDiscordPublicKey,
  ED25519_REJECTED_PUBLIC_KEYS,
  INTERACTION_TIMESTAMP_WINDOW_SECONDS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  type DiscordSignatureInput,
} from "../src/interaction-signature.js";

/** A keypair plus the raw 32-byte public key as the 64-char hex Discord publishes. */
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  // SPKI for Ed25519 is a fixed 12-byte header followed by the 32 raw bytes.
  const raw = spki.subarray(spki.length - 32);
  return { privateKey, publicKeyHex: raw.toString("hex") };
}

function sign(privateKey: crypto.KeyObject, timestamp: string, rawBody: string): string {
  return crypto
    .sign(null, Buffer.from(timestamp + rawBody, "utf8"), privateKey)
    .toString("hex");
}

/**
 * A fixed "now", so no test here depends on the wall clock. The signed
 * timestamp is bounded against it, and `TIMESTAMP` sits exactly on it.
 */
const NOW_MS = 1774526400_000;
const TIMESTAMP = "1774526400";
const RAW_BODY = JSON.stringify({ id: "int-1", type: 2, token: "tok" });

/** Verify with the fixed clock, unless a case names its own. */
function verify(input: Partial<DiscordSignatureInput> & Record<string, unknown>): boolean {
  return verifyDiscordInteractionSignature({
    nowMs: NOW_MS,
    ...(input as DiscordSignatureInput),
  });
}

function webhookVerify(delivery: unknown, publicKey: unknown): boolean {
  return verifyDiscordWebhookSignature(
    delivery as Parameters<typeof verifyDiscordWebhookSignature>[0],
    publicKey as string | null,
    NOW_MS,
  );
}

describe("verifyDiscordInteractionSignature — a genuine signature", () => {
  it("verifies a signature Discord's own scheme would produce", () => {
    const { privateKey, publicKeyHex } = keypair();
    expect(
      verify({
        publicKey: publicKeyHex,
        signature: sign(privateKey, TIMESTAMP, RAW_BODY),
        timestamp: TIMESTAMP,
        rawBody: RAW_BODY,
      }),
    ).toBe(true);
  });

  it("accepts an uppercase public key and signature (hex case is not meaningful)", () => {
    const { privateKey, publicKeyHex } = keypair();
    expect(
      verify({
        publicKey: publicKeyHex.toUpperCase(),
        signature: sign(privateKey, TIMESTAMP, RAW_BODY).toUpperCase(),
        timestamp: TIMESTAMP,
        rawBody: RAW_BODY,
      }),
    ).toBe(true);
  });
});

describe("verifyDiscordInteractionSignature — tampering", () => {
  it("fails when the body is changed by one byte", () => {
    const { privateKey, publicKeyHex } = keypair();
    const signature = sign(privateKey, TIMESTAMP, RAW_BODY);
    const tampered = RAW_BODY.replace('"type":2', '"type":3');
    expect(tampered).not.toBe(RAW_BODY);
    expect(
      verify({
        publicKey: publicKeyHex,
        signature,
        timestamp: TIMESTAMP,
        rawBody: tampered,
      }),
    ).toBe(false);
  });

  it("fails when a single character of the body is altered", () => {
    const { privateKey, publicKeyHex } = keypair();
    const signature = sign(privateKey, TIMESTAMP, RAW_BODY);
    const tampered = `${RAW_BODY.slice(0, -2)}X}`;
    expect(
      verify({
        publicKey: publicKeyHex,
        signature,
        timestamp: TIMESTAMP,
        rawBody: tampered,
      }),
    ).toBe(false);
  });

  it("fails when the timestamp is not the one that was signed", () => {
    const { privateKey, publicKeyHex } = keypair();
    expect(
      verify({
        publicKey: publicKeyHex,
        signature: sign(privateKey, TIMESTAMP, RAW_BODY),
        timestamp: "1774526401",
        rawBody: RAW_BODY,
      }),
    ).toBe(false);
  });

  it("fails when the signature comes from a different keypair", () => {
    const configured = keypair();
    const attacker = keypair();
    expect(
      verify({
        publicKey: configured.publicKeyHex,
        signature: sign(attacker.privateKey, TIMESTAMP, RAW_BODY),
        timestamp: TIMESTAMP,
        rawBody: RAW_BODY,
      }),
    ).toBe(false);
  });
});

describe("verifyDiscordInteractionSignature — fails closed and never throws", () => {
  const { privateKey, publicKeyHex } = keypair();
  const goodSignature = sign(privateKey, TIMESTAMP, RAW_BODY);

  const badPublicKeys: Array<[string, unknown]> = [
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "   "],
    ["too short", publicKeyHex.slice(0, 62)],
    ["too long", `${publicKeyHex}ab`],
    ["odd length", publicKeyHex.slice(0, 63)],
    ["non-hex", "z".repeat(64)],
    ["not a string", 12345],
  ];

  for (const [label, publicKey] of badPublicKeys) {
    it(`returns false for a ${label} public key, without throwing`, () => {
      let result: boolean | undefined;
      expect(() => {
        result = verify({
          publicKey: publicKey as string,
          signature: goodSignature,
          timestamp: TIMESTAMP,
          rawBody: RAW_BODY,
        });
      }).not.toThrow();
      expect(result).toBe(false);
    });
  }

  const badSignatures: Array<[string, unknown]> = [
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["too short", goodSignature.slice(0, 126)],
    ["too long", `${goodSignature}ab`],
    ["odd length", goodSignature.slice(0, 127)],
    ["non-hex", "q".repeat(128)],
    ["not a string", {}],
  ];

  for (const [label, signature] of badSignatures) {
    it(`returns false for a ${label} signature, without throwing`, () => {
      let result: boolean | undefined;
      expect(() => {
        result = verify({
          publicKey: publicKeyHex,
          signature: signature as string,
          timestamp: TIMESTAMP,
          rawBody: RAW_BODY,
        });
      }).not.toThrow();
      expect(result).toBe(false);
    });
  }

  it("returns false when the timestamp is missing", () => {
    expect(
      verify({
        publicKey: publicKeyHex,
        signature: goodSignature,
        timestamp: undefined as unknown as string,
        rawBody: RAW_BODY,
      }),
    ).toBe(false);
  });

  it("returns false when the timestamp is empty or whitespace", () => {
    for (const timestamp of ["", "  "]) {
      expect(
        verify({
          publicKey: publicKeyHex,
          signature: goodSignature,
          timestamp,
          rawBody: RAW_BODY,
        }),
      ).toBe(false);
    }
  });

  it("returns false for an empty raw body, even when the signature covers it", () => {
    // An empty body carries no interaction, so verifying one is pointless and a
    // caller that reached here with an empty body is misconfigured, not trusted.
    const signature = sign(privateKey, TIMESTAMP, "");
    expect(
      verify({
        publicKey: publicKeyHex,
        signature,
        timestamp: TIMESTAMP,
        rawBody: "",
      }),
    ).toBe(false);
  });

  it("returns false for a missing raw body", () => {
    expect(
      verify({
        publicKey: publicKeyHex,
        signature: goodSignature,
        timestamp: TIMESTAMP,
        rawBody: undefined as unknown as string,
      }),
    ).toBe(false);
  });
});

describe("readSignatureHeader", () => {
  it("reads a header whatever case the caller sent it in", () => {
    expect(readSignatureHeader({ "x-signature-ed25519": "abc" }, SIGNATURE_HEADER)).toBe("abc");
    expect(readSignatureHeader({ "X-Signature-Ed25519": "abc" }, SIGNATURE_HEADER)).toBe("abc");
    expect(readSignatureHeader({ "X-SIGNATURE-ED25519": "abc" }, SIGNATURE_HEADER)).toBe("abc");
  });

  it("reads a timestamp header case-insensitively too", () => {
    expect(readSignatureHeader({ "X-Signature-Timestamp": "17" }, TIMESTAMP_HEADER)).toBe("17");
  });

  it("takes the first value of an array header", () => {
    expect(readSignatureHeader({ "x-signature-ed25519": ["abc", "def"] }, SIGNATURE_HEADER)).toBe("abc");
  });

  it("returns null for a missing, empty, or empty-array header", () => {
    expect(readSignatureHeader({}, SIGNATURE_HEADER)).toBeNull();
    expect(readSignatureHeader({ "x-signature-ed25519": "" }, SIGNATURE_HEADER)).toBeNull();
    expect(readSignatureHeader({ "x-signature-ed25519": "   " }, SIGNATURE_HEADER)).toBeNull();
    expect(readSignatureHeader({ "x-signature-ed25519": [] }, SIGNATURE_HEADER)).toBeNull();
  });

  it("returns null for null or undefined headers, without throwing", () => {
    expect(readSignatureHeader(undefined, SIGNATURE_HEADER)).toBeNull();
    expect(readSignatureHeader(null as unknown as undefined, SIGNATURE_HEADER)).toBeNull();
  });

  it("trims surrounding whitespace off a header value", () => {
    expect(readSignatureHeader({ "x-signature-ed25519": " abc " }, SIGNATURE_HEADER)).toBe("abc");
  });
});

describe("verifyDiscordWebhookSignature", () => {
  it("verifies a webhook delivery from its headers and raw body", () => {
    const { privateKey, publicKeyHex } = keypair();
    expect(
      webhookVerify(
        {
          headers: {
            "X-Signature-Ed25519": sign(privateKey, TIMESTAMP, RAW_BODY),
            "X-Signature-Timestamp": TIMESTAMP,
          },
          rawBody: RAW_BODY,
        },
        publicKeyHex,
      ),
    ).toBe(true);
  });

  it("reads an array-valued signature header", () => {
    const { privateKey, publicKeyHex } = keypair();
    expect(
      webhookVerify(
        {
          headers: {
            "x-signature-ed25519": [sign(privateKey, TIMESTAMP, RAW_BODY)],
            "x-signature-timestamp": [TIMESTAMP],
          },
          rawBody: RAW_BODY,
        },
        publicKeyHex,
      ),
    ).toBe(true);
  });

  it("fails when either header is absent", () => {
    const { privateKey, publicKeyHex } = keypair();
    const signature = sign(privateKey, TIMESTAMP, RAW_BODY);
    expect(
      webhookVerify({ headers: { "x-signature-ed25519": signature }, rawBody: RAW_BODY }, publicKeyHex),
    ).toBe(false);
    expect(
      webhookVerify({ headers: { "x-signature-timestamp": TIMESTAMP }, rawBody: RAW_BODY }, publicKeyHex),
    ).toBe(false);
    expect(webhookVerify({ headers: {}, rawBody: RAW_BODY }, publicKeyHex)).toBe(false);
  });

  it("fails when no public key is configured", () => {
    const { privateKey, publicKeyHex } = keypair();
    void publicKeyHex;
    const headers = {
      "x-signature-ed25519": sign(privateKey, TIMESTAMP, RAW_BODY),
      "x-signature-timestamp": TIMESTAMP,
    };
    expect(webhookVerify({ headers, rawBody: RAW_BODY }, "")).toBe(false);
    expect(webhookVerify({ headers, rawBody: RAW_BODY }, null)).toBe(false);
    expect(webhookVerify({ headers, rawBody: RAW_BODY }, undefined)).toBe(false);
  });

  it("fails when the raw body is absent, without throwing", () => {
    const { privateKey, publicKeyHex } = keypair();
    const headers = {
      "x-signature-ed25519": sign(privateKey, TIMESTAMP, RAW_BODY),
      "x-signature-timestamp": TIMESTAMP,
    };
    let result: boolean | undefined;
    expect(() => {
      result = webhookVerify(
        { headers, rawBody: undefined as unknown as string },
        publicKeyHex,
      );
    }).not.toThrow();
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Degenerate (low-order) public keys.
//
// Ed25519 accepts every 32-byte string as a point, and OpenSSL loads all 14
// low-order encodings without complaint — measured on node v24.11.0. Under such
// a key the crafted signature `R = identity, S = 0` verifies for many bodies,
// and for the identity key it verifies for EVERY body. So a placeholder,
// truncated-to-zeros, or copy-pasted-wrong key would turn this gate into
// accept-all. The key must be rejected before it is ever used.
// ---------------------------------------------------------------------------

/** The crafted signature: R = the identity point encoding, S = zero. */
const FORGED_SIGNATURE = `${"01".padEnd(64, "0")}${"00".repeat(32)}`;

const IDENTITY_KEY = "01".padEnd(64, "0");
const ALL_ZERO_KEY = "00".repeat(32);

describe("verifyDiscordInteractionSignature — degenerate public keys", () => {
  it("the forgery is real: node itself accepts it under the identity key", () => {
    // Without this assertion the refusals below could pass for the wrong
    // reason. This proves the attack works on raw node/OpenSSL.
    const key = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(IDENTITY_KEY, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    expect(
      crypto.verify(
        null,
        Buffer.from(TIMESTAMP + RAW_BODY, "utf8"),
        key,
        Buffer.from(FORGED_SIGNATURE, "hex"),
      ),
    ).toBe(true);
  });

  it("lists exactly the 14 canonical low-order encodings, lowercased", () => {
    expect(ED25519_REJECTED_PUBLIC_KEYS.size).toBe(14);
    for (const hex of ED25519_REJECTED_PUBLIC_KEYS) {
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(ED25519_REJECTED_PUBLIC_KEYS.has(IDENTITY_KEY)).toBe(true);
    expect(ED25519_REJECTED_PUBLIC_KEYS.has(ALL_ZERO_KEY)).toBe(true);
  });

  for (const hex of [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000080",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000080",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  ]) {
    it(`refuses the crafted signature under the low-order key ${hex.slice(0, 8)}…`, () => {
      // Several bodies: some degenerate keys accept only a fraction of them, so
      // one body could pass by luck rather than by the reject list.
      for (let i = 0; i < 12; i++) {
        const rawBody = JSON.stringify({ id: `int-${i}`, type: 2 });
        expect(
          verify({
            publicKey: hex,
            signature: FORGED_SIGNATURE,
            timestamp: TIMESTAMP,
            rawBody,
          }),
        ).toBe(false);
      }
    });
  }

  it("refuses a low-order key even when the signature is legitimately formed", () => {
    const { privateKey } = keypair();
    expect(
      verify({
        publicKey: IDENTITY_KEY,
        signature: sign(privateKey, TIMESTAMP, RAW_BODY),
        timestamp: TIMESTAMP,
        rawBody: RAW_BODY,
      }),
    ).toBe(false);
  });

  it("refuses a low-order key written in uppercase or padded with whitespace", () => {
    for (const publicKey of [ALL_ZERO_KEY, ` ${IDENTITY_KEY.toUpperCase()} `]) {
      expect(
        verify({
          publicKey,
          signature: FORGED_SIGNATURE,
          timestamp: TIMESTAMP,
          rawBody: RAW_BODY,
        }),
      ).toBe(false);
    }
  });

  it("refuses a low-order key on the webhook path too", () => {
    expect(
      webhookVerify(
        {
          headers: {
            "X-Signature-Ed25519": FORGED_SIGNATURE,
            "X-Signature-Timestamp": TIMESTAMP,
          },
          rawBody: RAW_BODY,
        },
        IDENTITY_KEY,
      ),
    ).toBe(false);
  });
});

describe("classifyDiscordPublicKey", () => {
  it("calls an absent or empty value unset — a gateway-only install needs no key", () => {
    for (const value of [undefined, null, "", "   ", "\t\n"]) {
      expect(classifyDiscordPublicKey(value)).toBe("unset");
      expect(normalizeDiscordPublicKey(value)).toBeNull();
    }
  });

  it("calls a wrong-shaped value malformed", () => {
    const { publicKeyHex } = keypair();
    const malformed: unknown[] = [
      publicKeyHex.slice(0, 62),
      publicKeyHex.slice(0, 63),
      `${publicKeyHex}ab`,
      "z".repeat(64),
      "not-a-key",
      12345,
      {},
      [],
    ];
    for (const value of malformed) {
      expect(classifyDiscordPublicKey(value)).toBe("malformed");
      expect(normalizeDiscordPublicKey(value)).toBeNull();
    }
  });

  it("calls a low-order encoding malformed, not usable", () => {
    for (const hex of ED25519_REJECTED_PUBLIC_KEYS) {
      expect(classifyDiscordPublicKey(hex)).toBe("malformed");
      expect(classifyDiscordPublicKey(hex.toUpperCase())).toBe("malformed");
      expect(normalizeDiscordPublicKey(hex)).toBeNull();
    }
  });

  it("calls a real key usable, and normalizes its case and padding", () => {
    const { publicKeyHex } = keypair();
    expect(classifyDiscordPublicKey(publicKeyHex)).toBe("usable");
    expect(classifyDiscordPublicKey(` ${publicKeyHex.toUpperCase()} `)).toBe("usable");
    expect(normalizeDiscordPublicKey(` ${publicKeyHex.toUpperCase()} `)).toBe(publicKeyHex);
  });
});

// ---------------------------------------------------------------------------
// Replay window.
//
// Discord signs a Unix-seconds timestamp. Without an age bound a captured
// delivery replays forever, and the accept button re-POSTs an approval with
// board authority every time. So the timestamp's age is bounded.
// ---------------------------------------------------------------------------

describe("verifyDiscordInteractionSignature — the signed timestamp is bounded", () => {
  const { privateKey, publicKeyHex } = keypair();

  /** Verify a delivery signed `offsetSeconds` away from the fixed now. */
  function verifyAtOffset(offsetSeconds: number): boolean {
    const timestamp = String(Math.floor(NOW_MS / 1000) + offsetSeconds);
    return verify({
      publicKey: publicKeyHex,
      signature: sign(privateKey, timestamp, RAW_BODY),
      timestamp,
      rawBody: RAW_BODY,
    });
  }

  it("bounds the age at 300 seconds", () => {
    expect(INTERACTION_TIMESTAMP_WINDOW_SECONDS).toBe(300);
  });

  it("accepts a timestamp inside the window, in either direction", () => {
    expect(verifyAtOffset(0)).toBe(true);
    expect(verifyAtOffset(-(INTERACTION_TIMESTAMP_WINDOW_SECONDS - 1))).toBe(true);
    expect(verifyAtOffset(INTERACTION_TIMESTAMP_WINDOW_SECONDS - 1)).toBe(true);
    expect(verifyAtOffset(-INTERACTION_TIMESTAMP_WINDOW_SECONDS)).toBe(true);
    expect(verifyAtOffset(INTERACTION_TIMESTAMP_WINDOW_SECONDS)).toBe(true);
  });

  it("refuses a timestamp just outside the window, in either direction", () => {
    expect(verifyAtOffset(-(INTERACTION_TIMESTAMP_WINDOW_SECONDS + 1))).toBe(false);
    expect(verifyAtOffset(INTERACTION_TIMESTAMP_WINDOW_SECONDS + 1)).toBe(false);
  });

  it("refuses a far-past and a far-future timestamp", () => {
    expect(verifyAtOffset(-86_400)).toBe(false);
    expect(verifyAtOffset(86_400)).toBe(false);
  });

  it("refuses a non-numeric timestamp, even when the signature covers it", () => {
    const nonNumeric = [
      "abc",
      "1774526400.5",
      "1.7745264e9",
      "-1774526400",
      "+1774526400",
      "0x69c2a900",
      " 1774526400",
      "1774526400 ",
      "1_774_526_400",
      "1774526400n",
      "Infinity",
      "NaN",
    ];
    for (const timestamp of nonNumeric) {
      expect(
        verify({
          publicKey: publicKeyHex,
          signature: sign(privateKey, timestamp, RAW_BODY),
          timestamp,
          rawBody: RAW_BODY,
        }),
      ).toBe(false);
    }
  });

  it("refuses a replay of a once-valid delivery after the window passes", () => {
    const timestamp = String(Math.floor(NOW_MS / 1000));
    const signature = sign(privateKey, timestamp, RAW_BODY);
    const captured = { publicKey: publicKeyHex, signature, timestamp, rawBody: RAW_BODY };

    expect(verifyDiscordInteractionSignature({ ...captured, nowMs: NOW_MS })).toBe(true);
    expect(
      verifyDiscordInteractionSignature({
        ...captured,
        nowMs: NOW_MS + (INTERACTION_TIMESTAMP_WINDOW_SECONDS + 1) * 1000,
      }),
    ).toBe(false);
  });

  it("falls back to the real clock when no now is given", () => {
    const fresh = String(Math.floor(Date.now() / 1000));
    expect(
      verifyDiscordInteractionSignature({
        publicKey: publicKeyHex,
        signature: sign(privateKey, fresh, RAW_BODY),
        timestamp: fresh,
        rawBody: RAW_BODY,
      }),
    ).toBe(true);

    // The fixed TIMESTAMP is months old, so with the real clock it is refused.
    expect(
      verifyDiscordInteractionSignature({
        publicKey: publicKeyHex,
        signature: sign(privateKey, TIMESTAMP, RAW_BODY),
        timestamp: TIMESTAMP,
        rawBody: RAW_BODY,
      }),
    ).toBe(false);
  });

  it("falls back to the real clock when the given now is not a finite number", () => {
    for (const nowMs of [NaN, Infinity, "1774526400000" as unknown as number, null as unknown as number]) {
      expect(
        verifyDiscordInteractionSignature({
          publicKey: publicKeyHex,
          signature: sign(privateKey, TIMESTAMP, RAW_BODY),
          timestamp: TIMESTAMP,
          rawBody: RAW_BODY,
          nowMs,
        }),
      ).toBe(false);
    }
  });

  it("bounds the webhook path too", () => {
    const headers = {
      "X-Signature-Ed25519": sign(privateKey, TIMESTAMP, RAW_BODY),
      "X-Signature-Timestamp": TIMESTAMP,
    };
    expect(webhookVerify({ headers, rawBody: RAW_BODY }, publicKeyHex)).toBe(true);
    expect(
      verifyDiscordWebhookSignature(
        { headers, rawBody: RAW_BODY },
        publicKeyHex,
        NOW_MS + 600_000,
      ),
    ).toBe(false);
  });
});
