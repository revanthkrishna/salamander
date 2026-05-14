# Annotator — Build Plan

> **Created:** 2026-05-14  
> **Target:** All code complete by Fri 2026-05-15 08:00 UTC  
> **Model:** Agent-orchestrated parallel build

---

## Overview

The Annotator Chrome extension is built across 6 phases. Phases 1 and 2 are heavily parallelized; later phases are sequential (integration → review → test → polish). All agents work in the same git repo at `/root/.openclaw/workspace/annotator`. Every agent must commit and push at the end of their run.

---

## Phase Breakdown

### Phase 1 — Foundation (Parallel, Start: 21:57 UTC)

Two agents run simultaneously. Both must complete before Phase 2 begins (~22:30 UTC).

| Agent | Duration Est. | Description |
|-------|--------------|-------------|
| UX Designer | ~30 min | Pixel-level UX spec: toolbar states, popover, pins, alerts, copy text |
| Project Setup Engineer | ~30 min | Full project scaffold, manifest, tsconfig, esbuild, entry stubs, `npm run build` passes |

**Phase 1 dependency:** None (starts immediately)  
**Phase 2 unblocked when:** Both Phase 1 agents have committed and pushed.

---

### Phase 2 — Implementation (Parallel, Start: 22:35 UTC)

Seven agents run in parallel. All implement distinct modules with minimal overlap. Agents should not block each other — each owns specific files.

| Agent | Duration Est. | Files Owned | Dependencies |
|-------|--------------|-------------|--------------|
| Storage & Types Engineer | ~45 min | `src/types.ts`, `src/storage.ts`, `src/urlNorm.ts` | Project Setup |
| Fingerprinting Engineer | ~60 min | `src/fingerprint.ts` | Project Setup |
| Background Worker Engineer | ~40 min | `src/background.ts` | Project Setup |
| Toolbar + UI Engineer | ~75 min | `src/toolbar.ts` | Project Setup, UX_DESIGN.md |
| Pin Rendering Engineer | ~50 min | `src/pinRenderer.ts` | Project Setup |
| Annotation Popover Engineer | ~60 min | `src/annotationMode.ts` (partial: popover) | Project Setup, UX_DESIGN.md |
| Import/Export Engineer | ~75 min | `src/importExport.ts` | Project Setup |

**File ownership is strict** — no agent writes a file owned by another. Each agent writes stubs/no-ops for interfaces they depend on but don't own. The Integration Engineer reconciles everything.

**Phase 2 dependency:** Phase 1 both complete  
**Phase 3 unblocked when:** All 7 Phase 2 agents committed.

---

### Phase 3 — Integration (Sequential, Start: 01:30 UTC)

One integration engineer wires all modules together, resolves import/type mismatches, ensures `npm run build` passes cleanly, and does a full requirements self-review.

| Agent | Duration Est. | Description |
|-------|--------------|-------------|
| Integration Engineer | ~75 min | Wire modules, fix build errors, resolve API mismatches, verify requirements coverage |

**Phase 3 dependency:** All Phase 2 complete

---

### Phase 4 — Review (Sequential, Start: 02:30 UTC)

A reviewer reads the full codebase against REQUIREMENTS.md, identifies bugs, and fixes critical issues.

| Agent | Duration Est. | Description |
|-------|--------------|-------------|
| Reviewer Agent | ~60 min | Requirements audit, bug hunting, security check, write REVIEW_1.md, fix critical issues |

**Phase 4 dependency:** Phase 3 complete

---

### Phase 5 — Testing (Sequential, Start: 03:30 UTC)

A tester writes unit tests, a test plan, runs tests, and reports results.

| Agent | Duration Est. | Description |
|-------|--------------|-------------|
| Tester Agent | ~75 min | Write unit tests, TEST_PLAN.md, run `npm test`, fix failures, write TEST_RESULTS.md |

**Phase 5 dependency:** Phase 4 complete

---

