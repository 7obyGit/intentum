# Releasing Intentum

Intentum publishes from GitHub Actions when a semantic version tag is pushed. The workflow rebuilds and verifies the package before publishing it to npm with provenance.

## One-time setup

1. Create or verify the public npm package `intentum`.
2. Configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for this repository and the `release.yml` workflow, or provide an `NPM_TOKEN` repository secret.
3. Protect `main` and require pull requests, approvals, and passing CI before merge.
4. Keep the package `repository`, `homepage`, and npm access settings aligned with the GitHub repository.

The release workflow uses Node.js 24, the current npm CLI, `npm ci`, the repository’s `aw` commands, `npm pack --dry-run`, and `npm publish --provenance --access public`.

## Release checklist

From a fresh branch created from current `main`:

```bash
git switch main
git pull --ff-only
release_version=0.1.0
git switch -c "release/v$release_version"

npm ci
npm version "$release_version" --no-git-tag-version
# Move the released entries from CHANGELOG.md into the new version section.
aw run release:check
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: prepare v$release_version"
git push --set-upstream origin "release/v$release_version"
```

Then:

1. Review the complete diff and release notes.
2. Open a pull request into `main`; do not push directly to `main`.
3. Wait for CI and an approval from a maintainer.
4. Merge the approved pull request into `main`.
5. From the merged commit, create and push the release tag without committing directly to `main`:

   ```bash
   git switch main
   git pull --ff-only
   git tag v0.1.0
   git push origin v0.1.0
   ```

6. Confirm the `Release` workflow succeeds and inspect the package on npm.

## Verify the published artifact

The package check requires runtime files and documentation while rejecting source, tests, CI configuration, and environment files. To inspect it locally:

```bash
npm run package:check
npm pack --dry-run
```

Never publish credentials, local caches, generated test output, or unreviewed generated source. If a release is wrong, deprecate the affected version and publish a corrected patch; do not rewrite published package history.
