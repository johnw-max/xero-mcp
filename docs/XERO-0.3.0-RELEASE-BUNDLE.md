# Xero 0.3.0 source release bundle

This bundle is the minimal, reproducible source input for rebuilding Xero MCP 0.3.0 on a controlled server. It is not a server backup and contains no runtime environment, database data, OAuth token, TLS key, compiled `dist`, or installed dependency.

## Generate

From the repository root:

```bash
node scripts/release/build-xero-release-bundle.mjs \
  --output-dir /tmp/xero-0.3.0-release-candidate
```

The command produces exactly three release artifacts:

- `xero-accounting-mcp-0.3.0-source.tar.gz`
- `xero-accounting-mcp-0.3.0-source.manifest.json`
- `xero-accounting-mcp-0.3.0-source.sha256`

The checksum file covers both the archive and its manifest. The generator normalizes ordering, file modes, tar metadata, and gzip time. `SOURCE_DATE_EPOCH` defaults to `0`; a non-negative value can be supplied through the environment or `--source-date-epoch`.

## Verify

```bash
node scripts/release/verify-xero-release-bundle.mjs \
  --archive /tmp/xero-0.3.0-release-candidate/xero-accounting-mcp-0.3.0-source.tar.gz \
  --manifest /tmp/xero-0.3.0-release-candidate/xero-accounting-mcp-0.3.0-source.manifest.json \
  --checksum /tmp/xero-0.3.0-release-candidate/xero-accounting-mcp-0.3.0-source.sha256
```

Verification fails closed on checksum drift, unsafe tar paths, links or non-regular entries, unmanifested files, missing runtime inputs, per-file hash/mode drift, forbidden local files, known credential formats, populated secret assignments, or the legacy personal hostname.

## Inclusion boundary

The release uses a runtime-source allowlist rather than treating `.gitignore` as a release policy. It includes:

- `package.json`, lockfile, and TypeScript build configuration;
- production `src` files, excluding colocated tests;
- database migrations and the tool allowlist;
- Dockerfile, current Compose definitions, generic Nginx configuration, current host-Nginx configuration, the release runbook, active static verifier, and the upstream switch helper;
- the two audited placeholder environment templates and the tool-contract fixture required by the active static verifier;
- the Xero write-gate and duplicate-preflight operator scripts required by the release runbook.

It excludes:

- `.git`, `node_modules`, `dist`, coverage, output, tmp, UAT, test-results, and all artifact/evidence directories;
- all tests, harness data, product documents, historical release packages, and local operator scripts not required to rebuild the service;
- every populated runtime `.env`, `.env.local`, `*.local`, VPS environment file, certificate, key, keystore, and private-key format; only the two required placeholder-only templates are permitted;
- the legacy personal-domain host configuration and files that retain that hostname solely for historical validation.

The local generator, verifier, and shared release library under `scripts/release` are deliberately not included in the archive. They remain on the release operator's machine and cannot disclose their scan implementation or historical-domain fingerprinting logic to the recipient.

The repository's `.gitignore` already excludes dependency/build outputs, local environment files, logs, and key material. `.dockerignore` additionally excludes artifacts, output, tmp, and Git. The release allowlist is intentionally tighter so a historical UAT record or prior release cannot enter a new package by accident.

## Server-side boundary

The archive deliberately has no `node_modules` or `dist`. A controlled server rebuild installs dependencies from the lockfile and runs the existing build command. Runtime secrets remain in the server-owned environment and must never be copied into the extracted release directory.

The scanner is a deterministic release gate for known secret formats and assignment patterns; it is not a substitute for organisation-wide credential scanning or secret rotation.
