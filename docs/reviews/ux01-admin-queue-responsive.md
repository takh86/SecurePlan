# UX-01: administrative queue responsive sizing

Reference: `5b27fa2ea6031cf28f26b0d68a67b9a919ad2bab`; branch `fix/ux01-admin-queue-responsive`; verified 2026-11-12.

Scope is UX-01 only. The existing migration dirty flags, untracked `AGENTS.md`, three audit documents and original audit evidence were preserved. Neither migration has a content diff: raw hashes remain `cfe4bec70e2d410f538b47f1d0c33759c81c0b16` and `35d1196351093dab04f251e7f6da09171a262fc6`. No reset/clean/stash/commit/push/merge/deployment occurred.

## Root cause and change

The native project select's automatic minimum size follows its longest option. Nested grid automatic sizing propagates that intrinsic width through the label and filter section. At 320px, the queue itself is 288px wide, but its filter track becomes 566px; the project select is 524px wide in a 254px label and extends to x=831. At 1024px the filter section fits, but the select still extends beyond its 202px column. The shell's zero minimum and viewport boundaries already work; no parent shell change is needed. The fieldset's default min-content sizing is not a separate defect once the select is constrained.

`WorkQueue.css` now gives only `.work-queue__controls select` a zero minimum width and `width: 100%`. This lets the controls use the available grid tracks instead of the longest option's intrinsic width. No global clipping, altered labels/options, component restructuring, breakpoints or design tokens were introduced. Text remains intact in native options/accessibility names and populated project cells; a closed native select can show only the part that fits its field, as usual.

Application diff: six CSS lines, including a comment. No TypeScript/component, API, auth, backend, schema or business-rule changes. UX-02 through UX-09 remain outside this change.

## Browser regression and before/after evidence

New runnable regression: [`scripts/ux01-admin-queue-browser.mjs`](../../scripts/ux01-admin-queue-browser.mjs). It uses installed Chrome 157.0.8103.51 and the production React build, with synthetic contract-shaped GET responses intercepted in the browser. It does **not** test backend authorization, sessions or PostgreSQL; no database is used or modified. The production routing, rendering, CSS and native form controls are exercised.

Fixture: `Synthetischer Sicherheitsdienst Flughafen und Veranstaltungsschutz Nordwest`, present in the project options even when “Alle Projekte” is selected. Both empty and populated queue states are tested.

| Viewport | Before: document width, both states | After: document width, both states |
|---|---:|---:|
| 320 | 831 | 320 |
| 375 | 831 | 375 |
| 390 | 831 | 390 |
| 768 | 798 | 768 |
| 1024 | 1067 | 1024 |
| 1440 | 1440 | 1440 |

The initial browser regression failed 10 of 12 cases on page width and passed the two 1440px cases. After the fix all 12 final cases pass, including:

- Page and filter-layer viewport bounds; no body-level overflow hiding.
- Actual keyboard ArrowDown selection; complete option text retained; correct `projectId` and page 1 in the queue request/URL.
- Tab/Shift+Tab returning to the select with a visible, unclipped focus outline.
- Selected long name and restored filter after reload remain within the page.
- Full project text in populated rows; intentional local desktop-table scrolling remains available.
- Desktop sidebar/mobile menu navigation to projects and back to the queue.
- Zero uncaught page errors, console errors, unsafe mutations or unexpected API requests.

Evidence contains synthetic data only:

- [Before measurements and sizing chain](ux01-admin-queue-evidence/before.json).
- [Final passing browser report](ux01-admin-queue-evidence/after.json).
- [Before empty, 320px](ux01-admin-queue-evidence/before-empty-320.png) / [after empty with selected project and keyboard focus](ux01-admin-queue-evidence/after-empty-320.png).
- [Before populated, 320px](ux01-admin-queue-evidence/before-populated-320.png) / [after populated with selected project and keyboard focus](ux01-admin-queue-evidence/after-populated-320.png).

Before screenshots expand to the overflowing document width. After screenshots include the selected/focused field; the selection differs intentionally to demonstrate the post-selection state.

