import { beforeAll, describe, expect, it } from 'vitest';

import type { FernetKey } from '../src/redis/fernet';
import { InvalidToken, decrypt, encrypt, importFernetKey } from '../src/redis/fernet';
import { consistentHash, crc32 } from '../src/redis/hash';
import { createSerializer } from '../src/redis/serializer';

// Expected values are Python's: binascii.crc32 and channels_redis' consistent hash.
describe('consistentHash', () => {
  it('matches binascii.crc32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode('room.1'))).toBe(0x95d95bc5);
  });

  it.each([
    ['asgi__group__room.lobby', [0, 0, 1]],
    ['asgispecific.0123456789abcdef0123456789abcdef', [0, 1, 1]],
    ['room.1', [1, 2]],
    ['room.2', [1, 1]],
    ['x', [0, 1]],
  ])('places %s on the same shard as channels_redis', (name, expected) => {
    const ringSizes = [2, 3, 5].slice(0, expected.length);
    expect(ringSizes.map((size) => consistentHash(name, size))).toEqual(expected);
  });
});

// The official vectors from https://github.com/fernet/spec.
const SECRET = 'cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=';
const TOKEN =
  'gAAAAAAdwJ6wAAECAwQFBgcICQoLDA0ODy021cpGVWKZ_eEwCGM4BLLF_5CV9dOPmrhuVUPgJobwOz7JcbmrR64jVmpU4IwqDA==';
const at = (iso: string) => Date.parse(iso) / 1000;

describe('fernet', () => {
  let key: FernetKey;
  beforeAll(async () => {
    const raw = atob(SECRET.replaceAll('-', '+').replaceAll('_', '/'));
    key = await importFernetKey(Uint8Array.from(raw, (char) => char.charCodeAt(0)));
  });

  it('generates the spec token', async () => {
    const token = await encrypt(key, new TextEncoder().encode('hello'), {
      now: at('1985-10-26T01:20:00-07:00'),
      iv: Uint8Array.from({ length: 16 }, (_, index) => index),
    });
    expect(token).toBe(TOKEN);
  });

  it('verifies the spec token', async () => {
    const plain = await decrypt([key], TOKEN, {
      ttl: 60,
      now: at('1985-10-26T01:20:01-07:00'),
    });
    expect(new TextDecoder().decode(plain)).toBe('hello');
  });

  it.each([
    [
      'incorrect mac',
      'gAAAAAAdwJ6xAAECAwQFBgcICQoLDA0OD3HkMATM5lFqGaerZ-fWPAl1-szkFVzXTuGb4hR8AKtwcaX1YdykQUFBQUFBQUFBQQ==',
      '1985-10-26T01:20:01-07:00',
    ],
    [
      'too short',
      'gAAAAAAdwJ6xAAECAwQFBgcICQoLDA0OD3HkMATM5lFqGaerZ-fWPA==',
      '1985-10-26T01:20:01-07:00',
    ],
    [
      'invalid base64',
      '%%%%%%%%%%%%%AECAwQFBgcICQoLDA0OD3HkMATM5lFqGaerZ-fWPAl1-szkFVzXTuGb4hR8AKtwcaX1YdykRtfsH-p1YsUD2Q==',
      '1985-10-26T01:20:01-07:00',
    ],
    [
      'payload size not multiple of block size',
      'gAAAAAAdwJ6xAAECAwQFBgcICQoLDA0OD3HkMATM5lFqGaerZ-fWPOm73QeoCk9uGib28Xe5vz6oxq5nmxbx_v7mrfyudzUm',
      '1985-10-26T01:20:01-07:00',
    ],
    [
      'payload padding error',
      'gAAAAAAdwJ6xAAECAwQFBgcICQoLDA0ODz4LEpdELGQAad7aNEHbf-JkLPIpuiYRLQ3RtXatOYREu2FWke6CnJNYIbkuKNqOhw==',
      '1985-10-26T01:20:01-07:00',
    ],
    [
      'far-future TS (unacceptable clock skew)',
      'gAAAAAAdwStRAAECAwQFBgcICQoLDA0OD3HkMATM5lFqGaerZ-fWPAnja1xKYyhd-Y6mSkTOyTGJmw2Xc2a6kBd-iX9b_qXQcw==',
      '1985-10-26T01:20:01-07:00',
    ],
    [
      'expired TTL',
      'gAAAAAAdwJ6xAAECAwQFBgcICQoLDA0OD3HkMATM5lFqGaerZ-fWPAl1-szkFVzXTuGb4hR8AKtwcaX1YdykRtfsH-p1YsUD2Q==',
      '1985-10-26T01:21:31-07:00',
    ],
    [
      'incorrect IV (causes padding error)',
      'gAAAAAAdwJ6xBQECAwQFBgcICQoLDA0OD3HkMATM5lFqGaerZ-fWPAkLhFLHpGtDBRLRTZeUfWgHSv49TF2AUEZ1TIvcZjK1zQ==',
      '1985-10-26T01:20:01-07:00',
    ],
  ])('rejects a token with %s', async (_reason, token, now) => {
    await expect(decrypt([key], token, { ttl: 60, now: at(now) })).rejects.toThrow(
      InvalidToken,
    );
  });
});

describe('serializer', () => {
  const message = { type: 'room.event', text: 'héllo ☕', n: 42, list: [1, 'two', null] };

  it.each(['msgpack', 'json'] as const)('round-trips %s', async (format) => {
    const serializer = createSerializer({ format });
    expect(await serializer.deserialize(await serializer.serialize(message))).toEqual(
      message,
    );
  });

  it('decrypts with any key and encrypts with the first, so keys can rotate', async () => {
    const old = createSerializer({ symmetricEncryptionKeys: ['old'] });
    const rotated = createSerializer({ symmetricEncryptionKeys: ['new', 'old'] });

    expect(await rotated.deserialize(await old.serialize(message))).toEqual(message);
    await expect(old.deserialize(await rotated.serialize(message))).rejects.toThrow(
      InvalidToken,
    );
  });

  it('rejects a payload that is not a dict', async () => {
    const serializer = createSerializer({ format: 'json' });
    await expect(serializer.deserialize(new TextEncoder().encode('[1]'))).rejects.toThrow(
      'not a dict',
    );
  });
});
