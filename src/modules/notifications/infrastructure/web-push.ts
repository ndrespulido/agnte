import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from 'node:crypto';

/**
 * Web Push, by hand: RFC 8291 payload encryption and RFC 8292 VAPID (§8.4).
 *
 * ---------------------------------------------------------------------------
 * Read this before changing anything below.
 *
 * This is hand-rolled cryptography, which is a thing this project otherwise
 * avoids on purpose. It is here because a push payload has to be encrypted to a
 * key the browser generated, and the alternative was a dependency. The decision
 * was made deliberately; what follows is what makes it defensible rather than
 * merely brave.
 *
 * Nothing here is invented. Every step is the one the RFC specifies, in the
 * order it specifies, and the test beside this file checks the output *byte for
 * byte against a second, independent implementation* — the `http_ece` package,
 * which is what the ecosystem actually uses — rather than only round-tripping
 * against itself. A round trip proves this file agrees with this file, which is
 * exactly the assurance a misread spec would also give you.
 *
 * So: if you change a constant, an info string, a length or an order here, the
 * test will tell you. If you change the test to match the code, you have thrown
 * away the only thing keeping this honest.
 * ---------------------------------------------------------------------------
 */

/** What the browser hands back from `pushManager.subscribe`. */
export interface PushSubscription {
  readonly endpoint: string;
  /** The user agent's P-256 public key, base64url, uncompressed (65 bytes). */
  readonly p256dh: string;
  /** 16 bytes of shared entropy the user agent generated, base64url. */
  readonly auth: string;
}

export interface VapidKeys {
  /** base64url, uncompressed P-256 point. Also handed to the browser. */
  readonly publicKey: string;
  /** base64url, the 32-byte private scalar. */
  readonly privateKey: string;
  /** `mailto:` or `https:`, so a push service can complain to someone. */
  readonly subject: string;
}

const b64u = (buffer: Buffer): string => buffer.toString('base64url');
const unb64u = (value: string): Buffer => Buffer.from(value, 'base64url');

/** HKDF, in the two halves RFC 5869 names, because the spec cites them apart. */
const extract = (salt: Buffer, ikm: Buffer): Buffer =>
  createHmac('sha256', salt).update(ikm).digest();

function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  // One block is enough for every length this file asks for (32, 16, 12), and
  // a loop for counters nobody reaches would be untested code in the one file
  // that can least afford it.
  if (length > 32) throw new Error('expand: more than one block is not implemented');

  const block = createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.of(1)]))
    .digest();
  return block.subarray(0, length);
}

/** The record size in the header. 4096 is what every implementation sends. */
const RECORD_SIZE = 4096;

/**
 * The content-encryption key and nonce for one message (RFC 8291 §3.4).
 *
 * Two HKDF passes, and the order of the arguments in the first one is the part
 * people get wrong: the *auth secret* is the salt and the ECDH output is the
 * input keying material, not the other way round. The `WebPush: info` context
 * then binds the pair of public keys into the derivation, so a key agreed with
 * one subscription cannot be replayed against another.
 */
function deriveKeys(input: {
  ecdhSecret: Buffer;
  authSecret: Buffer;
  userAgentPublicKey: Buffer;
  serverPublicKey: Buffer;
  salt: Buffer;
}): { key: Buffer; nonce: Buffer } {
  const ikm = expand(
    extract(input.authSecret, input.ecdhSecret),
    Buffer.concat([
      Buffer.from('WebPush: info\0'),
      // Receiver first, then sender. Swapping these produces keys that look
      // perfectly valid and that no browser can decrypt.
      input.userAgentPublicKey,
      input.serverPublicKey,
    ]),
    32,
  );

  const prk = extract(input.salt, ikm);

  return {
    key: expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
    nonce: expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12),
  };
}

export interface EncryptedPayload {
  readonly body: Buffer;
  /** The ephemeral public key, which travels inside `body`'s header. */
  readonly serverPublicKey: Buffer;
}

/**
 * Encrypts one push message (RFC 8291, content encoding `aes128gcm`).
 *
 * `salt` and `serverKeys` are injectable so the test can pin them and compare
 * against a known-good implementation. Left alone they are freshly random per
 * message, which is required: the nonce is derived from the salt, and a reused
 * salt against the same subscription is a reused key/nonce pair under AES-GCM.
 * That is the single worst mistake available here, which is why the default is
 * random and the override exists only for the test.
 */
