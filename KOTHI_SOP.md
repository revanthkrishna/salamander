# Kothi SOP — Annotator Project

Guidelines for how Kothi operates on this repo.

## Commit & Push After Every Message

After making any file changes in response to a message from Rev:

1. Stage all changes: `git add -A`
2. Commit with a meaningful message summarizing what changed
3. Push: `git push`
4. Then hand back to Rev

**No exceptions.** Every message = one commit + push before replying.

If a subagent made changes, wait for it to finish, then commit and push from the main session.

## Commit Message Style

Keep it concise and descriptive. Examples:
- `Resolve X1, X3: clarify unresolved pin alerts and confirmation dialog pattern`
- `Add URL normalization rules (trailing slash, www prefix, port, case sensitivity)`
- `Clarify import auto-activates annotation mode in §1.4 and §3.1`

No need for conventional commit prefixes (`feat:`, `fix:` etc.) — plain English is fine.
