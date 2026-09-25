# Third-party architectural references

This ledger records **ideas and patterns** that shaped Agents Foundry. It is separate from
[third-party-code.md](third-party-code.md), which records copied source. An entry here means that
no code was copied. The design was reimplemented from our own contracts.

Licences are as understood when this ledger was written. Before any code is reused, re-verify the
licence at the exact commit you would copy from and add an entry to `third-party-code.md`.

| Project                                | Licence (to re-verify) | Patterns referenced                                                                              | Where in Agents Foundry                                   |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| OpenHands Software Agent SDK           | MIT                    | Event-sourced action/observation loop, confirmation pauses, context condensation, security analysis | Runtime event model, `WAITING_FOR_APPROVAL`, ADR 0006     |
| Microsoft Amplifier                    | MIT                    | Transport-independent runtime, expertise separated from engine, model routing, host configuration | Runtime protocol, role packages (ADR 0009), model profiles |
| Goose (Block)                          | Apache-2.0             | Desktop agent host, MCP extensions, provider independence                                          | Desktop/runtime separation, MCP design (future)          |
| Open SWE (LangChain)                   | MIT                    | Thread vs run separation, persistent workspace, follow-ups on the same thread                     | ADR 0008, `Workspace` contract                            |
| RoboCo                                 | AGPL (per brief)       | Task lifecycle, semantic role actions, server-side action choreography, review gates              | Action Gateway concept (ADR 0005), **inspiration only**   |

## Rules

1. Record every architectural inspiration here, even when no code is reused.
2. **AGPL projects (RoboCo)** may inform ideas only. No source, schema, prompt or test text from
   them may enter this repository without explicit written licensing approval.
3. Agents Foundry contracts must never import kernel or framework types (ADR 0006). This keeps
   every inspiration replaceable.
4. LangGraph Platform is intentionally not a dependency. Open SWE is referenced for patterns only.
