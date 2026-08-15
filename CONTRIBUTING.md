# Contributing to Intentum

Thank you for helping improve Intentum. The project values small, reviewable changes, explicit runtime behavior, strong regression coverage, and documentation that explains the trade-offs.

## Before you start

Install:

- Node.js 20 or newer
- npm
- Git
- [`aw` 0.8.1 or newer](https://github.com/7obyGit/aw) (recommended; CI uses it)

## Branch and pull request policy

All changes must come through a branch created from the current `main` branch. Do not commit directly to `main`.

```bash
git switch main
git pull --ff-only
git switch -c feat/short-description

npm ci
```

Use a focused branch name such as `feat/...`, `fix/...`, `docs/...`, or `test/...`. Keep unrelated cleanup out of the branch.

When the work is ready:

1. Run the required checks locally and inspect the complete diff.
2. Push the branch and open a pull request targeting `main`.
3. Describe the behavior change, testing performed, and any follow-up or migration concern.
4. Wait for required GitHub Actions checks and at least one maintainer approval.
5. Resolve review feedback and keep the branch up to date with `main` if requested.
6. A maintainer merges the approved pull request into `main`.

The `main` branch is the integration and release branch. A pull request is not complete until CI is green and an authorized reviewer has approved it.

## Local quality checks

The preferred project workflow uses `aw`, which discovers the npm scripts in `package.json`:

```bash
aw run check
aw run coverage
aw run package:check
aw run audit
```

The equivalent npm commands are:

```bash
npm run check
npm run coverage
npm run package:check
npm run audit
```

Add or update tests for every behavior change. Provider tests should inject a deterministic provider or fetch implementation; they must not require credentials or make live model calls. Changes to public APIs should update the relevant guide and examples.

## Code conventions

- Use strict TypeScript and preserve the existing ESM package structure.
- Prefer small public interfaces and explicit error types.
- Keep model/provider behavior deterministic in tests.
- Do not weaken validation, error recovery, permissions, or security controls to make a check pass.
- Use Conventional Commit messages, for example `feat: add tuple schema support`, `fix: retry timed out requests`, or `docs: clarify provider selection`.

## Documentation and releases

Update `README.md` or the relevant guide when behavior changes. Add a concise entry to [`CHANGELOG.md`](CHANGELOG.md) for user-visible changes.

Release preparation and npm publishing are documented in [docs/releasing.md](docs/releasing.md). Publishing is performed by the protected tag-based GitHub Actions workflow after the change has been merged to `main`.

## Reporting security issues

Please do not open a public issue for a suspected vulnerability. Follow the private reporting instructions in [SECURITY.md](SECURITY.md).
