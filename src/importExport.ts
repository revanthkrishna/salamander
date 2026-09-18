// Phase 0 stub. v1's YAML import/export pipeline is replaced wholesale by the
// zip + feedback.md bundle format (REQUIREMENTS.md §1.6/§1.7). Per
// DEVELOPMENT_PLAN.md's inventory table this file is "replace (Phases 8–9)" —
// Phase 8 adds src/bundle.ts + src/export.ts, Phase 9 adds src/import.ts and
// deletes this file entirely. Left here only so nothing that still references
// it (there is currently nothing) breaks the build; content.ts's import of
// this module has been removed as part of the Phase 0 content.ts stub.
//
// The validation-ladder *structure* (type → parse → schema → domain →
// duplicate ids) and buildExportYaml's page-aggregation approach are worth
// reading before Phase 8/9 rewrite this — see git history for the full v1
// implementation.

export {};
