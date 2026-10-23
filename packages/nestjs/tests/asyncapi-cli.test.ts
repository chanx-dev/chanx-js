import 'reflect-metadata';

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AsyncAPIDocument } from '@chanx-js/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { asyncapiOf } from '../src';
import { main } from '../src/cli-main';
import { AppModule } from './fixtures/app.module';

const fixture = fileURLToPath(new URL('./fixtures/app.module.ts', import.meta.url));
let dir: string;
beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), 'chanx-nestjs-'))));
afterEach(() => rm(dir, { recursive: true, force: true }));

function capture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: { log: (t: string) => logs.push(t), error: (t: string) => errors.push(t) },
  };
}

describe('asyncapiOf', () => {
  it("documents a module's gateways without serving them", async () => {
    const document = await asyncapiOf(AppModule, { title: 'Ping API' });

    expect(document.info.title).toBe('Ping API');
    expect(Object.keys(document.channels)).toEqual(['ping']);
    expect(Object.keys(document.operations)).toEqual(['ping']);
  });
});

describe('chanx-nestjs asyncapi', () => {
  it('writes the JSON document of the module file it is given', async () => {
    const out = join(dir, 'asyncapi.json');
    const { logs, output } = capture();

    expect(
      await main(['asyncapi', fixture, '-o', out, '--title', 'Ping API'], output),
    ).toBe(0);

    const document = JSON.parse(await readFile(out, 'utf8')) as AsyncAPIDocument;
    expect(document.info.title).toBe('Ping API');
    expect(Object.keys(document.channels)).toEqual(['ping']);
    expect(logs).toEqual([`Wrote ${out}`]);
  });

  it('writes YAML for a .yaml file, and JSON to stdout without one', async () => {
    const out = join(dir, 'asyncapi.yaml');
    await main(['asyncapi', fixture, '-o', out], capture().output);
    const stdout = capture();
    await main(['asyncapi', fixture], stdout.output);

    expect(parse(await readFile(out, 'utf8'))).toEqual(JSON.parse(stdout.logs[0]!));
  });

  it('boots the export --module names', async () => {
    const { logs, output } = capture();
    expect(await main(['asyncapi', fixture, '--module', 'OtherModule'], output)).toBe(0);
    expect(Object.keys((JSON.parse(logs[0]!) as AsyncAPIDocument).channels)).toEqual([
      'ping',
    ]);
  });

  it('fails, saying why, without a module or a command it knows', async () => {
    const missing = capture();
    expect(await main(['asyncapi', fixture, '-m', 'Nope'], missing.output)).toBe(1);
    expect(missing.errors).toEqual([
      `${fixture} exports no module named Nope; pass its name with --module`,
    ]);

    const usage = capture();
    expect(await main(['generate'], usage.output)).toBe(1);
    expect(usage.errors[0]).toMatch(/^Usage: chanx-nestjs asyncapi/);
  });
});