The temporary sizing diagnostic initially copied German strings using the Windows shell's default text encoding, causing diagnostic-only locator failures. A corrected UTF-8 copy established the two-declaration fix. An early diagnostic also needed to await the actual filter response before asserting React/router state. These were harness corrections; application behavior was not changed to satisfy them.

## Reproduction command

Build first and provide an existing external Playwright installation and a private output directory; no new project dependency is required:

```powershell
npm run build --workspace=frontend
$env:SECUREPLAN_PLAYWRIGHT_MODULE = '<absolute path to playwright or playwright-core index.mjs>'
$env:SECUREPLAN_BROWSER_OUTPUT_DIR = Join-Path $env:TEMP 'secureplan-ux01-check'
node scripts/ux01-admin-queue-browser.mjs
```

`SECUREPLAN_REPO_ROOT` is optional; otherwise the script resolves the repository from its own location. It starts/stops its own loopback static server and browser contexts. Every run writes screenshots and a JSON report; failure exits nonzero.

## Verification ledger

| Check | This task's result |
|---|---|
| `node scripts/ux01-admin-queue-browser.mjs` | PASS, 12/12 final width/state cases; measurements and interactions above |
| `npm run build --workspace=frontend` | PASS before and after; includes frontend `tsc -b`. Existing >500kB JS warning remains; no bundle work in scope |
| `node node_modules/typescript/bin/tsc -b apps/frontend/tsconfig.json --pretty false` | PASS |
| `npm run typecheck` | PASS, backend type check; no backend source change |
| `npm run lint` | PASS both workspaces |
| `npm run lint --workspace=frontend` | PASS after final regression-script edits |
| `node_modules/.bin/oxlint scripts/ux01-admin-queue-browser.mjs` / `node --check scripts/ux01-admin-queue-browser.mjs` | PASS |
| `npm run test --workspace=frontend -- --maxWorkers=2` | PASS: 78 files / 1397 tests, 223.32s |
| `npm run check:public` | PASS, limited publication-pattern scan; synthetic screenshots also visually reviewed |
| `git diff --check` / documentation links | PASS; all 7 review-document links resolve |
| Backend unit/database/business E2E | NOT_RUN in this CSS-only task; prior audit results are not reported as new passes |
| Firefox/Safari/physical mobile device | NOT_RUN; Chrome viewport checks are not real-device acceptance |

## Review-ready PR description

**Title:** `fix(frontend): constrain admin queue selects to responsive grid tracks`

The administrative queue overflows when the project filter contains a long German project name, including when no project is selected. At 320px the document grows to 831px because the native select retains its intrinsic option width and expands the nested grid.

Constrain queue-filter selects with a zero minimum and full track width. Preserve all labels, native keyboard behavior, filter parameters, focus and local table scrolling. Add a standalone real-Chrome regression for empty/populated queues at 320/375/390/768/1024/1440, keyboard selection/focus, reload and admin navigation.

Acceptance: no document overflow at any required width, full option text retained, unchanged project-filter requests, usable controls/navigation. Application scope is six CSS lines; no backend/contracts/business changes and no other UX findings implemented.

Validation: production frontend build/type checks and lint pass; browser regression 12/12 passes. Frontend suite and final publication/whitespace checks are recorded in the final verification note. API responses in this browser regression are stubs; backend/database acceptance and cross-browser/physical-device checks are NOT_RUN for this change.

Risk/rollback: native controls differ across engines, so Safari/Firefox remain follow-up verification. Revert the local select-sizing rule if a regression appears. Existing bundle warning and other audit findings are unchanged. Review and required green CI precede merge; this document does not authorize merge or deployment.

Final working-tree summary: the only modified application file is `WorkQueue.css` (+6 lines). New UX-01 files are the standalone browser regression, this review document and six synthetic evidence files (two reports and four screenshots). The two pre-existing migration flags, untracked instruction file and all original untracked audit documents/evidence remain. All changes are uncommitted and unstaged; nothing was pushed. Only audit-owned static server/browser contexts were used; no development backend/database was contacted.