export function encryptPayload(
  plaintext: Buffer,
  subscription: Pick<PushSubscription, 'p256dh' | 'auth'>,
  options: { salt?: Buffer; serverPrivateKey?: Buffer } = {},
): EncryptedPayload {
  const userAgentPublicKey = unb64u(subscription.p256dh);
  const authSecret = unb64u(subscription.auth);

  const server = createECDH('prime256v1');
  if (options.serverPrivateKey) server.setPrivateKey(options.serverPrivateKey);
  else server.generateKeys();

  const serverPublicKey = server.getPublicKey();
  const salt = options.salt ?? randomBytes(16);

  const { key, nonce } = deriveKeys({
    ecdhSecret: server.computeSecret(userAgentPublicKey),
    authSecret,
    userAgentPublicKey,
    serverPublicKey,
    salt,
  });

  /*
   * The padding delimiter, and it is load-bearing.
   *
   * RFC 8188 ends every record with a byte saying whether it is the last one:
   * 0x02 for the final record, 0x01 otherwise. A message that omits it decrypts
   * to plaintext the receiver then rejects, which reads as "the browser ignored
   * my push" rather than as a bug here.
   */
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.of(2)])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE);

  return {
    // salt(16) | record size(4) | key id length(1) | key id | ciphertext
    body: Buffer.concat([
      salt,
      recordSize,
      Buffer.of(serverPublicKey.length),
      serverPublicKey,
      ciphertext,
    ]),
    serverPublicKey,
  };
}

/**
 * The `Authorization` header a push service requires (RFC 8292).
 *
 * A JWT signed with the application server's key, proving that whoever is
 * pushing to this endpoint is the same party the browser subscribed to. The
 * audience is the *origin* of the endpoint and nothing else — including the
 * path would make the token specific to one subscription, which no push service
 * expects and most reject.
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  now: Date = new Date(),
): string {
  const audience = new URL(endpoint).origin;

  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        // Twelve hours. The spec caps it at twenty-four, and a token minted per
        // message does not need to outlive the message by a day.
        exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60,
        sub: keys.subject,
      }),
    ),
  );

  const signingInput = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: privateKeyObject(keys),
    // Raw r||s, which is what JWS ES256 wants. Node's default is DER, and a DER
    // signature here is accepted by nothing.
    dsaEncoding: 'ieee-p1363',
  });

  return `vapid t=${signingInput}.${b64u(signature)}, k=${keys.publicKey}`;
}

/**
 * The private key as Node wants it.
 *
 * Built through JWK rather than DER because the stored form is a bare 32-byte
 * scalar, and JWK is the one import format that takes the scalar plus the
 * public point without hand-assembling ASN.1.
 */
function privateKeyObject(keys: VapidKeys) {
  const publicKey = unb64u(keys.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error('The VAPID public key must be an uncompressed P-256 point.');
  }

  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64u(publicKey.subarray(1, 33)),
      y: b64u(publicKey.subarray(33, 65)),
    },
  });
}

export interface PushRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/** Everything needed to `fetch` one push message. */
export function buildPushRequest(
  subscription: PushSubscription,
  plaintext: Buffer,
  keys: VapidKeys,
  options: { ttlSeconds?: number; now?: Date } = {},
): PushRequest {
  const { body } = encryptPayload(plaintext, subscription);

  return {
    url: subscription.endpoint,
    headers: {
      authorization: vapidAuthorization(subscription.endpoint, keys, options.now),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      // How long the push service holds it if the device is offline. Four
      // weeks would be wrong for a reminder: a notification for a thing that
      // happened on Tuesday is noise by Friday.
      ttl: String(options.ttlSeconds ?? 12 * 60 * 60),
      urgency: 'normal',
    },
    body,
  };
}

/**
 * A P-256 private scalar as the 32 bytes every consumer of it expects.
 *
 * `createECDH().getPrivateKey()` returns the scalar as a big-endian integer
 * with leading zero bytes stripped, so roughly one key in 250 comes back 31
 * bytes or shorter. JWK (RFC 7518 §6.2.2.1) says `d` is a fixed-length octet
 * string for the curve, and while Node happens to accept a short one, nothing
 * guarantees the next thing to read this key does — a `web-push` library, a
 * different runtime, or a hand-written verifier.
 *
 * The failure that matters is the shape of it: a key generated today works
 * everywhere it is tried, and then one key in 250 does not, months later, in
 * whatever read it next. Padding at the point of generation means the stored
 * form is never the short one.
 *
 * Exported for its test: the short case appears in well under 1% of generated
 * keys, so a test that generated keys and hoped to see one would be a coin
 * flip rather than a regression test.
 */
export function scalar32(raw: Buffer): Buffer {
  if (raw.length === 32) return raw;
  if (raw.length > 32) {
    throw new Error(`A P-256 scalar cannot be ${raw.length} bytes.`);
  }
  return Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
}

/** A fresh VAPID keypair, for the setup script. */
export function generateVapidKeys(subject: string): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64u(ecdh.getPublicKey()),
    privateKey: b64u(scalar32(ecdh.getPrivateKey())),
    subject,
  };
}
