# Releasing

Each package is versioned independently with Release Please. Conventional
commits that touch a package update its release pull request and changelog.
Merging that pull request creates a package-prefixed tag and a draft GitHub
release.

The same workflow then:

1. installs from the frozen lockfile without a cache;
2. runs the full offline check suite;
3. packs the released packages in a job with no publish credentials;
4. waits for the protected `release` environment;
5. publishes the tarballs to npm with short-lived OIDC credentials and npm
   provenance; and
6. attaches the exact tarballs and checksums to their draft GitHub releases
   before publishing those releases.

All actions are pinned to full commit SHAs. Workflow permissions default to
none and are granted per job. The OIDC-enabled job does not check out or execute
repository code, and release jobs do not use dependency caches.

## One-time npm bootstrap

npm requires a package to exist before a trusted publisher can be configured.
For each new package name, an npm owner must therefore perform the initial
publish interactively with 2FA after running:

```sh
pnpm install --frozen-lockfile
pnpm check
cd packages/eve-project-link
npm publish --access public
cd ../eve-openai-connectors
npm publish --access public
cd ../eve-openai-plugins
npm publish --access public
cd ../eve-openai-imagegen
npm publish --access public
cd ../eve-aws-lambda-microvms
npm publish --access public
```

Create the matching initial draft GitHub releases and publish them only after
the npm publishes succeed:

```sh
gh release create eve-project-link-v0.1.0 --draft --generate-notes --target main
gh release create eve-openai-connectors-v0.1.0 --draft --generate-notes --target main
gh release create eve-openai-plugins-v0.1.0 --draft --generate-notes --target main
gh release create eve-openai-imagegen-v0.1.0 --draft --generate-notes --target main
gh release create eve-aws-lambda-microvms-v0.1.0 --draft --generate-notes --target main
gh release edit eve-project-link-v0.1.0 --draft=false
gh release edit eve-openai-connectors-v0.1.0 --draft=false
gh release edit eve-openai-plugins-v0.1.0 --draft=false
gh release edit eve-openai-imagegen-v0.1.0 --draft=false
gh release edit eve-aws-lambda-microvms-v0.1.0 --draft=false
```

Then configure the `release.yml` workflow as the trusted publisher for each
package. npm 11.17 or newer can do this from an authenticated maintainer shell:

```sh
npm trust github eve-project-link \
  --repo ewhauser/eve-extensions \
  --file release.yml \
  --env release \
  --allow-publish
npm trust github eve-openai-connectors \
  --repo ewhauser/eve-extensions \
  --file release.yml \
  --env release \
  --allow-publish
npm trust github eve-openai-plugins \
  --repo ewhauser/eve-extensions \
  --file release.yml \
  --env release \
  --allow-publish
npm trust github eve-openai-imagegen \
  --repo ewhauser/eve-extensions \
  --file release.yml \
  --env release \
  --allow-publish
npm trust github eve-aws-lambda-microvms \
  --repo ewhauser/eve-extensions \
  --file release.yml \
  --env release \
  --allow-publish
```

After verifying the trusted publishers, set each package's publishing access
to **Require two-factor authentication and disallow tokens** and revoke any npm
automation tokens. The initial local release is the only tokenless-OIDC
exception; all later releases come from the protected workflow.

## Required GitHub settings

Before merging the first automated release pull request:

- create a `release` environment, restrict it to `main`, and require an
  independent maintainer's approval when a second maintainer is available;
- enable immutable releases;
- enable private vulnerability reporting so `SECURITY.md` has a confidential
  intake path;
- keep the default workflow token read-only and allow GitHub Actions to create
  release pull requests;
- require actions to be pinned to full-length commit SHAs; and
- protect `main` with pull requests, code-owner review, and the CI, dependency
  review, and GitHub Actions security checks.

Do not use `pull_request_target` or `workflow_run` to work around permission
failures. Do not add a long-lived npm token to repository or organization
secrets.
