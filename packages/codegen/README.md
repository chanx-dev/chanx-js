# @chanx-js/codegen

Generate typed channel descriptors for the [`@chanx-js/client`](https://www.npmjs.com/package/@chanx-js/client)
WebSocket client from a [chanx](https://github.com/huynguyengl99/chanx) AsyncAPI 3 schema.

Point it at a running server, Node or Python, and get the client's types, including
what each request is answered with.

**[Documentation](https://huynguyengl99.github.io/chanx-js/client/codegen)** · [Getting started](https://huynguyengl99.github.io/chanx-js/client/) ·
[Why chanx-js?](https://huynguyengl99.github.io/chanx-js/introduction/why)

```bash
npm install -D @chanx-js/codegen
npx chanx-codegen http://localhost:8000/asyncapi.json -o src/generated
```

- TypeScript output by default, or JavaScript with `.d.ts` via `--emit js`.
- Optional zod validators with `--validation zod`.
- Reuse types you already have with `--reuse-from`, and check they still match the
  schema with `--reuse-strict`.

MIT licensed.