### Phase 6 — Final Polish (Sequential, Start: 05:00 UTC)

Final cleanup, address review/test findings, confirm clean build, write completion docs.

| Agent | Duration Est. | Description |
|-------|--------------|-------------|
| Final Polish Agent | ~90 min | Address REVIEW_1.md/TEST_RESULTS.md issues, final build, BUILD_COMPLETE.md, README.md update |

**Phase 6 dependency:** Phase 5 complete  
**Done by:** ~06:30 UTC (well within 08:00 target)

---

## Agent Roster

### Phase 1A — UX Designer
- **Instruction file:** `agents/phase1a-ux-designer.md`
- **Reads:** REQUIREMENTS.md, TECH_DESIGN.md
- **Produces:** `UX_DESIGN.md`
- **Key deliverables:** Toolbar states (idle, annotating, file loaded, modified), popover layout, pin appearance, all alert messages with exact copy, colors, overflow behavior

### Phase 1B — Project Setup Engineer
- **Instruction file:** `agents/phase1b-project-setup.md`
- **Reads:** REQUIREMENTS.md, TECH_DESIGN.md
- **Produces:** `manifest.json`, `package.json`, `tsconfig.json`, `esbuild.config.js`, `src/` directory with entry stubs
- **Key deliverables:** Working `npm run build`, all dependencies installed

### Phase 2A — Storage & Types Engineer
- **Instruction file:** `agents/phase2a-storage-types.md`
- **Reads:** REQUIREMENTS.md, TECH_DESIGN.md §2, §3, `src/types.ts` (stub)
- **Produces:** `src/types.ts` (all interfaces), `src/storage.ts` (full storage wrapper), `src/urlNorm.ts` (URL normalization)

### Phase 2B — Fingerprinting Engineer
- **Instruction file:** `agents/phase2b-fingerprinting.md`
- **Reads:** REQUIREMENTS.md §1.2, TECH_DESIGN.md §4
- **Produces:** `src/fingerprint.ts` (full implementation)

### Phase 2C — Background Worker Engineer
- **Instruction file:** `agents/phase2c-background-worker.md`
- **Reads:** REQUIREMENTS.md, TECH_DESIGN.md §1.3, §6.1, §6.2, §6.3, §7
- **Produces:** `src/background.ts` (full implementation)

### Phase 2D — Toolbar + UI Engineer
- **Instruction file:** `agents/phase2d-toolbar-ui.md`
- **Reads:** REQUIREMENTS.md §3.4, TECH_DESIGN.md §5.5, §6.5, §6.6, `UX_DESIGN.md`
- **Produces:** `src/toolbar.ts` (full implementation)

### Phase 2E — Pin Rendering Engineer
- **Instruction file:** `agents/phase2e-pin-rendering.md`
- **Reads:** REQUIREMENTS.md §3.3, TECH_DESIGN.md §5
- **Produces:** `src/pinRenderer.ts` (full implementation)

### Phase 2F — Annotation Popover Engineer
- **Instruction file:** `agents/phase2f-annotation-popover.md`
- **Reads:** REQUIREMENTS.md §3.1, §3.2, TECH_DESIGN.md §6.6, §6.7, `UX_DESIGN.md`
- **Produces:** `src/annotationMode.ts` (hover highlight + click interception + popover)

### Phase 2G — Import/Export Engineer
- **Instruction file:** `agents/phase2g-import-export.md`
- **Reads:** REQUIREMENTS.md §1.3, §1.4, §5, TECH_DESIGN.md §3, §8, §9
- **Produces:** `src/importExport.ts` (full implementation)

### Phase 3 — Integration Engineer
- **Instruction file:** `agents/phase3-integration.md`
- **Reads:** All source files, REQUIREMENTS.md, TECH_DESIGN.md
- **Produces:** `src/content.ts` (main content script entry wiring all modules), fixes to any broken modules

