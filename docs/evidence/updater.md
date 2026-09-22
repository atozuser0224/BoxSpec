# Trusted updater evidence

Date: 2026-09-22 (Windows 11 x64)

## Implemented boundary

`@boxspec/updater` implements the decision and recovery state machine. It does not download, install, launch, or remove software itself. Those effects are available only through injected, bounded ports for staging, Authenticode verification, active-selection switching, health checking, schema backup, journal persistence, and monotonic release history.

The signed envelope uses Ed25519 over `BoxSpec Release Manifest v1\n` followed by canonical JSON. Release public keys and Authenticode publisher identities are injected by the trusted composition root. Empty trust, an unknown key, a non-Ed25519 key, or an unknown publisher fails closed. No production identity or trust-on-first-use behavior is included.

The parser rejects duplicate JSON keys, unknown/missing fields, non-integer or unsafe numbers, oversized/deep JSON, non-canonical signatures, invalid time windows, unsafe Windows paths, traversal, ADS/device syntax, reserved aliases, normalization and case collisions. The signed artifact closure requires the application executable/archive, native safe-filesystem helper, verification manifest, verified browser executable, portable archive, and installer. Each entry binds path, role, scope, SHA-256, size, and (for executables) an injected publisher policy. The aggregate artifact-set digest also covers the sorted list.

Policy enforces an exact stable/beta channel, strictly increasing semantic version, a monotonically reserved channel sequence, and a signed data-schema compatibility window. Update selection proceeds through durable phases `PREPARING`, `STAGING`, `STAGED_VERIFIED`, `ACTIVATING`, `HEALTH_PENDING`, and `COMMITTED`. Schema-changing releases require a backup before activation. A failed health check or crash recovery restores the previous active selection and schema backup and discards the staged transaction. An active selection outside the two journaled identities blocks recovery.

## Verification

Commands were run directly using existing local tools; no package-manager command or install was used.

```text
node_modules/.bin/tsc.cmd -p packages/updater/tsconfig.json --pretty false
exit 0

node --test packages/updater/test/updater.test.mjs
10 tests, 10 pass, 0 fail
exit 0
```

The tests generate a fresh Ed25519 pair and cover a valid commit, absent trust, unsigned input, signed-content tampering, cross-channel input, downgrade, traversal and superscript device aliases, replay, partial staging, failed-health rollback, crash after activation, schema restore, and corrupt-journal refusal.

## Integration and release limits

Packaging must provide durable and atomic implementations of every port and inject the production release public key and exact Authenticode publisher certificate policy. The current package provides no network transport, feed URL, signing service, production public key, installer mutation, executable launch, or update campaign. Therefore this evidence does not claim that production updating is available. A real packaged update remains blocked until the packaging composition supplies and tests those ports against versioned per-user installation directories and a signed external release campaign.

The monotonic sequence is reserved before the first journal write. A process crash in that narrow interval safely consumes the sequence without mutating installation state, but requires an operator to issue a higher signed sequence. Journal checksums detect accidental corruption; journal authenticity and access control depend on the trusted application-state storage supplied by packaging.
