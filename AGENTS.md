# Agent Notes

## Documentation

Keep short, maintained instructions and essential architectural constraints
alongside the code.

Put secondary, agent-optimized context in `agent-notes/` as outlined below. The
notes should be kept relevant and maintained, with a concise index in
`agent-notes/README.md`. For reports and other documents specifically requested
by and written for humans, use the `agent-notes/reports/` subdirectory. That
subdirectory should also be kept relevant and maintained, but in general, ask
before removing or overwriting historical notes there. (No specific permission
is needed to maintain the rest of `agent-notes/`.)

Instead of creating or maintaining a top-level `README.md`, please keep usage
instructions at `agent-notes/usage.md`.

### Persistent Agent Context

Save useful agent-generated context in `agent-notes/`, not `docs/`. These notes
are agent-generated and are not necessarily reviewed or endorsed by the
repository owner.

Keep only context that will help future work:

- Decision rationale, constraints, and rejected alternatives.
- Investigations, reproducible measurements, and non-obvious findings.
- Unresolved questions with enough evidence to resume investigation.

Avoid routine completion summaries, code inventories, duplicated instructions,
and speculative plans unless specifically requested.

Each substantive note should include:

- Date and relevant source commit.
- Status: proposal, observation, accepted decision, or superseded.
- Evidence: relevant files, commands, measurements, or sources.
- Known uncertainties and conditions that would invalidate its conclusions.

Do not label a decision accepted without explicit approval or clear evidence
that it has been adopted.

Maintain a concise index in `agent-notes/README.md`, with a one-line description
of each note. Read the index when relevant and load only notes needed for the
current task.

Treat notes as historical context, not authoritative descriptions of current
behavior. Verify claims against current code. When revisiting a topic, update or
supersede existing notes rather than creating overlapping accounts. Preserve
historical measurements with their original conditions.

Keep essential project instructions in `AGENTS.md` and durable implementation
constraints close to the relevant code or tests.
