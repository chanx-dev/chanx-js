# @chanx-js/codegen

## 2.1.1

### Patch Changes

- e1abc6a: The package README says what the package is for, shows a working example, and links to the docs.

## 2.1.0

### Minor Changes

- f7c72a3: Generated channels and topics carry what answers each request, from the schema's `reply`, so `request()` is typed by the action sent. The output needs `@chanx-js/client` 2.1 or later.

### Patch Changes

- 3e777a3: Generated relative imports carry the `.js` extension, so the output compiles under TypeScript's `NodeNext` resolution and runs on Node's ESM.
- 6f5857e: `channels.ts` imports `defineTopic` only when a channel has topics, so it compiles under `noUnusedLocals`, as in Vite's templates.
