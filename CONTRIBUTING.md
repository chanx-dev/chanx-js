# Contributing

chanx-js is a pnpm monorepo. [AGENTS.md](AGENTS.md) maps the packages and holds the code
conventions, for people and coding agents alike; [docs/design.md](docs/design.md)
explains why things are built the way they are. This file is the workflow: setting up,
checking a change, and releasing it.

## Setup

Node 20 or later, and pnpm at the version `package.json` pins
(`corepack enable` picks it up):

```bash
pnpm install
pnpm check    # lint, format, typecheck, test
```

No build is needed first: tests and typecheck read each workspace package's TypeScript
source through the `@chanx-js/source` export condition.

## Everyday commands

| Command                       | What it does                                                       |
| ----------------------------- | ------------------------------------------------------------------ |
| `pnpm check`                  | Lint, format, typecheck and test: run it before you push           |
| `pnpm test --project server`  | One package's tests (`client:solid` holds the Solid binding)       |
| `pnpm test <path>`            | One test file or directory                                         |
| `pnpm lint:fix`, `format:fix` | Fix what ESLint and Prettier can                                   |
| `pnpm build`                  | Build every package, and the docs site                             |
| `pnpm check:conformance`      | Regenerate the clients from chanx's sandbox schema; fails on drift |
| `pnpm docs:dev`, `docs:build` | The docs site; TypeDoc warnings and dead links fail the build      |

## Tests beyond the default run

**Redis.** The layer and server tests against Redis run only with `REDIS_URL` set; two
servers exercise sharding:

```bash
docker compose up -d
REDIS_URL=redis://localhost:6389 REDIS_URL_2=redis://localhost:6390 pnpm test --project layers --project server
```

**Bun and Deno.** A smoke script runs the built packages on each runtime, through its
crossws and Hono adapters:

```bash
pnpm build
pnpm --filter @chanx-js/server smoke:bun    # or smoke:deno
```

**Python chanx.** Where chanx-js mirrors chanx (wire format, error reasons, group names,
AsyncAPI), expected values come from running chanx, not from reading its source.

CI runs all of these on every pull request and push to `main`: lint and typecheck, one
test job per package, Redis, Bun and Deno, conformance, and the docs build.

## Making a change

Commits follow [Conventional Commits](https://www.conventionalcommits.org):
`feat(server): ...`, `fix(client): ...`, `docs: ...`, `test: ...`, `ci: ...`, imperative
and lowercase.

A change a user of a published package would notice comes with a **changeset**:

```bash
pnpm changeset
```

It asks which packages changed, whether each is a `patch` (a fix) or a `minor` (a
feature), and for a line for their changelogs. Commit the file it writes in
`.changeset/` with the change. Never choose `major`: see [Versions](#versions).

Tests, docs, CI and refactors that change nothing for a user need no changeset.

## Releasing

Maintainers release when they choose to, from `main`:

```bash
pnpm version-packages
git add -A && git commit -m "chore: version packages" && git push
```

`pnpm version-packages` turns the pending changesets into version bumps, only for the
packages they name, and writes each package's `CHANGELOG.md`. Read the result before you
commit it.

The push runs the Publish workflow, which checks the whole repo, builds the packages,
publishes each version not yet on npm (with provenance, through npm's trusted
publishing), tags and releases it on GitHub, and deploys the docs. A push with nothing
new to publish skips all of that.

To deploy only the docs, for a fix between releases, run the Docs workflow by hand from
the Actions tab.

### Versions

A package's major version follows chanx's: chanx-js 2.x speaks the chanx 2 protocol, so
any 2.x client works with any 2.x server, Node or Python. A new chanx major is a new
major for every package, and nothing else is. Within a major, each package versions on
its own, and packages depend on each other by caret range, so a server fix reaches
`@chanx-js/nestjs` users without a Nest release.

## Adding a package

A new package under `packages/` needs:

- [ ] `package.json` with `files`, `license`, `repository`, and an `exports` map whose
      entries start with `"@chanx-js/source": "./src/....ts"`
- [ ] a `LICENSE` copy and a `README.md`
- [ ] a `typedoc.json`, and the package in `docs/typedoc.json`'s `entryPoints`
- [ ] a Vitest project in `vitest.config.ts`, and that project in CI's test matrix in
      `.github/workflows/ci.yml`
- [ ] its row in AGENTS.md's package table
- [ ] internal dependencies as `workspace:^`

Its first version is published by hand, because npm's trusted publishing needs the
package to exist:

```bash
pnpm build
cd packages/<name> && pnpm publish --access public
```

npm holds a new name for review for a few minutes before releasing it. Then, on npmjs.com,
add the package's trusted publisher: GitHub Actions, repository
`huynguyengl99/chanx-js`, workflow `publish.yml`, environment `deploy`. From then on,
releases publish it.
