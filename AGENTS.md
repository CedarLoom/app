# AGENTS.md

## Commands

Node.js 26, pnpm 12 and uv. Install with `pnpm install --frozen-lockfile --ignore-scripts`.

- `pnpm run check`: every gate ([scripts/check.sh](scripts/check.sh)), the one to run before a push. Its step `packed` ([scripts/packed.sh](scripts/packed.sh)) builds `core`, `use-cases` and `cli` into their `dist` folders, packs them, installs the three tarballs and the `zod` of the lockfile together in an empty folder and runs `cedarloom --version` and `cloom --version` from there.
- `pnpm run build` builds every package, `ui` before `app`: the `app` build copies `packages/ui/dist` into `packages/app/dist/ui`, the folder its server serves `/` and `/assets/*` from, and leaves `dist/ui` absent while `ui` builds nothing.
- Single gates, each as `pnpm run <name>`: `typecheck`, `lint`, `format:check` (`format` writes), `test`, `knip`, `jscpd`, `licenses`. Keep `run`: `pnpm licenses` alone is pnpm's built-in command.
- The Python-packaged gate tools (typos, reuse, actionlint, zizmor) run through `uvx` with the versions of [tools/requirements.txt](tools/requirements.txt). In CI the zizmor action runs zizmor with its online audits instead.
- [packages/app/openapi.json](packages/app/openapi.json) is generated from the server's routes: after changing a route or its schemas, run `pnpm --filter @cedarloom/app run openapi` and commit the result; the check fails while it is stale.
- CI ([.github/workflows](.github/workflows)) runs `pnpm run check` on Linux, then Schemathesis ([packages/app/scripts/schemathesis.ts](packages/app/scripts/schemathesis.ts), from [tools/schemathesis-requirements.txt](tools/schemathesis-requirements.txt)) against a running `cedarloom-app` and `openapi.json`, and `typecheck` and `test` on macOS and Windows, for every pull request and push to main. It installs pnpm from [.github/pnpm/package-lock.json](.github/pnpm/package-lock.json) and uv from [tools/uv-requirements.txt](tools/uv-requirements.txt). The required checks are `checks`, `conventional` (the pull request title) and `dependency-review`; keep their names.

## Before you push

- Run `pnpm run check` after your last edit, right before every push. Never use `--no-verify`.
- Don't poll CI: wait with `gh run watch <run-id> --interval 30 --compact --exit-status` or `gh pr checks --watch --interval 30`.
- main stays releasable. A red main is fixed before anything else merges.

## Code

- Make the smallest change that does the whole task, including the callers, tests, fixtures, configuration and docs it breaks or changes. Add nothing speculative: no option, flag, layer, shim or "for later" code; name what you left out in one line of the report.
- Reuse in this order: code the repository has (extend it, never a parallel version; abstract at the second caller, not the first), the standard library or platform, an installed dependency, a maintained package (recent releases, a license the project allows, a size that fits; name it and why in the pull request), own code. A few own lines beat a new dependency.
- Validate where data enters (user input, files, the network, another process) and where a wrong value loses data or breaks security. Inside, trust the types, the framework and your own code: no guard or fallback for a case that cannot happen. An error you cannot handle propagates; never swallow it or hide it behind a default.
- One job per function, module and file, named after it; never `utils`, `helpers`, `common`, `misc` or `shared`. A unit that wants such a name has two jobs: split it.
- Keep the layers below: imports point down, never up. Code that gets a test takes the time, randomness and I/O it uses as parameters.
- Typed findings, refusals and API errors carry a code and parameters, never text; their messages live in the message catalogs. A code is the id of its message in [packages/core/src/messages/en.po](packages/core/src/messages/en.po): after editing it, run `pnpm --filter @cedarloom/core run messages` and commit the generated `en.json` and `catalog.ts`; the check fails while they are stale. The CLI's own text (usage, result lines) lives in [packages/cli/src/messages/en.po](packages/cli/src/messages/en.po), compiled with `pnpm --filter @cedarloom/cli run messages` in the same way.
- Remove what your change made unused. Leave other code, comments and formatting as they are; name unrelated dead code in the report.
- Comments only where the code cannot say it: one line, the why, not the how.

### Layers

| Package              | Layer                  | Holds                                                                                                                          | May import                      |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `packages/core`      | logic: no Node, no DOM | schemas of the app's data, canonical JSON, the plan builder, edit operations, codes                                            | nothing of the workspace; `zod` |
| `packages/use-cases` | Node                   | one function per use case, and its adapters: store, file apply, plugin locator                                                 | `core`                          |
| `packages/app`       | Node                   | the `cedarloom-app` command: the local HTTP server on `127.0.0.1`, its session security, the OpenAPI document and the built UI | `core`, `use-cases`             |
| `packages/ui`        | DOM                    | the web UI; it reaches the app's server over HTTP only                                                                         | `core`                          |
| `packages/cli`       | Node                   | the `cedarloom` and `cloom` commands                                                                                           | `core`, `use-cases`             |

Each package's `tsconfig.json` sets the `lib` and `types` of its layer, so typecheck refuses Node APIs in `core` and `ui` and DOM APIs in `core`. [packages/core/src/url.d.ts](packages/core/src/url.d.ts) declares the `URL` type that zod's declarations name, as a type only, and [packages/core/src/text-encoder.d.ts](packages/core/src/text-encoder.d.ts) the `TextEncoder` that Node.js and browsers both provide. Tests (`*.test.ts`) and scripts of `core` typecheck with its `tsconfig.node.json` and may use Node APIs; its production code may not. Oxlint ([.oxlintrc.json](.oxlintrc.json)) refuses `node:` imports in `ui` and in `core` outside its tests and scripts (bare built-in names through `unicorn/prefer-node-protocol`), every workspace import the table does not allow, by package name or by relative path, and every triple-slash reference. `app` takes the UI as built files, never as an import.

## Tests

- Do not add tests by default. Add one only when it fails if your change is reverted, hardcodes its expected values (never computed by production code, locale files or mocks), and runs at the single layer that owns the behavior.
- Never test copy or translations, CSS classes, constants, third-party libraries, private state, timing or call counts. When you touch such a test, delete it instead of updating it.
- There are no coverage thresholds.

## Public content

The repository is public, so everything written into it is public text: commits, branch names, pull request titles and bodies, `REUSE.toml` comments, this file, code comments, UI and CLI text.

- No reference to a private planning or tracking place: no repository slug, URL, issue number, decision ids, board names or line references into private docs.
- No decision or approval wording ("owner decision", "approved", decision dates) and no local paths.
- Docs, comments and messages state what holds, in a neutral tone.
- Public repositories may be named; private ones may not.

## Gates beside GitHub's

`pnpm run check` runs locally what GitHub's dependency review checks only in a pull request:

- `pnpm audit --audit-level high`: known vulnerabilities in every installed package.
- `pnpm run licenses`: [scripts/licenses.ts](scripts/licenses.ts) checks every dependency of every workspace package installed for the current platform (`pnpm licenses list --recursive`) against the allow-list in [.github/dependency-review-config.json](.github/dependency-review-config.json), the file dependency review reads. The exemption for `caniuse-lite` (CC-BY-4.0 browser data) is per package, because dependency review cannot scope a license by dependency type: it stays in `devDependencies` of build tooling and never goes into a shipped package.

## Licenses

[REUSE.toml](REUSE.toml) maps every path: code ISC, own data files CC0-1.0, names and logos `LicenseRef-Brand`. A license text goes into `LICENSES/` with the first file that uses it.
