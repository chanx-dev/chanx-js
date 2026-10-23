# AGENTS.md

How to work in chanx-js. Read [docs/design.md](docs/design.md) for why things are built the
way they are.

## The repo

The JavaScript home for [chanx](https://github.com/huynguyengl99/chanx), a second
implementation of its protocol held in line by tests.

| Path                | What                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| `packages/protocol` | Private wire protocol (envelope, patterns, group names). Bundled, never published. |
| `packages/client`   | `@chanx-js/client`: runtime plus React, Vue, Svelte and Solid bindings.            |
| `packages/codegen`  | `@chanx-js/codegen`: AsyncAPI 3 schema to typed channel descriptors.               |
| `packages/layers`   | `@chanx-js/layers`: channel layers; Redis pub/sub compatible with Python's.        |
| `packages/server`   | `@chanx-js/server`: consumers, dispatch and the chanx protocol, server side.       |
| `conformance*`      | Generated TS and JS clients from chanx's sandbox schema, type-checked.             |
| `docs`              | VitePress site, guide and TypeDoc API reference.                                   |

## Commands

```bash
pnpm check              # lint, format, typecheck, test: run before you finish
pnpm build              # every package
pnpm check:conformance  # regenerate conformance clients; fails on any diff
pnpm docs:build         # TypeDoc warnings and dead links fail it
pnpm test <path>        # one test file or directory
```

Redis tests run only with `REDIS_URL` set:

```bash
docker compose up -d
REDIS_URL=redis://localhost:6389 REDIS_URL_2=redis://localhost:6390 pnpm test packages/layers packages/server
```

## Code that speaks for itself

The code is the documentation. Reach for a better name, a smaller function or a type
before a comment.

- **Names carry intent.** `isFrameworkAction(action)`, not `check(a)` plus a comment.
- **Types carry contracts.** A literal union, a branded type or a required parameter says
  what a comment would only ask for.
- **Comment only what the code cannot say**: why a non-obvious choice was made, a
  constraint from outside (a chanx server behaviour, a browser quirk, a framework trap),
  or an algorithm a reader would otherwise have to reverse-engineer. Never restate what
  the line does.
- **Docstrings are one line**, on exported API only: they feed editor hovers and the API
  reference. Add more lines only for a non-obvious contract (what throws, what is
  shared, an example worth showing). Internal helpers get none unless the logic is
  genuinely hard.
- **No module headers** that summarise the file. The file name and its exports do that.
  The exception is an entry point's `@module` block, which TypeDoc needs.
- **No section dividers, commented-out code or TODOs** without an owner or issue.
- Keep comments true: changing the code means changing or deleting its comment.
- No long dashes (—) in comments or docs. Use a colon, a comma or a new sentence.

```ts
// Bad: restates the code
// Loop over handlers and call each one safely
for (const handler of handlers) safely(handler, message);

// Good: says why, which the code cannot
// Copy first: a handler may unsubscribe itself while we iterate.
for (const handler of [...handlers]) safely(handler, message);
```

## TypeScript

- Strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. No `any` in public
  signatures; justify every cast by the code around it, not a comment if you can avoid it.
- `import type` for types (enforced by ESLint). Package imports first, a blank line, then
  relative imports.
- ESM only, Node 20+. Core code uses Web APIs only, so it runs on Node, Bun, Deno,
  browsers and workers; Node-only code lives behind its own entry point.
- **Classes for things with state and a lifecycle** (`SharedSocket`, `ChannelConnection`),
  named after their Python counterpart when chanx or channels has one. Keep
  internals private, bind methods callers are likely to pass around, and let
  extension points be overridable methods, as in Python.
- **Functions for the rest**: stateless helpers, and builders and factories such as
  `createClient()` and `defineChannel()`.
- Public API is a commitment: name it as you would support it for years. Export nothing
  that has no user.

## Behaviour rules

- **The Python chanx server is the reference.** Wire format, error reasons, group names
  and AsyncAPI output must match it. Take expected values from running chanx, not from
  reading its source.
- **Test fakes are never kinder than the real server.** `FakeServer` mirrors chanx's
  limits on purpose; a fake that forgives hides client bugs.
- **Shared sockets**: every change must be correct for the _other_ consumers on the
  socket too.
- **Every timer, listener and subscription has a matching teardown.**
- **Errors surface**: rejected, reported through `reportError`, or documented. Never
  swallowed.
- Runtime packages keep their dependency footprint minimal; heavy tools (ts-morph) stay
  in `codegen`.

## Tests

- Vitest. Tests live in `packages/<name>/tests`.
- A test must fail if the behaviour it names breaks. Test behaviour through the public
  API, not private state.
- Framework bindings share one controller, so test behaviour there once; binding tests
  cover only the adapter.

## Commits and releases

- [Conventional Commits](https://www.conventionalcommits.org): `feat(core): ...`,
  `fix(codegen): ...`, `docs: ...`, `test: ...`, `ci: ...`. Imperative, lowercase,
  describes the change for a user.
- Releases go through `pnpm release` (commit-and-tag-version); do not edit
  `CHANGELOG.md` or versions by hand.

## Docs

- User-facing behaviour goes in `docs/guide`; the reasoning behind a design goes in
  `docs/design.md`, not in code comments.
- Short sentences, active voice, no filler.
