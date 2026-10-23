// Fernet (https://github.com/fernet/spec) as Python's `cryptography` implements it.
const VERSION = 0x80;
// cryptography's allowance for a sender's clock running ahead; the spec leaves it open.
const MAX_CLOCK_SKEW = 60;

export class InvalidToken extends Error {
  constructor() {
    super('Invalid Fernet token');
  }
}

export interface FernetKey {
  signing: CryptoKey;
  encryption: CryptoKey;
}

/** Import a raw 32-byte key: the first half signs, the second encrypts. */
export async function importFernetKey(raw: Uint8Array<ArrayBuffer>): Promise<FernetKey> {
  if (raw.length !== 32) throw new Error('Fernet key must be 32 bytes');
  const [signing, encryption] = await Promise.all([
    crypto.subtle.importKey(
      'raw',
      raw.slice(0, 16),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    ),
    crypto.subtle.importKey('raw', raw.slice(16), 'AES-CBC', false, [
      'encrypt',
      'decrypt',
    ]),
  ]);
  return { signing, encryption };
}

export async function encrypt(
  key: FernetKey,
  data: Uint8Array<ArrayBuffer>,
  { now = Date.now() / 1000, iv = crypto.getRandomValues(new Uint8Array(16)) } = {},
): Promise<string> {
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key.encryption, data),
  );
  const body = new Uint8Array(25 + ciphertext.length);
  body[0] = VERSION;
  new DataView(body.buffer).setBigUint64(1, BigInt(Math.floor(now)));
  body.set(iv, 9);
  body.set(ciphertext, 25);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key.signing, body));
  return toBase64Url(concat(body, mac));
}

/** Decrypt with the first key that verifies, as `MultiFernet` does. */
export async function decrypt(
  keys: readonly FernetKey[],
  token: string,
  { ttl, now = Date.now() / 1000 }: { ttl?: number; now?: number } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const data = fromBase64Url(token);
  if (data.length < 9 || data[0] !== VERSION) throw new InvalidToken();
  const timestamp = Number(new DataView(data.buffer, data.byteOffset).getBigUint64(1));
  if (ttl !== undefined) {
    const current = Math.floor(now);
    if (timestamp + ttl < current || current + MAX_CLOCK_SKEW < timestamp) {
      throw new InvalidToken();
    }
  }

  const body = data.subarray(0, -32);
  const mac = data.subarray(-32);
  for (const key of keys) {
    if (!(await crypto.subtle.verify('HMAC', key.signing, mac, body))) continue;
    try {
      const iv = data.subarray(9, 25);
      const ciphertext = data.subarray(25, -32);
      return new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key.encryption, ciphertext),
      );
    } catch {
      throw new InvalidToken();
    }
  }
  throw new InvalidToken();
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new InvalidToken();
  }
}
