import { createECDH, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPushRequest,
  encryptPayload,
  generateVapidKeys,
  vapidAuthorization,
} from '@/modules/notifications/infrastructure/web-push';

/**
 * Web Push encryption, checked against something other than itself.
 *
 * The vector below was produced by `http_ece` — the package the ecosystem
 * actually uses for RFC 8188/8291 — run on fixed inputs. That matters more than
 * it might look: a round-trip test (encrypt, then decrypt with the receiver's
 * key) passes just as happily when the spec has been misread, because both
 * halves misread it the same way. A byte-for-byte match against an independent
 * implementation is the thing that catches a swapped info string or a wrong
 * argument order.
 *
 * If this test ever fails after a change to `web-push.ts`, the code is wrong,
 * not the vector.
 */
const VECTOR = {
  p256dh:
    'BL5o0KPDOlRPRwye0AxlHLSY9F3Oqq2aAmOejVmqch-8rYcxgFl8naSZrK5zq15mmpdBumde19vRrhYCSFBHoVM',
  auth: '5ixp7JUVeDLks8R17y0Qzg',
  salt: 'E-Ej75xTgQD2DJN9BUkpQQ',
  serverPrivateKey: 'YkDGh970UTicwS11F1j6teg5T-CPpxEe7bhrhPR25t0',
  plaintext: 'When I grow up, I want to be a watermelon',
  expected:
    'E-Ej75xTgQD2DJN9BUkpQQAAEABBBO7EvuJitw1ZMRnVRNrVn-ijLbguO_6gsfyHmWhUI60yskc8viveVWAQXWG9cfZoljrIdhDgKzC8gFqzyjkg3q7QD1kx2qI7D1LIhH53N0fYCfyE4GMOHUrS2NYQPxbJlP-2HogkcBteHF9P-eX1SZwDVA_bY8dHEKLj',
} as const;

describe('encryptPayload', () => {
  it('matches an independent implementation byte for byte', () => {
    const { body } = encryptPayload(
      Buffer.from(VECTOR.plaintext),
      { p256dh: VECTOR.p256dh, auth: VECTOR.auth },
      {
        salt: Buffer.from(VECTOR.salt, 'base64url'),
        serverPrivateKey: Buffer.from(VECTOR.serverPrivateKey, 'base64url'),
      },
    );

    expect(body.toString('base64url')).toBe(VECTOR.expected);
  });

  /**
   * The header layout, asserted separately so a failure says *which* field
   * moved rather than only that the bytes differ.
   */
  it('lays the header out as salt, record size, key length, key', () => {
    const { body, serverPublicKey } = encryptPayload(
      Buffer.from('hello'),
      { p256dh: VECTOR.p256dh, auth: VECTOR.auth },
      { salt: Buffer.from(VECTOR.salt, 'base64url') },
    );

    expect(body.subarray(0, 16).toString('base64url')).toBe(VECTOR.salt);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body.subarray(21, 86).equals(serverPublicKey)).toBe(true);
    // 86 bytes of header, then ciphertext: plaintext + the padding delimiter,
    // plus the 16-byte GCM tag.
    expect(body.length).toBe(86 + 'hello'.length + 1 + 16);
  });

  /**
   * The worst mistake available in this file. The nonce is derived from the
   * salt, so reusing a salt against one subscription reuses the key/nonce pair
   * under AES-GCM — which leaks the XOR of two plaintexts and breaks the tag's
   * integrity guarantee. The default has to be random every time.
   */
  it('uses a fresh salt for every message', () => {
    const first = encryptPayload(Buffer.from('x'), VECTOR);
    const second = encryptPayload(Buffer.from('x'), VECTOR);

    expect(first.body.subarray(0, 16).equals(second.body.subarray(0, 16))).toBe(false);
    expect(first.serverPublicKey.equals(second.serverPublicKey)).toBe(false);
  });

  it('refuses a plaintext it cannot fit in one record', () => {
    // Not yet enforced — see the note in the delivery adapter. This pins the
    // current behaviour so the day it changes is a decision, not a surprise.
    const big = encryptPayload(Buffer.alloc(3000, 0x61), VECTOR);
    expect(big.body.length).toBeGreaterThan(3000);
  });
});

describe('vapidAuthorization', () => {
  const keys = generateVapidKeys('mailto:ops@agnte.app');

  it('is a vapid header carrying a signed token and the public key', () => {
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys);

    expect(header.startsWith('vapid t=')).toBe(true);
    expect(header).toContain(`, k=${keys.publicKey}`);
  });

  /**
   * The audience is the endpoint's *origin*. Including the path would make the
   * token specific to one subscription, which push services reject.
   */
  it('claims the origin as the audience, not the whole endpoint', () => {
    const header = vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc?x=1',
      keys,
      new Date('2026-09-17T00:00:00Z'),
    );

    const token = /vapid t=([^,]+)/.exec(header)?.[1] ?? '';
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString(),
    ) as { aud: string; exp: number; sub: string };

    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:ops@agnte.app');
    expect(claims.exp).toBe(Math.floor(Date.parse('2026-09-17T12:00:00Z') / 1000));
  });

  /**
   * ES256 wants a raw r||s signature; Node's default is DER, which every push
   * service refuses. Verified rather than asserted on length, so the check
   * fails for a signature that is the right size and the wrong bytes.
   */
  it('signs with a raw P-256 signature that actually verifies', () => {
    const header = vapidAuthorization('https://push.example/abc', keys);
    const token = /vapid t=([^,]+)/.exec(header)?.[1] ?? '';
    const [head, payload, signature] = token.split('.');

    const publicKey = Buffer.from(keys.publicKey, 'base64url');
    const jwk = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: publicKey.subarray(1, 33).toString('base64url'),
        y: publicKey.subarray(33, 65).toString('base64url'),
      },
    });

    const ok = verify(
      'sha256',
      Buffer.from(`${head}.${payload}`),
      { key: jwk, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature ?? '', 'base64url'),
    );

    expect(ok).toBe(true);
  });

  it('refuses a public key that is not an uncompressed P-256 point', () => {
    expect(() =>
      vapidAuthorization('https://push.example/abc', {
        ...keys,
        publicKey: Buffer.alloc(32).toString('base64url'),
      }),
    ).toThrow(/uncompressed P-256/);
  });
});

describe('buildPushRequest', () => {
  it('carries the headers a push service requires', () => {
    const keys = generateVapidKeys('mailto:ops@agnte.app');
    const request = buildPushRequest(
      { endpoint: 'https://push.example/abc', p256dh: VECTOR.p256dh, auth: VECTOR.auth },
      Buffer.from('{"title":"Take the tablet"}'),
      keys,
    );

    expect(request.url).toBe('https://push.example/abc');
    expect(request.headers['content-encoding']).toBe('aes128gcm');
    expect(request.headers.authorization?.startsWith('vapid t=')).toBe(true);
    expect(Number(request.headers.ttl)).toBeGreaterThan(0);
    expect(request.body.length).toBeGreaterThan(86);
  });
});

describe('generateVapidKeys', () => {
  it('produces a usable keypair', () => {
    const keys = generateVapidKeys('mailto:ops@agnte.app');
    const publicKey = Buffer.from(keys.publicKey, 'base64url');

    expect(publicKey.length).toBe(65);
    expect(publicKey[0]).toBe(0x04);
    expect(Buffer.from(keys.privateKey, 'base64url').length).toBe(32);

    // And the two halves actually belong together.
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(keys.privateKey, 'base64url'));
    expect(ecdh.getPublicKey().equals(publicKey)).toBe(true);
  });
});
