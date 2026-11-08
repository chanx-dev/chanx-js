import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadSchema } from '../src/loader';

const fixture = fileURLToPath(
  new URL('./__fixtures__/fastapi-asyncapi.json', import.meta.url),
);

async function generateWith(prettierModule: object): Promise<string> {
  vi.resetModules();
  vi.doMock('prettier', () => prettierModule);
  const { generate } = await import('../src/generate');
  const outDir = await mkdtemp(join(tmpdir(), 'chanx-codegen-format-'));
  try {
    await generate(await loadSchema(fixture), { outDir, format: true });
    return await readFile(join(outDir, 'channels.ts'), 'utf-8');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

describe('formatting with the installed prettier', () => {
  afterEach(() => {
    vi.doUnmock('prettier');
    vi.restoreAllMocks();
  });

  it('formats with a prettier whose API is only on its default export', async () => {
    const output = await generateWith({
      default: {
        resolveConfig: async () => null,
        format: (code: string) => `// formatted\n${code}`,
      },
    });
    expect(output.startsWith('// formatted\n')).toBe(true);
  });

  it('writes unformatted output and warns when prettier has no usable API', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const output = await generateWith({ default: {} });
    expect(output).toContain('defineChannel');
    expect(warn).toHaveBeenCalledOnce();
  });
});
