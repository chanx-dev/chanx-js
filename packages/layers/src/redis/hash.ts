const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc;
});

/** zlib's CRC-32, as Python's `binascii.crc32`. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The host index channels_redis picks for a name, so both sides agree on the shard. */
export function consistentHash(name: string, ringSize: number): number {
  if (ringSize === 1) return 0;
  const value = crc32(new TextEncoder().encode(name)) & 0xfff;
  return Math.floor(value / (4096 / ringSize));
}
