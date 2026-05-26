# Oracle Review: crof-models-toy

**Verdict:** Sound, proceed.

## Review

The plan satisfies all acceptance criteria from the brief:
- ✅ `/crof` fetches live, displays models
- ✅ Correct columns (Name, Quant, Max Out, Vision, Req, Speed)
- ✅ Sorted by speed descending
- ✅ All three filter flags implemented
- ✅ 10-min cache TTL
- ✅ Graceful error on fetch failure
- ✅ No third-party deps (Jina Reader is an HTTP endpoint, not a dependency)
- ✅ Extension registration in settings.json

## Issues flagged and resolved

1. **context-enforcer blocking** — Plan correctly identifies that `context-enforcer.ts` blocks `fetch()` in LLM tool calls, not in extension code. Extension `fetch()` calls run in the Pi runtime, not through the LLM tool chain. No mitigation needed.

2. **Model name parsing with spaces** — Plan acknowledges this ("kimi-k2.5-lightning beta", "glm-5.1-precision beta") and proposes parsing from both ends. This is the right approach. The regex `~\d+ t/s` anchor at the end, context/max pattern in the middle, and quant token before context numbers will correctly isolate the name even with spaces.

3. **Jina Reader dependency** — Not a code dependency (no npm install). If Jina Reader goes down, the graceful error path fires. Acceptable risk for a toy.

4. **Out-of-scope respected** — No existing toys modified, no third-party deps added, no TUI overlay complexity.

## No blocking issues found.
