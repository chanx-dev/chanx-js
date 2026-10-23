import swc from 'unplugin-swc';
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
 * stub and breaks the Node end-to-end test. Hence one project each.
 */
const solidConditions = [source, 'solid', 'browser', 'import', 'module', 'default'];

const solidTests = 'packages/client/tests/solid.test.ts';
const nestTests = 'packages/nestjs/tests/**/*.test.ts';

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { conditions: solidConditions },
        ssr: { resolve: { conditions: solidConditions } },
        test: {
          name: 'solid',
          environment: 'node',
          include: [solidTests],
          server: { deps: { inline: [/solid-js/] } },
        },
      },
      {
        resolve: { conditions: nodeConditions },
        ssr: { resolve: { conditions: nodeConditions } },
        test: {
          name: 'default',
          environment: 'node',
          include: ['packages/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.tsx'],
          exclude: ['**/node_modules/**', solidTests, nestTests],
        },
      },
      {
        resolve: { conditions: nodeConditions },
        ssr: { resolve: { conditions: nodeConditions } },
        // Nest needs emitDecoratorMetadata for injection and pipes, which esbuild lacks.
        plugins: [
          swc.vite({
            jsc: { transform: { legacyDecorator: true, decoratorMetadata: true } },
          }),
        ],
        test: {
          name: 'nestjs',
          environment: 'node',
          include: [nestTests],
        },
      },
    ],
  },
});
