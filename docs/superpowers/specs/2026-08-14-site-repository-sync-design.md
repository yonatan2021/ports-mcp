# Site repository synchronization

## Goal

Keep the Port Manager marketing site in a dedicated private repository,
`yonatan2021/Ports`, while retaining `ports-mcp` as the single source of truth
for site source files and product releases.

## Architecture

- The source site remains in `site/` in this repository.
- A GitHub Actions workflow runs on pushes to `main` that modify `site/**` or
  the sync workflow itself, and can also be run manually.
- The workflow checks out the target repository with a fine-grained personal
  access token stored as `PORTS_SITE_SYNC_TOKEN` in this repository's Actions
  secrets. The token is restricted to `yonatan2021/Ports` and has Contents
  read/write access.
- It replaces only the target repository's managed site files, commits if there
  is a change, and pushes to the target default branch. It must never copy
  source-repository configuration, credentials, or application code.
- Vercel is connected to `yonatan2021/Ports`; its ordinary Git integration
  deploys the pushed commit.

## Target repository contents

The managed files are the source website assets and scripts from `site/`, a
minimal package manifest and lockfile needed to run the site build, and the
static deployment configuration. The build continues to read the public latest
release from `yonatan2021/ports-mcp`, so download links stay current without
duplicating desktop release artifacts.

## Safety and failure behavior

- The workflow requires the token only at GitHub Actions runtime; it is never
  committed or printed.
- The sync fails clearly when the secret is absent or cannot write to the
  target repository.
- A manual workflow dispatch allows a retry after changing a secret or target
  repository configuration.
- Target-repository changes outside the managed files are preserved.

## Verification

Run the existing `site:test` test suite and validate workflow YAML before
committing. After the secret is configured, invoke the workflow manually and
confirm a commit appears in `yonatan2021/Ports`, which triggers Vercel.
