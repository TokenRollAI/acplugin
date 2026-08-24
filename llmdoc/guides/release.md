# Releasing independently versioned public packages

> [中文对照](release.zh-CN.md)

ACPlugin has nine independently versioned public npm packages: the main package, six Platform packages, and Hooks/MCP Extensions. Core, Test, Docs, and Playground are private and must never be published.

Repository tooling requires Node.js `^22.18.0 || >=24.11.0`. Published packages separately support `^20.19.0 || ^22.13.0 || >=23.5.0`.

## Workflow

1. A feature pull request targeting `main` includes a Changeset for every affected public package.
2. `Lint` and `Typecheck` Actions run independently when that pull request is created or updated.
3. After the feature merges into `main`, `Changelog` consumes pending Changesets and creates or updates `chore(release): version packages`. The version PR contains package manifest versions, changelogs, and the generated public-version snapshot. It does not publish.
4. Merge the version PR only after reviewing the intended independent version bumps.
5. Publish a beta locally, or manually dispatch `Release` for stable versions.

The repository setting **Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests** must be enabled for `Changelog` to create its version PR with `GITHUB_TOKEN`.

## Prepare a beta

From the merged version revision, inspect pnpm's no-write plan:

```bash
pnpm install --frozen-lockfile
pnpm run publish:beta:dry-run
```

When the plan is correct, an authorized npm maintainer publishes locally:

```bash
pnpm run publish:beta
```

Append `--otp <OTP>` when npm requires a command-line one-time password. The root command builds the workspace and then uses pnpm's recursive `@tokenroll/*` workspace publish flow. It intentionally skips repeated package lifecycle scripts because the root build already produced the artifacts. pnpm packs each public package and rewrites repository `workspace:^` peer ranges to ordinary published ranges.

## Publish a stable release

Exit Changesets prerelease mode and merge the stable version PR first. Then manually dispatch the `Release` Action from `main`. The Action rejects prerelease versions and runs the same recursive public-workspace publish command with npm `latest`.

`Release` is intentionally manual: it requires the repository `NPM_TOKEN` secret but is never triggered by a pull request or push. It does not create a Git tag, GitHub Release, or separate dist-tag mutation.

## Safety rules

- Do not publish private `@acplugin/*` packages; root publish scripts filter only `@tokenroll/*`.
- Do not use `npm unpublish` to recover from a failed release.
- Do not create a tag or GitHub Release unless separately authorized.
- If an npm exact version already exists, let pnpm report and skip it; bump the package version before retrying a package that needs changed contents.
- Keep official Platform/Extension manifests on `@tokenroll/acplugin: workspace:^`; pnpm owns the packed peer-range rewrite.
- Run `pnpm run test` and `pnpm run docs:check` for changes that affect behavior, package boundaries, Docs, or Playground. The PR Actions intentionally remain limited to lint and typecheck.
