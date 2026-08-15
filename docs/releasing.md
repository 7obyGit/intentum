# Releasing Intentum

Intentum publishes from GitHub Actions when a semantic version tag is pushed. The workflow rebuilds and verifies the package before publishing it to npm with provenance.

## One-time setup

1. Create or verify the public npm package `intentum`.
2. Configure [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) for GitHub Actions with user `7obyGit`, repository `intentum`, workflow filename `release.yml`, and the `npm publish` action.
3. Protect `main` and require pull requests, approvals, and passing CI before merge.
4. Keep the package `repository`, `homepage`, and npm access settings aligned with the GitHub repository.

The release workflow is intentionally tag-driven and authenticates to npm through GitHub Actions
OIDC. It does not use an `NPM_TOKEN` secret. Trusted Publishing automatically generates npm
provenance for this public package.

## Public repository security gate

Complete these settings immediately after changing the repository visibility to public:

- Enable Dependabot alerts, Dependabot security updates, secret scanning, and secret scanning push protection.
- Enable CodeQL code scanning and keep the `CodeQL` workflow green.
- Enable private vulnerability reporting and keep [the security policy](../SECURITY.md) current.
- Protect `main`: require pull requests, at least one maintainer approval when another maintainer is available, passing `CI` checks, conversation resolution, linear history, and no force-pushes or deletions.
- Protect release tags matching `v*.*.*` so only maintainers can create, update, or delete tags that publish to npm.
- Keep Actions restricted to the selected GitHub-owned actions and require full-length commit SHAs for action references.

GitHub Free does not expose all of these controls for a private personal repository. The public-only
dependency review and CodeQL workflows are committed in advance and skip cleanly until the repository
is public; apply the GitHub settings above before accepting public contributions.

The release workflow uses Node.js 24, the current npm CLI, `npm ci`, the repository’s `aw` commands,
`npm pack --dry-run`, and `npm publish --access public` through Trusted Publishing.

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
