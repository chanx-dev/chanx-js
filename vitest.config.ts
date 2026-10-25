import swc from 'unplugin-swc';
import type { TestProjectInlineConfiguration } from 'vitest/config';
import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript source, so tests need no build first.
const source = '@chanx-js/source';
const nodeConditions = [source, 'module', 'node', 'development|production'];

/**
 * Solid needs the `solid` and `browser` conditions: under plain Node resolution
 * `solid-js` loads its server build, where every signal is an inert stub and the
 * binding's reactivity silently does nothing.
 *
 * Those conditions cannot be global, because `browser` also sends `ws` to its browser
 * stub and breaks the Node end-to-end test. Hence a project of its own.
 */
const solidConditions = [source, 'solid', 'browser', 'import', 'module', 'default'];
const solidTests = 'packages/client/tests/solid.test.ts';

/** One package's tests, named after it: `pnpm test --project server`. */
function project(
  name: string,
  include: string[],
  extra: Partial<TestProjectInlineConfiguration> = {},
  conditions = nodeConditions,
): TestProjectInlineConfiguration {
  return {
    resolve: { conditions },
    ssr: { resolve: { conditions } },
    ...extra,
    test: {
      name,
      environment: 'node',
      include,
      exclude: ['**/node_modules/**', solidTests],
      ...extra.test,
    },
  };
}

const tests = (pkg: string) => [
  `packages/${pkg}/tests/**/*.test.ts`,
  `packages/${pkg}/tests/**/*.test.tsx`,
];

export default defineConfig({
  test: {
    // `pnpm coverage`; set REDIS_URL, REDIS_URL_2 and REDIS_SENTINEL to count the Redis paths.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: ['**/*.d.ts'],
      reporter: ['text-summary', 'html'],
    },
    projects: [
      project('client', tests('client')),
      project(
        'client:solid',
        [solidTests],
        { test: { exclude: [], server: { deps: { inline: [/solid-js/] } } } },
        solidConditions,
      ),
      project('codegen', tests('codegen')),
      project('layers', tests('layers')),
      project('protocol', tests('protocol')),
      project('server', tests('server')),
      // Nest needs emitDecoratorMetadata for injection and pipes, which esbuild lacks.
      project('nestjs', tests('nestjs'), {
        plugins: [
          swc.vite({
            jsc: { transform: { legacyDecorator: true, decoratorMetadata: true } },
          }),
        ],
      }),
    ],
  },
});
