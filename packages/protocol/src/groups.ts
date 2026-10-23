import { blake2s } from '@noble/hashes/blake2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const MAX_GROUP_NAME_LENGTH = 99;

const UNSAFE_CHARS = /[^A-Za-z0-9._-]+/g;
const DIGEST_LENGTH = 12;

/** Only these stringify the same in Python and JS. */
export type GroupNamePart = string | number | bigint;

/**
 * A channel layer group name built from arbitrary parts, identical to chanx's
 * `safe_group_name` so Python and Node processes can share a layer.
 *
 * ```ts
 * safeGroupName(['user', 42], { namespace: 'notification' }); // 'notification.user.42'
 * ```
 */
export function safeGroupName(
  parts: readonly GroupNamePart[],
  { namespace }: { namespace?: string } = {},
): string {
  const segments = namespace === undefined ? parts : [namespace, ...parts];
  const name = segments.map(slug).filter(Boolean).join('.');
  if (!name) throw new Error('safeGroupName() produced an empty name');
  if (name.length <= MAX_GROUP_NAME_LENGTH) return name;

  // blake2s's digest size is part of its parameter block, so this must hash with
  // dkLen 6 like Python's digest_size=6, not truncate a full digest.
  const digest = bytesToHex(blake2s(utf8ToBytes(name), { dkLen: DIGEST_LENGTH / 2 }));
  return `${name.slice(0, MAX_GROUP_NAME_LENGTH - DIGEST_LENGTH - 1)}.${digest}`;
}

function slug(part: GroupNamePart): string {
  return String(part)
    .replace(UNSAFE_CHARS, '-')
    .replace(/^-+|-+$/g, '');
}
