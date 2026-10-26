# @chanx-js/codegen

Generate typed channel descriptors for the [`@chanx-js/client`](https://www.npmjs.com/package/@chanx-js/client)
WebSocket client from a [chanx](https://github.com/chanx-dev/chanx) AsyncAPI 3 schema.

Point it at a running server, Node or Python, and get the client's types, including
what each request is answered with.

**[Documentation](https://js.chanx.dev/client/codegen)** · [Getting started](https://js.chanx.dev/client/) ·
[Why chanx-js?](https://js.chanx.dev/introduction/why)

```bash
npm install -D @chanx-js/codegen
npx chanx-codegen http://localhost:8000/asyncapi.json -o src/generated
```

- TypeScript output by default, or JavaScript with `.d.ts` via `--emit js`.
- Optional zod validators with `--validation zod`.
- Reuse types you already have with `--reuse-from`, and check they still match the
  schema with `--reuse-strict`.

MIT licensed.
