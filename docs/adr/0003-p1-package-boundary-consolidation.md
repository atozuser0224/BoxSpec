# ADR 0003: Consolidate early P1 package boundaries around working ownership

- Status: accepted for P1
- Date: 2026-09-22

## Context

The production plan sketches separate `contracts`, `editor-domain`, `layout-engine`, `compiler-web`, `verifier-web`, and `shared-ui` packages. During the first executable vertical slice, those boundaries had not yet acquired independent release cycles or dependency surfaces. Creating empty packages would make the planned tree appear complete without producing a runnable product and would add cross-package migrations while security-sensitive contracts were still stabilizing.

## Decision

P1 publishes shared wire/domain contracts through `@boxspec/shared`. Contract validation, canonicalization, editor commands and history, layout semantics, and the deterministic managed-React compiler remain cohesive modules in `@boxspec/core`. Electron editor components and their private presentation primitives remain in `@boxspec/desktop`. Web verification is implemented by `@boxspec/verifier`.

The implementation creates a package when it has an independently useful authority or dependency boundary. Current examples are `@boxspec/change-manager`, `@boxspec/local-ipc`, `@boxspec/themes`, `@boxspec/project-index`, `@boxspec/adopted-web`, and `@boxspec/updater`. No empty compatibility package is scaffolded solely to mirror the plan diagram.

## Consequences

Core stays framework-free and deterministic; desktop remains the only React/Electron UI package; verifier code and candidate execution remain outside Core. Public imports use package export maps, while internal modules preserve seams that can later move to `editor-domain`, `layout-engine`, `compiler-web`, or `shared-ui` without changing the runtime service contracts or serialized identities.

A later split requires byte-stable canonicalization/compiler output, migration tests for persisted commands and contracts, unchanged single-writer authority, and the same verification and approval hashes. P1 evidence names the implemented module paths rather than claiming that absent planned packages exist.
