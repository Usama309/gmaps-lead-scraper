# MapProspector

Import user-level rules from `~/.claude/CLAUDE.md`.

## Stack
Chrome MV3 extension. Vanilla ES modules, no build step, zero runtime dependencies.
Tests: `npm test` (Node's built-in test runner).

## Project-specific rules
- All tunables belong in `src/core/config.js`. All score weights belong in
  `src/core/scoring-config.js`. Never inline a magic number elsewhere.
- Pure modules must not import browser APIs. They are tested in bare Node.
- Every Google request uses `credentials: 'omit'`. This is a binding risk control.
- Never write an em dash in user-facing copy.

## Key documents
- Spec: `docs/superpowers/specs/2026-07-29-gmaps-lead-scraper-design.md`
- Current plan: `docs/superpowers/plans/2026-07-29-phase1-harvest-to-csv.md`
- State: `.claude/PROJECT_SCOPE.md`
