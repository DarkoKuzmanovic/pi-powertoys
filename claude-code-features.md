# Claude Code Features Research

**Research Date:** 2026-05-09  
**Purpose:** Comprehensive list of user-facing features that could be implemented as extensions/plugins for Pi coding agent.

---

## Summary

Claude Code offers 40+ built-in slash commands, a 12-event hook system for automation, multi-tier memory (CLAUDE.md, auto-memory, session summaries), subagents for parallel execution, and rich permission/settings management. The VS Code extension adds inline diffs, @-mentions, and panel-based chat. Most features are implementable in Pi via extensions.

---

## Findings

### 1. Slash Commands and Built-in Commands

Claude Code has 40+ built-in slash commands organized by category:

#### Context Management Commands
| Command | Description | Pi Implementation Potential |
|---------|-------------|----------------------------|
| `/clear` | Start new conversation with empty context (aliases: `/reset`, `/new`) | ✅ Easy |
| `/compact` | Replace conversation with structured summary, freeing context | ✅ High value |
| `/context` | Show current context usage and token count | ✅ Easy |
| `/add-dir <path>` | Add directory to allowed read/write paths | ✅ Medium |

#### Session Management Commands
| Command | Description | Pi Implementation Potential |
|---------|-------------|----------------------------|
| `/resume` | Resume most recent session (alias: `--continue`, `-c`) | ✅ High value |
| `/branch [name]` | Create session branch from current point | ✅ Medium |
| `/fork` | Create independent copy of session | ✅ Medium |
| `/rewind` | Go back to previous state in conversation | ⚠️ Complex |
| `/undo` | Undo last action | ⚠️ Complex |

#### Model and Effort Commands
| Command | Description | Pi Implementation Potential |
|---------|-------------|----------------------------|
| `/model [name]` | Switch AI model for session | ✅ Easy |
| `/effort [low\|medium\|high]` | Set effort level for responses | ✅ Easy |
| `/fast` | Quick mode for simple queries | ✅ Easy |

#### Review and Diff Commands
| Command | Description | Pi Implementation Potential |
|---------|-------------|----------------------------|
| `/diff` | Show pending changes | ✅ Easy |
| `/review` | Review changes before applying | ✅ High value |
| `/security-review` | Security-focused code review | ✅ Medium |
| `/ultrareview` | Comprehensive review | ✅ Medium |

#### Permissions and Access Commands
| Command | Description | Pi Implementation Potential |
|---------|-------------|----------------------------|
| `/permissions` | Configure tool permissions interactively | ✅ High value |
| `/allowed-tools` | Configure which tools Claude can use | ✅ High value |
| `/sandbox` | Configure sandbox settings | ✅ Medium |
| `/config` | Interactive settings configuration | ✅ High value |

#### Utility Commands
| Command | Description | Pi Implementation Potential |
|---------|-------------|----------------------------|
| `/help` | Show all commands + custom commands | ✅ Easy |
| `/color [color\|default]` | Set prompt bar color for session | ✅ Easy |
| `/chat` | Switch to chat mode | ✅ Easy |
| `/btw <question>` | Ask quick question without affecting context | ✅ Easy |

#### Task Execution Commands
| Command | Description | Pi Implementation Potential |
|---------|-------------|----------------------------|
| `/batch <instruction>` | Run batch of operations | ✅ Medium |
| `/autofix-pr [prompt]` | Auto-fix PR issues | ⚠️ Complex |
| `/agents` | Manage subagents | ✅ Medium |

