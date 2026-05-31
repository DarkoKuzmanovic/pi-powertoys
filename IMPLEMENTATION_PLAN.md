# IMPLEMENTATION PLAN — pi-powertoys parked ideas

Backlog of parked ideas. Nothing here is approved or scheduled. Some ideas reference archived toys and should be revalidated before implementation.

---

## Connection layer: session-recap ↔ observational memory

> Status: parked. `session-recap.ts` is archived under `archive/toys/`; any future work here should first decide whether to restore that toy or move the recap/memory bridge into `pi-memory` instead.

**Context.** Pi's observational-memory system (`OM`) compacts observations and reflections across sessions and exposes them via `recall(<id>)` and `/om-view`. `session-recap` reads the **live, uncompacted** last N messages of the current session and emits a 5–10 line "where we are / what's pending" summary.

Today they're parallel systems that don't talk:

- OM doesn't help mid-session resume — the current session isn't compacted yet.
- session-recap doesn't write to OM — every recap is thrown away after one turn.
- `recall` needs an explicit 12-char ID, so a recap can't surface "ah, this matches what you decided last week" without manual ID lookup.

There's a real bridge to build here. Sketching the design space below; pick one or combine.

### Idea A — Recap-as-reflection

When a recap is generated (manual `/recap` or auto), also emit a reflection-shaped record into OM with:

- `kind: "session-checkpoint"`
- `sessionId`, `branchId`, `timestamp`, `awayMinutes`
- the recap text
- references to the messages it covered (entry IDs or hashes)

**Why:** turns ephemeral recaps into queryable cross-session signal. "When did we last touch the auth refactor?" becomes a one-shot OM lookup.

**Open:** OM today is largely built from observations + automatic reflection. Are user-mode tools allowed to write reflections directly, or only via the compaction pipeline? Needs a peek at the OM internals before committing to a write path.

**Effort:** medium. Hinges on whether OM exposes a `pi.observationalMemory.addReflection(...)` (or similar) surface to extensions. If it doesn't, this becomes a feature request upstream first.

---

### Idea B — Recap reads OM for cross-session context

Before generating the recap, query OM for recent observations / reflections tied to the same project / cwd / branch. Prepend a "recent OM signal" block to the recap-LLM prompt so the recap can say:

> Returning to the auth refactor (last touched 3 sessions ago — see `om:f3a91c…`). In this session you stopped at `auth/session.ts:84` mid-edit. Pending: failing test for refresh-token expiry.

**Why:** today's recap only sees the live session. Cross-session memory is right there but unused.

**Open:** what's the OM query API for extensions? Is there a bounded "recent reflections in scope X" call, or only `recall(id)`?

**Effort:** medium. Same upstream-surface question as (A).

---

### Idea C — `/recap --persist`

A user-driven version of (A): manual `/recap` gets an optional flag that explicitly writes the result to OM. Auto-recap never persists. Keeps the design opt-in until OM-write semantics are clear.

**Why:** lowest-risk first step. Get the write path working for explicit user actions before deciding whether auto-recap should write too.

**Effort:** small once the OM write surface exists.

---

### Idea D — Recap as compaction seed

Instead of recap writing its own record, have the next compaction pass **prefer to keep** the messages a recap referenced. The recap becomes a hint to OM's compaction layer ("these messages mattered enough that the user needed a summary — don't drop them").

**Why:** avoids a new write path entirely; instead biases existing compaction.

**Open:** does compaction expose hooks for "weight these entries"? Probably not today. Likely requires upstream change.

**Effort:** high. Most invasive of the four.

---

### Recommendation order

1. **Start with (B)** — read-only, lowest blast radius, immediately useful even if (A/C/D) never ship.
2. **Then (C)** — explicit opt-in write, smallest behavior change.
3. **(A) auto-write** only after (C) has been used in anger for a while and the write shape is proven.
4. **(D)** parked unless OM exposes compaction-weight hooks.

### Prerequisites before any of this

- [ ] Confirm what OM exposes to extensions today. Read `@earendil-works/pi-coding-agent` exports for `observational`, `reflection`, `recall`, or similar.
- [ ] Confirm whether `pi.appendEntry` or a sibling API is the right write path, or whether OM has its own.
- [ ] Decide on a stable `kind` taxonomy for non-Pi-generated reflections so they don't collide with future Pi-native ones.
- [ ] Sketch the recap → OM record shape and circulate before coding.

### Out of scope (for this connection layer)

- Building a parallel memory store inside session-recap. OM is the system of record; recap should feed it, not duplicate it.
- Auto-tagging recaps with topics via a second LLM call. The recap text is already structured enough; topic extraction is a separate problem.
- Cross-vault / cross-machine sync. OM handles that (or doesn't) at its level.

---

## Other ideas (parking lot)

Add other powertoys-wide ideas below over time. Keep this file the single backlog for the repo.

_(nothing here right now — Pi-adjacent watch-list items live in the Obsidian vault under `Dev/Ideas/`.)_
