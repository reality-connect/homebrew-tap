# Homebrew Tap — Reality Connect

Homebrew formulae and casks for Reality Connect's releases, generated from the project's signed GitHub Releases in the public publisher repo.

## What this tap serves

| Package | Type | Covers |
|---|---|---|
| `seed` | formula | the `seed` CLI — macOS Apple Silicon, macOS Intel, Linux x86_64 |
| `seed-desktop` | cask | the **Seed Desktop** macOS app — Apple Silicon + Intel (DMG) |

## Install

```sh
brew tap reality-connect/tap
brew install seed                # CLI
brew install --cask seed-desktop # desktop app (macOS)
```

## How it is generated

The formula and cask are **generated per release** by `scripts/release-homebrew.ts` in the source repository: the channel manifest and the release's signed `SHA-256SUMS` are fetched from the public publisher repo, the checksums document's minisign signature is verified against the project's published artifact key, and the files are rendered with the canonical `<project>-v<version>` asset URLs and the documented sha256. The tap **never re-signs anything** — it wraps the publisher's already-signed artifacts (one signature per artifact, the artifact minisign key).

## Policy

- **Stable-first.** The tap tracks the **stable** channel by default policy. Beta/nightly versions are allowed — they are the only releases before the first stable — but once a stable release exists, the tap points at stable.
- **Update cadence: per release.** Every published release updates the formula/cask (version + sha256) to that release. This tap currently serves `1.0.0-beta.2`, the live beta release at generation time.
- **No moving binaries.** The tap wraps immutable version releases; updates flow through the signed in-app/in-CLI channels (`seed update`, app updates), exactly as documented in the project's [install guide](https://github.com/reality-connect/new-seed/blob/develop/docs/ops/install.md).
