---
name: npm-publish
description: Prepare, version, or explicitly publish independently versioned ACPlugin public packages with Changesets and pnpm. Use for beta dry runs/local publication or manual stable Release Action dispatch.
---

# Release public packages

Never create or push a tag, unpublish, change a dist-tag, or create a GitHub Release without explicit user authorization for that exact live mutation. Stable npm publication is permitted only through the repository's manually dispatched Release Action; beta npm publication is permitted only when the user explicitly authorizes the local command.

## Prepare and verify

1. Confirm each affected public package has a Changeset. Versions remain independent.
2. After the feature reaches `main`, let `Changelog` create or update the version PR; do not manually consume the same Changesets concurrently.
3. Run behavior checks in proportion to risk:

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run docs:check
```

Official Platforms and Extensions must keep `@tokenroll/acplugin` as a `workspace:^` peer. pnpm rewrites that range when packing for publication.

## Publish manually

For beta versions, first inspect the no-write plan:

```bash
pnpm run publish:beta:dry-run
```

Only after explicit authorization, publish from the merged version revision:

```bash
pnpm run publish:beta -- --otp <OTP>
```

For stable versions, exit Changesets prerelease mode, merge the stable version PR, then manually dispatch the `Release` Action from `main`. Do not add a push-triggered npm publication workflow.

## Create release references manually

Tags and GitHub Releases are separate, explicitly authorized maintenance actions. Never add an automated tag, dist-tag, or GitHub Release workflow.
