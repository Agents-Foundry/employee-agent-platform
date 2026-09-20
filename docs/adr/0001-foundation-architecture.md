# ADR 0001: Split control plane and employee desktop

- Status: Accepted
- Date: 2026-09-20

## Context

Agents Foundry needs centralized organizational governance while employees use a focused, native agent window on Windows, Linux, and macOS.

## Decision

Use an Angular SaaS admin control plane and an Angular application packaged with Tauri 2 for the employee experience. Both use a Node control-plane API. Conversations and policy state are stored centrally. Secrets live in an external vault and are referenced, never copied, by the application database.

## Consequences

- Organization administrators can govern assignments, policies, approvals, and audit data centrally.
- Employee UX remains desktop-native without embedding privileged policy logic.
- Native packaging adds Rust/toolchain requirements.
- Offline conversation mutation is not supported in the first POC; the control plane remains authoritative.
