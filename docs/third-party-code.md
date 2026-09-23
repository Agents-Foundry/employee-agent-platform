# Third-party code ledger

Every file (or substantial fragment) copied or adapted from another project must be recorded
here **before** it is merged. Package dependencies installed through npm/cargo are tracked by the
lockfiles and do not need entries unless they are vendored or modified.

## Required fields per entry

| Field                  | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| Source repository      | URL and exact commit SHA                                      |
| Licence                | SPDX identifier, verified at that commit                      |
| Files reused           | Source paths → destination paths in this repository           |
| Modifications          | Summary of changes                                            |
| Attribution required   | Notice text and where it is reproduced                        |
| Compatibility decision | Who approved, and why the licence is compatible               |

## Entries

_None._ As of Architecture V2 Phase A, no third-party source code has been copied into this
repository. Architectural inspirations are listed in
[third-party-architecture.md](third-party-architecture.md).

## Prohibited without explicit licensing approval

- AGPL, SSPL, BUSL or other network-copyleft or source-available code (including RoboCo).
- Code with no licence, or with unclear provenance. Prefer a clean-room reimplementation.