[Commands Reference](https://code.claude.com/docs/en/commands)

---

### 2. Session Management Features

#### Session Lifecycle
- **Interactive mode**: `claude` starts persistent session
- **One-time task**: `claude "task"` runs single task and exits
- **Print mode**: `claude -p "query"` runs query, prints output, exits
- **Continue last session**: `claude -c` or `--continue`
- **Session resumption**: Sessions stored in `~/.claude/projects/<hash>/`

#### Session State
- Sessions persist across restarts
- Each project has unique hash-based directory
- Session summaries auto-generated for long sessions
- `/resume` restores conversation history

#### CLI Flags for Session Control
| Flag | Description |
|------|-------------|
| `--max-turns N` | Limit agentic turns (print mode) |
| `--model NAME` | Set model for session |
| `--mcp-config FILE` | Load MCP servers from JSON |
| `--init-only` | Run setup hooks only |
| `--verbose` | Enable verbose output |

[CLI Reference](https://code.claude.com/docs/en/cli-reference)

**Pi Implementation:** Session persistence and resume would be high-value additions.

---

### 3. Context Management Features

#### Context Window Exploration
- Token usage displayed in status bar
- Warning at 80% context usage
- `/compact` summarizes conversation to free space
- Automatic reloading of startup context after compact

#### Context Tiers
1. **Project-level**: `CLAUDE.md` at repo root
2. **Subdirectory-level**: `CLAUDE.md` in subfolders for module-specific context
3. **User-level**: `~/.claude/CLAUDE.md` for personal preferences

#### Context Optimization Strategies
- Keep `CLAUDE.md` under 300 lines
- Use `/compact` before hitting 80% context
- Strategic task chunking for large projects
- File access limits to reduce token load

[Context Window Docs](https://code.claude.com/docs/en/context-window)

**Pi Implementation:** Context usage display and compact/summarize feature would be valuable.

---

### 4. Developer Experience Features

#### Hooks System (12 Events)

Claude Code hooks run shell commands or scripts at specific lifecycle events:

| Event | When It Fires | Can Block? | Best Use |
|-------|---------------|------------|----------|
| `SessionStart` | Session begins or resumes | No | Load context, set env vars |
| `Setup` | `--init-only` or init mode | No | CI preparation |
| `UserPromptSubmit` | User hits enter, before processing | Yes | Context injection, validation |
| `PreToolUse` | Before tool executes | Yes | Security blocking, auto-approve |
| `PermissionRequest` | Permission dialog appears | Yes | Auto-approve patterns |
| `PostToolUse` | After tool completes | No | Format code, notifications |
| `AfterResponse` | After Claude responds | No | Logging, analytics |
| `UserPromptExpansion` | Skill/custom command expansion | Yes | Prompt transformation |
| `Stop` | Session ends | No | Cleanup, save state |
| `SessionCompact` | Context is compacted | No | Update external memory |
| `Error` | Error occurs | No | Error logging, alerts |
| `Maintenance` | Maintenance mode | No | Health checks |

[Hooks Reference](https://code.claude.com/docs/en/hooks)

#### Hook Configuration Example
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{
          "type": "command",
          "command": "jq -r '.tool_input.file_path' | xargs npx prettier --write"
        }]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [{
          "type": "command",
          "command": "osascript -e 'display notification \"Claude needs attention\"'"
        }]
      }
    ]
  }
}
```

**Pi Implementation:** Hooks system is directly implementable and high-value.

#### Custom Commands (Skills)
- `.claude/commands/deploy.md` creates `/deploy` command
- `.claude/skills/deploy/SKILL.md` same effect (merged feature)
- Skills can include prompts, examples, constraints
- `/help` shows all custom commands

**Pi Implementation:** Custom slash commands via markdown files would be excellent.

---

### 5. Memory and Project Knowledge Features

#### Multi-Tier Memory System

| Memory Type | Location | Purpose | Persistence |
|-------------|----------|---------|-------------|
| **CLAUDE.md** | Project root | Project context, conventions | Git-tracked |
| **CLAUDE.local.md** | Project root | Private preferences (gitignored) | Local only |
| **Auto-Memory** | `~/.claude/projects/<hash>/memory/` | Auto-extracted facts | Per-project |
| **Session Summaries** | `~/.claude/projects/<hash>/` | Conversation summaries | Per-session |
| **User Memory** | `~/.claude/CLAUDE.md` | Cross-project preferences | Global |
| **Managed Policy** | System-level (OS-specific) | Enterprise policies | Admin-managed |

#### Auto-Memory Features
- **Automatic extraction**: Claude extracts facts during conversation
- **Categorized**: Memories tagged as `user`, `feedback`, `decision`, `pattern`
- **Semantic organization**: One file per fact, organized by topic
- **Browsable**: `ls ~/.claude/projects/<hash>/memory/`
- **Editable**: Plain markdown files can be edited manually

#### Session Memory Inspection
```bash
# Find project memory directory
ls ~/.claude/projects/

