# How to Publish `@disdjj/acplugin` to npm

Release publishing is automated by GitHub Actions. The workflow lives at `.github/workflows/publish-npm.yml` and publishes only from Git tags that match the package version.

1. Update the package version in `package.json` and `package-lock.json`.

2. Commit the version bump to `main`.

3. Create and push a Git tag in the form `vX.Y.Z`. The tag must exactly match `package.json` version. Example: package version `1.5.3` requires tag `v1.5.3`.

4. GitHub Actions runs `.github/workflows/publish-npm.yml` on the tag push. The workflow validates the tag-version match, then runs `npm ci`, `npm run build`, `npm test`, `npm pack --dry-run`, and `npm publish`.

5. npm authentication uses Trusted Publishing, not a long-lived token. The npm package `@disdjj/acplugin` must be configured to trust the GitHub repository `TokenRollAI/acplugin` and workflow `.github/workflows/publish-npm.yml`.

6. Package metadata required for publishing is stored in `package.json`. `repository.url` must point to `https://github.com/TokenRollAI/acplugin.git`, and `publishConfig.access` must stay `public` because the package is scoped.
