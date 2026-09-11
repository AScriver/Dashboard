# Accessibility audit

Audit date: 2026-07-25

September 7, 2026 update: the Data/import/export screens were removed. References
to those surfaces below are historical. The current 52-test Edge browser suite
passed, including the remaining automated accessibility scenarios, keyboard
navigation, and mobile/reflow checks. See [removal verification](import-export-removal.md).

September 11, 2026 update: the Activity inspector now receives `tabindex="0"`
only while it overflows and has no keyboard-reachable timeline link. Short and
linked timelines retain their existing tab order. Content and viewport changes
refresh that decision; the scroll region has an accessible name and a visible
keyboard focus outline. Native keyboard scrolling is preserved, following the
[W3C scrollable-region rule](https://www.w3.org/WAI/standards-guidelines/act/rules/0ssw9k/).

The new regression reproduced axe's `scrollable-region-focusable` violation
before the fix, then passed in installed Edge and Playwright Chromium. It checks
Tab/PageDown, the focus outline, short and linked timelines, resizing, and tab
switching. All eight tests in the accessibility and keyboard/responsive suites
passed in Edge. A separate Edge preview check of an existing text-only timeline
confirmed Tab focus, the visible outline, and PageDown scrolling. These are
focused checks; the full release suite and a separate screen-reader product
session were not rerun for this change.

Platform: Windows 11 Enterprise 25H2, build 26200.8390, 64-bit

Browsers: Playwright Chromium 149.0.7827.55; installed Edge 150.0.4078.83; installed Chrome 150.0.7871.182

Viewports: 1586×990 desktop, 1280×800 laptop, 900×800 pane collapse, 390×844 mobile, and 640×480 as the 200% reflow equivalent of 1280×960

Passing automated axe checks do not establish WCAG certification. This record combines automated rules, DOM/semantic inspection, keyboard-only workflow runs, responsive screenshots, and focused visual review. No separate screen-reader product session was performed; that is a known limitation of this local MVP audit.

## Automated result

`@axe-core/playwright` 4.12.1 ran with the default maintained ruleset on dashboard, list/inspector, create/edit, lifecycle confirmation, validation, relationships, filters, archive confirmation, Data initial/preview/success, initial loading, browser-offline presentation, archive-impact loading/error, malformed import, archived detail, background refresh after restore, filtered no-results, API error/retry, mobile list/detail, and reflow states.

Result: **0 violations at every reported impact level**. No rules are disabled and no false-positive exceptions are recorded.

## Manual WCAG 2.2 AA review

| Area and applicable criteria | Evidence and result |
| --- | --- |
| Text alternatives; names and descriptions (1.1.1, 2.5.3, 4.1.2) | Decorative icons are hidden; icon-only controls, source actions, archive controls, filter state, rows, and form fields expose names. Axe and role locators passed. |
| Landmarks, headings, structure, tables/lists (1.3.1, 1.3.2, 2.4.1, 2.4.2, 2.4.6) | One main landmark, primary navigation, labeled complementary regions, document title/language, ordered headings, semantic row/header/cell ownership, native lists, and a keyboard-visible skip link passed. |
| Meaning and color (1.3.3, 1.3.5, 1.4.1) | Status, priority, validation, archive, errors, and selection use text or accessible state in addition to color. Form purposes use visible labels and native input types where applicable. |
| Contrast and non-text contrast (1.4.3, 1.4.11) | Axe found no remaining text-contrast violations after remediation. Focus, borders, selected rows, controls, and status presentation remain distinguishable in the dark theme. |
| Resize, text spacing, and reflow (1.4.4, 1.4.10, 1.4.12) | Desktop, laptop, 900 px collapse, 390×844 mobile, and 640 px 200%-equivalent screenshots were inspected. No page-level horizontal overflow, clipped primary action, or inaccessible content was found; dense table content truncates with full text available in detail/title. |
| Keyboard operation and traps (2.1.1, 2.1.2) | Capture/triage, editing/stale recovery, lifecycle, validation, relationships, search/filter/sort, archive/restore, import preview/commit, and export have native keyboard paths. Create/edit and archive dialogs contain focus; Escape closes without silently discarding a dirty create/edit draft and returns focus. |
| Character shortcuts (2.1.4) | `/`, `j/k`, Enter, `e`, and `c` are shown in the Shortcuts control. Tests prove suppression in inputs, textareas, content-editable regions, and dialogs; modifiers are ignored; ordinary buttons/rows/search remain available. |
| Focus order, visibility, and appearance (2.4.3, 2.4.7, 2.4.11, 2.4.12, 2.4.13) | Skip link, shell, rows, inspector, forms, and dialogs follow visual order. Focus is not obscured by sticky regions; selected rows/forms and native controls retain visible focus. Dialog close returns focus to the invoking control. |
| Pointer gestures and cancellation (2.5.1, 2.5.2, 2.5.4, 2.5.8) | No multipoint/path gesture or motion input exists. Native click activation occurs on release. Controls have at least a 24×24 CSS-pixel target or a native inline exception; mobile primary controls exceed the minimum. |
| Consistent navigation/help and change on input (3.2.1–3.2.6) | Primary navigation and controls remain consistently ordered. Focus alone does not submit or navigate. Filters/search communicate their effect, and shortcut help is available in the same top bar on supported views. |
| Labels, errors, suggestions, and prevention (3.3.1–3.3.4, 3.3.7) | Required fields, inline errors, summary, `aria-invalid`, recovery guidance, stale-version review/reapply, destructive confirmation, and non-mutating import preview passed. Previously entered values remain available after validation errors. |
| Status messages (4.1.3) | Loading, background refresh, offline state, save notice, import progress/success, archive impact, no-results, and API/correlation errors use polite or assertive live semantics without forced focus. |
| Accessible authentication (3.3.8, 3.3.9) | Not applicable: the MVP has no authentication or accounts. |
| Dragging movements (2.5.7) | Not applicable: the MVP has no dragging interaction. |

## Keyboard workflow record

| Workflow | Browser/viewport | Result |
| --- | --- | --- |
| Capture, validation errors, triage, edit, and stale-conflict recovery | Playwright Chromium, 1586×990 | Pass; drafts preserved and conflict reapply works. |
| Lifecycle transitions, append-only validation, correction, completion, reopen | Playwright Chromium, 1586×990, 1280×800, and 390×844 | Pass; keyboard alternatives exist for every action. |
| Subtask and dependency management | Playwright Chromium, 1586×990 and 390×844 | Pass; separate relationship controls and derived blocking remain reachable. |
| Search, filters, sorting, row movement/open/edit/create shortcuts | Playwright Chromium, 1586×990 | Pass; URL context and focus remain stable. |
| Archive confirmation, Escape, containment, focus return, restore | Playwright Chromium, 1586×990 | Pass after archive-dialog isolation/containment remediation. |
| Import preview, review, explicit commit, affected links, export | Installed Edge 150.0.4078.83 and Chrome 150.0.7871.182, 1586×990 | Pass; no mutation occurs before commit. |

## Defects and retest

| Finding | Impact | Remediation | Retest |
| --- | --- | --- | --- |
| Document lacked title and language. | Serious | Added full HTML document metadata. | Axe pass. |
| Shortcut, queue-empty, primary, and dialog-cancel contrast was insufficient. | Serious | Raised muted contrast and adjusted action/control colors. | Axe pass. |
| Sortable buttons carried an invalid `columnheader` role. | Minor | Kept headers as cells and nested native buttons. | Axe pass. |
| Empty/error content violated table required-child semantics. | Critical | Represented the state as a row/cell with live semantics. | Axe pass. |
| Detail tabs lacked a `tablist` parent. | Critical | Added the required parent role. | Axe pass. |
| Archive header created a duplicate banner; archive dialog lacked isolation/containment. | Moderate / keyboard blocker | Replaced the nested banner landmark, isolated background content, trapped Tab/Shift+Tab, retained Escape and focus return. | Axe and focused keyboard pass. |
| No keyboard bypass link or documented global shortcuts. | Keyboard blocker | Added skip-to-main and discoverable `/`, `j/k`, Enter, `e`, `c` behavior with editing/modal suppression. | Focused keyboard pass. |
| New-action activation raced scope loading. | Primary-flow reliability | Disabled the action until required scope data exists. | Stale-conflict browser test pass. |

## Outcome

Manual review result: **pass for the audited MVP surfaces with no unresolved WCAG 2.2 AA blocker identified**. The retained limitation is absence of a separate screen-reader product session; automated semantics and keyboard testing do not replace user testing with assistive technology.

Concurrency-only stale-edit/lifecycle messages and every millisecond-scale pending label were covered by focused API/E2E behavior and semantic inspection, not frozen in a dedicated axe snapshot. The no-results axe fixture filters seeded data; it does not start a separate zero-record database.
