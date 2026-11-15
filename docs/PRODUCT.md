# Roppo product overview

## Purpose

Roppo is a local-first multi-agent workspace. Users communicate with a Router; independent Workers carry out delegated tasks and return results through it. The interface distinguishes configuration, actual execution and supporting evidence.

## Current scope

One local personal account is supported per deployment. Built-in Chat, connected software and CLI clients provide conversation entry points. Organization identity, roles and multi-tenant access remain future work; changing a workspace label does not create a security boundary.

The TypeScript host serves the authenticated workspace. The built-in Chat uses React, while existing configuration surfaces retain their controllers and revisioned save flow. API, subscription and CLI connections have different capabilities and authorization requirements. Unsupported capabilities must remain visibly unavailable rather than appearing saved or active.

See the [README status and boundaries](../README.md#current-scope), [configuration guide](CONFIGURATION.md), and [backend guide](BACKENDS.md) for supported behavior and verification limits.

## Users and workflow

Individuals and organizations are both intended audiences; the currently supported deployment model is a single personal account. A Router coordinates independently configured Workers, connections and tasks. Common settings should not require provider request JSON; advanced users can inspect supported parameters when needed.

Organizational collaboration is a product direction, not a claim of implemented tenant isolation. It requires explicit identities, permissions and server-enforced scope.

## Design principles

- One user-facing coordinator, with clearly identified execution agents.
- Common settings first; advanced controls in context.
- Configuration, execution and evidence remain distinct states.
- Authorization is enforced by the host, not inferred from interface labels.
- Motion explains a selection or a real execution event.
- Concise bilingual controls, a white default theme and a switchable dark theme.
- No decorative activity, unsupported metrics or simulated success.

The [design reference](DESIGN.md) records visual conventions and dated interface changes. The [roadmap](ROADMAP.md) separates discussion priorities from implemented scope.

## Implementation lineage

The task and continuation semantics derive from DeepSeek SuperAgent. This is implementation provenance, not a claim of superiority or an exclusive differentiator. See [core provenance and extension boundaries](PARITY.md) and the repository's [third-party notices](../THIRD_PARTY.md).
