# Compaction Context Recovery Plugin for OpenClaw

Preserves recent conversation context across compaction cycles, solving the "I don't know what 'all three' refers to" problem.

## Installation

```bash
openclaw plugins install openclaw-compaction-context
```

Then restart your gateway.

## The Problem

When OpenClaw compacts a long session to free up context space, the agent loses access to recent conversation details. You might ask a follow-up question and get:

> "Hey — context got wiped in a compaction and the summary didn't survive. I don't have what 'all three' refers to."

## The Solution

This plugin hooks into the compaction lifecycle:

1. **Before compaction** (`before_compaction` hook):
   - Reads the current session's JSONL transcript
   - Extracts the last N user/assistant messages
   - Writes them to `RECENT.md` in the workspace
   - Sets a `.compaction-recovery-pending` flag

2. **After compaction, on next turn** (`before_agent_start` hook):
   - Checks if the flag exists (meaning compaction just happened)
   - If yes, reads `RECENT.md` and injects it as `prependContext`
   - Clears the flag so subsequent turns don't re-inject

## Configuration

```json
{
  "plugins": {
    "entries": {
      "openclaw-compaction-context": {
        "enabled": true,
        "config": {
          "messageCount": 20,
          "maxCharsPerMessage": 500
        }
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `messageCount` | 20 | Number of recent messages to preserve |
| `maxCharsPerMessage` | 500 | Truncate long messages to this limit |

## Files Created

- `RECENT.md` — The preserved context (overwritten each compaction)
- `.compaction-recovery-pending` — Flag file (deleted after injection)

## Token Budget

With defaults (20 messages × 500 chars), worst case is ~10K characters (~2.5K tokens) injected once after compaction. In practice it's usually much less since most messages are short.

## Why This Approach?

- **No constant overhead** — Only runs when compaction actually happens
- **Uses existing hooks** — No custom OpenClaw patches needed
- **Automatic** — No manual intervention required
- **Configurable** — Tune message count and truncation to your needs

## License

MIT
