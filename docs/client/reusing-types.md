# Reusing existing types

Payload types often already exist, generated from the server's OpenAPI schema for its REST endpoints. Reference them instead of generating duplicates:

```bash
npx @chanx-js/codegen <schema> -o src/generated \
  --reuse-from 'src/types/backend/**/*.ts' \
  --alias 'src/=@/'
```

Any type in the schema whose name matches an exported declaration in those files is imported rather than generated:

```ts
import type { PostPayload } from '@/types/backend/rooms';
```

The scan reads the TypeScript AST, so `export type`, `interface` and indented declarations are all found. Only exported declarations count, since importing anything else would not compile, and files inside the output directory are ignored.

With `--validation zod`, a reused type is not regenerated, so its validator is permissive. A reused message still checks its `action`.

If your existing types are _global scripts_ (bare `type X = ...` files with no imports or exports), add `--ambient`. Matching types are simply not emitted, and the global declaration wins.

## Checking reused types still match

A matching _name_ does not guarantee a matching _shape_: two schema generators can disagree on nullability, date formats, or required fields. `--reuse-strict` emits a `reuse-check` file that fails to compile when they drift:

```ts
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
type Assert<T extends true> = T;

export type CheckPostPayload = Assert<
  MutuallyAssignable<PostPayload, GeneratedPostPayload>
>;
```

It is purely type-level, so it works as a `.d.ts` under `--emit js` too, and runs in the typecheck you already have.
