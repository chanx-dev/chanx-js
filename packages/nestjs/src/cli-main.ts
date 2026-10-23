import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { Type } from '@nestjs/common';

import { asyncapiOf } from './asyncapi';

const USAGE = `Usage: chanx-nestjs asyncapi <module-file> [options]

Write the AsyncAPI document of a Nest app's chanx gateways, without serving it.

  <module-file>              The compiled module, such as dist/app.module.js
  -m, --module <name>        Its export to boot (default: AppModule, else the default export)
  -o, --out <file>           Write here; .yaml or .yml writes YAML (default: stdout, JSON)
  --title, --version, --description, --server-url, --server-protocol
                             The document's info and server`;

/** The `chanx-nestjs` command; resolves with the exit code. */
export async function main(
  argv: readonly string[],
  output: { log(text: string): void; error(text: string): void } = console,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      module: { type: 'string', short: 'm' },
      out: { type: 'string', short: 'o' },
      title: { type: 'string' },
      version: { type: 'string' },
      description: { type: 'string' },
      'server-url': { type: 'string' },
      'server-protocol': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, file] = positionals;
  if (values.help || command !== 'asyncapi' || !file) {
    (values.help ? output.log : output.error)(USAGE);
    return values.help ? 0 : 1;
  }

  const exports = (await import(pathToFileURL(resolve(file)).href)) as Record<
    string,
    unknown
  >;
  const name = values.module ?? ('AppModule' in exports ? 'AppModule' : 'default');
  const module = exports[name];
  if (typeof module !== 'function') {
    output.error(`${file} exports no module named ${name}; pass its name with --module`);
    return 1;
  }

  const document = await asyncapiOf(module as Type, {
    title: values.title,
    version: values.version,
    description: values.description,
    serverUrl: values['server-url'],
    serverProtocol: values['server-protocol'],
  });
  if (!values.out) {
    output.log(JSON.stringify(document, null, 2));
    return 0;
  }
  const yaml = /\.ya?ml$/.test(values.out)
    ? await import('yaml').catch(() => undefined)
    : undefined;
  if (/\.ya?ml$/.test(values.out) && !yaml) {
    output.error('Writing YAML needs the yaml package: npm install -D yaml');
    return 1;
  }
  await writeFile(
    values.out,
    yaml ? yaml.stringify(document) : `${JSON.stringify(document, null, 2)}\n`,
  );
  output.log(`Wrote ${values.out}`);
  return 0;
}