# List sessions for project
ls ~/.claude/projects/<project-hash>/

# Read session summary
cat ~/.claude/projects/<hash>/summary.md
```

[Memory Docs](https://code.claude.com/docs/en/memory)

**Pi Implementation:** Multi-tier memory with auto-extraction would be transformative.

---

### 6. Unique UX Features

#### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+C` | Cancel current operation |
| `Ctrl+D` | Exit session (EOF) |
| `Ctrl+L` | Clear screen (keeps history) |
| `Ctrl+O` | Toggle verbose output |
| `Ctrl+R` | Search command history |
| `Ctrl+V` | Paste image from clipboard |
| `Ctrl+B` | Background current operation |
| `Ctrl+_` / `Ctrl+Shift+-` | Undo last action |
| `Ctrl+G`, `Ctrl+X Ctrl+E` | Open in external editor |
| `Ctrl+S` | Stash current prompt |
| `Escape` | Cancel / close dialog |
| `Shift+Tab` | Cycle permission modes (Normal → Auto-Accept → Plan) |
| `Esc+Esc` | Rewind to previous state |
| `Tab` | Extended thinking toggle |

[Keybindings Docs](https://code.claude.com/docs/en/keybindings)

#### Permission Modes
- **Normal**: Ask for each tool use
- **Auto-Accept**: Auto-approve allowed tools
- **Plan**: Show plan before execution
- Cycle with `Shift+Tab` or `Alt+M`

#### Bash Escape
- `!` prefix runs bash command immediately
- `! git status` bypasses Claude interpretation
- Raw output added to context

#### VS Code Extension Features
- **Inline diffs**: See changes directly in editor
- **@-mentions**: `@file.py` to reference files
- **Panel chat**: Dedicated sidebar panel
- **Slash commands**: All CLI commands available
- **Plan review**: Visual plan approval
- **Current workspace awareness**: Auto-includes open files

[VS Code Integration](https://code.claude.com/docs/en/ide-integrations)

**Pi Implementation:** Keyboard shortcuts and permission modes are implementable.

---

### 7. Subagents and Parallel Execution

#### Subagent Patterns
- **Parallel execution**: Spawn multiple subagents for independent tasks
- **Domain-based splitting**: Different subagents for different domains
- **Zero context inheritance**: Subagents start fresh (by design)
- **Parent keeps clean context**: Child does focused work

#### Usage Examples
```
# Parallel research
"Research these 5 companies in parallel using separate sub-agents..."

# Parallel codebase exploration
"Explore the codebase using 4 tasks in parallel..."
```

#### Configuration
- `CLAUDE_CODE_FORK_SUBAGENT` env var for fork behavior
- `/agents` command to manage subagents
- `/batch` for sequential batch operations

[Subagents Guide](https://code.claude.com/docs/en/sub-agents)

**Pi Implementation:** Subagent spawning would require session management but is feasible.

---

### 8. Settings and Permissions

#### Settings Location
- **User settings**: `~/.claude/settings.json`
- **Project settings**: `.claude/settings.json` in project
- **Managed settings**: System-level (enterprise)

#### Permission Rule Syntax
```json
{
  "projects": {
    "/path/to/project": {
      "allowedTools": ["Read", "Grep", "Edit"],
      "permissions": {
        "allow": ["Bash(git diff *)", "Edit(**/*.ts)"],
        "ask": ["Bash(git push)", "Edit(src/critical/**)"],
        "deny": ["Bash(rm -rf *)"]
      }
    }
  }
}
```

#### Sandbox Configuration
```json
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "excludedCommands": ["docker "],
    "filesystem": {
      "allowWrite": ["/tmp/build", "~/.kube"],
      "denyRead": ["~/.aws/credentials"]
    },
    "network": {
      "allowedDomains": ["github.com", ".npmjs.org"],
      "deniedDomains": ["malicious.com"]
    }
  }
}
```

[Settings Docs](https://code.claude.com/docs/en/settings)

**Pi Implementation:** Permission system and sandbox config are high-value targets.

---

### 9. MCP (Model Context Protocol) Integration

#### MCP Tool Integration
- Add servers via CLI: `claude mcp add <name> --transport http <url>`
- Local stdio servers: `claude mcp add <name> --type stdio --command node <path>`
- Config via `--mcp-config` flag or settings

#### Custom Tools via SDK
- Python: `@tool` decorator
- TypeScript: `tool()` function
- Register via `create_sdk_mcp_server`

[Custom Tools Docs](https://code.claude.com/docs/en/agent-sdk/custom-tools)

**Pi Implementation:** MCP compatibility would enable tool ecosystem.

---

## Sources

### Kept (Primary/Authoritative)
- [Claude Code Commands Reference](https://code.claude.com/docs/en/commands) — Official command list
- [Hooks Reference](https://code.claude.com/docs/en/hooks) — Official hook events
- [Settings Documentation](https://code.claude.com/docs/en/settings) — Official settings schema
- [Context Window Docs](https://code.claude.com/docs/en/context-window) — Official context management
- [Memory Documentation](https://code.claude.com/docs/en/memory) — Official memory system
- [CLI Reference](https://code.claude.com/docs/en/cli-reference) — Official CLI flags
- [Keybindings Docs](https://code.claude.com/docs/en/keybindings) — Official shortcuts
- [Subagents Guide](https://code.claude.com/docs/en/sub-agents) — Official subagent docs
- [Custom Tools Docs](https://code.claude.com/docs/en/agent-sdk/custom-tools) — Official SDK tools

### Kept (Secondary/Community)
- [SFEIR Institute - Slash Commands Cheatsheet](https://institute.sfeir.com/en/claude-code/claude-code-essential-slash-commands/cheatsheet/) — Comprehensive command reference
- [Shipyard Build - Claude Code Cheatsheet](https://shipyard.build/blog/claude-code-cheat-sheet/) — Quick reference
- [Blake Crosley - Claude Code Cheatsheet 2026](https://blakecrosley.com/guides/claude-code-cheatsheet) — Keyboard shortcuts
- [Lead Gen Jay - Hooks Guide](https://leadgenjay.com/learn-claude-code/hooks) — Hook events summary
- [Claude Fast - Context Management](https://claudefa.st/blog/guide/mechanics/context-management) — Token optimization
- [Kjetil Furas - Subagents Guide](https://kjetilfuras.com/claude-code-subagents/) — Subagent patterns

### Dropped
- YouTube videos — Not citable text sources
- Reddit threads — Anecdotal, not authoritative
- VS Code extension marketplace listings — Not core Claude Code features
- Generic AI blog posts without specific Claude Code details

---

## Gaps

### Could Not Confidently Answer
1. **Exact token limits** — Varies by model, no single number in docs
2. **All 40+ slash commands** — Some commands mentioned but not fully documented
3. **Auto-memory extraction rules** — What triggers memory creation is not fully specified
4. **Hook input/output schemas** — Detailed JSON schemas for each hook event not fully documented

### Suggested Next Steps
1. Run `claude` locally and use `/help` to get complete command list
2. Inspect `~/.claude/` directory structure for actual memory file formats
3. Review Claude Code GitHub repo for hook type definitions
4. Test MCP server integration for tool capabilities

---

## Implementation Priority for Pi Extensions

### High Priority (Direct value, clear implementation)
1. **Hooks system** — 12 lifecycle events for automation
2. **Custom slash commands** — Markdown-based command definitions
3. **Context compact/summarize** — `/compact` equivalent
4. **Permission modes** — Normal/Auto-Accept/Plan cycling
5. **Session resume** — Persist and restore sessions

### Medium Priority (Valuable but more complex)
6. **Multi-tier memory** — CLAUDE.md + auto-memory
7. **Subagents** — Parallel task execution
8. **Context usage display** — Token percentage in UI
9. **Sandbox configuration** — Filesystem/network restrictions

### Lower Priority (Nice-to-have)
10. **Keyboard shortcuts** — Terminal UX improvements
11. **VS Code-style inline diffs** — Requires editor integration
12. **MCP tool registry** — External tool ecosystem
