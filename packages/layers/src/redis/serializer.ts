import { decode, encode } from '@msgpack/msgpack';

import type { ChannelMessage } from '../types';
import type { FernetKey } from './fernet';
import { decrypt, encrypt, importFernetKey } from './fernet';

export type SerializerFormat = 'msgpack' | 'json';

export interface SerializerOptions {
  /** `serializer_format` in Python. Both sides of a layer must agree. */
  format?: SerializerFormat;
  /** `symmetric_encryption_keys` in Python: the first encrypts, any may decrypt. */
  symmetricEncryptionKeys?: ReadonlyArray<string | Uint8Array>;
}

export interface Serializer {
  serialize(message: ChannelMessage): Promise<Uint8Array>;
  deserialize(data: Uint8Array): Promise<ChannelMessage>;
}

/** channels_redis' message serializer, byte-compatible with it. */
export function createSerializer({
  format = 'msgpack',
  symmetricEncryptionKeys = [],
}: SerializerOptions = {}): Serializer {
  const toBytes =
    format === 'json'
      ? (message: ChannelMessage) => utf8.encode(JSON.stringify(message))
      : (message: ChannelMessage) => encode(message);
  const fromBytes =
    format === 'json'
      ? (data: Uint8Array) => JSON.parse(utf8decoder.decode(data)) as unknown
      : (data: Uint8Array) => decode(data);

  const keys =
    symmetricEncryptionKeys.length > 0
      ? Promise.all(symmetricEncryptionKeys.map(channelsFernetKey))
      : undefined;

  return {
    async serialize(message) {
      const bytes = toBytes(message);
      if (!keys) return bytes;
      return utf8.encode(await encrypt((await keys)[0]!, bytes));
    },

    async deserialize(data) {
      const bytes = keys ? await decrypt(await keys, utf8decoder.decode(data)) : data;
      const message = fromBytes(bytes);
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        throw new TypeError('Channel layer message is not a dict');
      }
      return message as ChannelMessage;
    },
  };
}

const utf8 = new TextEncoder();
const utf8decoder = new TextDecoder();

// channels_redis turns any secret into a Fernet key by hashing it.
async function channelsFernetKey(secret: string | Uint8Array): Promise<FernetKey> {
  const bytes = typeof secret === 'string' ? utf8.encode(secret) : new Uint8Array(secret);
  return importFernetKey(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