### Phase 4 — Reviewer Agent
- **Instruction file:** `agents/phase4-reviewer.md`
- **Reads:** All source files, REQUIREMENTS.md
- **Produces:** `REVIEW_1.md`, inline code fixes

### Phase 5 — Tester Agent
- **Instruction file:** `agents/phase5-tester.md`
- **Reads:** REQUIREMENTS.md, all source files
- **Produces:** `src/__tests__/`, `TEST_PLAN.md`, `TEST_RESULTS.md`, `jest.config.js`

### Phase 6 — Final Polish Agent
- **Instruction file:** `agents/phase6-final-polish.md`
- **Reads:** REVIEW_1.md, TEST_RESULTS.md, all source
- **Produces:** `BUILD_COMPLETE.md`, updated `README.md`, final bug fixes

---

## Parallelization Map

```
21:57 UTC ─┬─ Phase 1A: UX Designer ──────────────────────┐
           └─ Phase 1B: Project Setup ────────────────────┤
                                                           ↓ (both done ~22:27)
22:35 UTC ─┬─ Phase 2A: Storage & Types ──────────────────┐
           ├─ Phase 2B: Fingerprinting ───────────────────┤
           ├─ Phase 2C: Background Worker ────────────────┤
           ├─ Phase 2D: Toolbar + UI ────────────────────┤
           ├─ Phase 2E: Pin Rendering ────────────────────┤
           ├─ Phase 2F: Annotation Popover ───────────────┤
           └─ Phase 2G: Import/Export ────────────────────┤
                                                           ↓ (all done ~01:00)
01:30 UTC ──── Phase 3: Integration ──────────────────────┤
                                                           ↓ (~01:00 duration)
02:30 UTC ──── Phase 4: Reviewer ─────────────────────────┤
                                                           ↓ (~01:00 duration)
03:30 UTC ──── Phase 5: Tester ───────────────────────────┤
                                                           ↓ (~01:15 duration)
05:00 UTC ──── Phase 6: Final Polish ─────────────────────┤
                                                           ↓ (~01:30 duration)
06:30 UTC ──── ✅ COMPLETE (target 08:00 UTC)
```

---

## Integration Checkpoints

1. **End of Phase 1:** `npm run build` must pass with stubs. UX_DESIGN.md must exist.
2. **End of Phase 2:** Each module compiles independently. No TypeScript errors in owned files.
3. **End of Phase 3:** Full `npm run build` passes with zero errors. All modules wired.
4. **End of Phase 4:** REVIEW_1.md exists. Critical bugs fixed. Build still passes.
5. **End of Phase 5:** `npm test` passes. TEST_RESULTS.md exists.
6. **End of Phase 6:** `npm run build` passes. BUILD_COMPLETE.md exists. README.md updated.

---

## Quality Gates

| Gate | Gatekeeper | Pass Criteria |
|------|-----------|---------------|
| Build gate 1 | Project Setup Engineer | `npm run build` exits 0 |
| Build gate 2 | Integration Engineer | `npm run build` exits 0, no TS errors |
| Requirements gate | Reviewer Agent | Every §1–§3 requirement has an implementation |
| Security gate | Reviewer Agent | No network calls, no innerHTML with user data, no eval |
| Test gate | Tester Agent | `npm test` passes, critical paths covered |
| Final build gate | Final Polish Agent | `npm run build` exits 0 on clean checkout |

---

## Guiding Principles for All Agents

1. **80% good = ship.** v1. Don't over-engineer.
2. **Never compromise on security.** No remote code, no network calls, no data exfiltration. All user/file strings via `textContent`, never `innerHTML`.
3. **REQUIREMENTS.md is the source of truth.** Never modify it.
4. **Always `git add -A && git commit -m "..." && git push`** at the end of every agent run.
5. **Verify `npm run build` compiles** before committing. Fix errors before committing.
6. **TypeScript strictly** — no `any` unless unavoidable with a comment.
7. **Read your instruction file and referenced design sections carefully** before writing a single line of code.
