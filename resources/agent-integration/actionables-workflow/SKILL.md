---
name: actionables-workflow
description: Coordinate Actionables within an explicitly identified feature or bug work item through authorized task creation, planning, research, implementation, debugging, handoff, and validation using the Actionables MCP tools. Use at the start or resumption of substantive tracked work, when the user explicitly asks to create tasks, when reporting meaningful progress or blockers, and before completing or handing off work. Do not use for simple questions, unrelated work, or arbitrary backlog discovery.
---

# Actionables Workflow

Use Actionables as the coordination record for substantive work without letting task administration replace the user's requested outcome.

## Start or resume work

1. Let the Actionables MCP server derive the current Codex thread ID from host-supplied request metadata. Never supply, invent, or persist a model-authored agent ID.
2. Call `actionables.list_tasks` with `view: mine`; the server uses the calling thread as claim identity. Inspect `hasMore` before treating a bounded list as exhaustive; raise `limit` up to 100 when needed, and do not assume all matches were returned while `hasMore` remains true.
3. Resolve the governing feature or bug's top-level Actionable ID as `workItemId` from the task context. Never infer it from repository, worktree, title, tags, or arbitrary pending work.
4. If no owned task clearly matches and no `workItemId` was provided, do not list `available`; continue without claiming and report the missing tracking scope.
5. Otherwise call `actionables.list_tasks` with `view: available` and that `workItemId`.
6. Treat a scoped list with `workItem.terminal: true` as a successful read even when `items` is empty. Inspect a known Done or Dismissed task with `actionables.get_task` using its top-level `workItemId`; page truncated fields with `actionables.get_task_detail` using that same `workItemId`. Terminal inspection is read-only and does not create lifecycle ownership.
7. Claim only the root or a direct task returned from an active work item, using the same `workItemId` and listed version. The server assigns the claim to the calling Codex thread and returns compact task detail plus the secret token. Read the latest version from `task.version` and the secret capability from `claim.claimToken`; do not immediately fetch again.
8. After every composed tool call, inspect `isError`. If it is true, stop before reading success fields or issuing any dependent mutation and preserve the structured error. Treat `retryMode` as authoritative: repeat the exact call once only for `same_request`; correct arguments before a new call for `after_input_change`; satisfy `recovery` and wait until any `recovery.retryAt` for `after_state_change`; and stop for `never`. Use `recovery.action` and `recovery.guidance` for the next step, and retain `correlationId` when server diagnostics are needed. `retryable` and `nextAction` are legacy compatibility fields, not the retry decision. An awaited MCP tool error is a resolved result, not necessarily a thrown exception.
9. Inspect `task.truncation.reconciliationGuidance` before treating compact detail as complete. When present, use `actionables.get_task_detail` for every supported implementation-critical field it names: pass the compact task version and the same read authorization (`claimToken` for active claimed work or `workItemId` for terminal inspection) at offset 0, then pass `contentHash` with each `nextOffset` until null, concatenate `json` in order, and JSON-parse the complete value. On `VERSION_CONFLICT`, discard partial pages and restart from the current compact detail. On `TERMINAL_READ_INVALIDATED`, discard partial pages and stop terminal inspection; continued access requires the normal authorized list and claim flow before reading active work with `claimToken`. Do not move the task forward or edit files until every named supported field is reconciled. When guidance is absent, normal flow may continue because any reported loss is noncritical to scope and planned validation.
10. For a newly claimed Inbox task, transition to Researching before beginning investigation.
11. Before moving to Ready or advancing Ready to In progress, inspect the latest `readiness.requiredForReady` and `permittedTransitions`. Ready requires non-empty finding, description, Research, and planned validation. Supply each named missing field and do not make the transition until `requiredForReady` is empty and the target is permitted.
12. Transition from Ready to In progress before making any implementation changes.
13. If no task in that work item matches, continue the user's work without claiming anything and state in the final report that Actionables was not updated.

If a tool call throws or the Actionables MCP server is unreachable before a
structured result arrives, delivery is uncertain and no `retryMode` exists. Do
not blindly replay a mutation. Re-list or fetch the scoped task and reconcile
authoritative state first; exact create and bulk retries must reuse their stable
idempotency UUIDs. If the server or required tool remains unavailable, continue
the user's work and report the tracking limitation. Never claim a merely
adjacent task.

## Create authorized tasks

- Create a task only when the user explicitly requests or approves its creation and the dedicated `actionables.create_task` tool is available.
- For a creation-only request, create each authorized Actionable unclaimed in Inbox and stop unless the user also requested triage, research, or implementation.
- Generate one caller-stable idempotency UUID for each intended task. Reuse it only for an exact retry and never for a different task.
- Provide a deliberate priority other than `Unset`, an effort estimate other than `Unknown`, and at least one meaningful tag for every created task.
- For one direct task or sibling, provide the authorized top-level Actionable as both workItemId and parentId, omit placement fields, and never use a direct task as the parent. The server inherits that root's scope.
- For a top-level task with known scope IDs, pass `projectId`, `repositoryId`, and `worktreeId`.
- If the current local Git repository is not tracked yet, pass its absolute path as `repositoryPath` with `ensureScope: true`. The server resolves the Git roots and atomically creates any missing project, repository, or worktree before creating the task.
- For a tracked monorepo, pass a path inside the intended registered project directory. The deepest matching project directory selects the scope; a sibling or ambiguous checkout-root path must be corrected, or use the known explicit scope IDs.
- Treat the task detail returned by creation as verification. Do not claim a newly created task only to fetch it again.
- Creation records the calling Codex thread as creator provenance. Do not dismiss, archive, or delete an invalid, accidental, or disposable task without explicit user authorization. When dismissal is authorized and a task created by this same thread is still active and unclaimed, call `actionables.dismiss_task` with only its ID and a required reason.
- Automatic scope provisioning does not authorize arbitrary backlog discovery or creation outside the repository and task content the user placed in scope.

For 2–25 authorized tasks, use `actionables.bulk_create_tasks` instead of
individual create calls. Supply only the explicit intended items and one
caller-stable UUID per item. Call `mode: "preview"` first; correct every
reported item error, then call `mode: "apply"`. Keep a UUID when correcting the
same intended task; use a new one only for a different task.
Preview does not write. Apply is ordered and non-atomic across items, but each
schema-valid item is atomic: earlier successes remain when a later item fails.
The whole request must satisfy the published input schema before per-item
validation; a malformed item rejects the request without applying siblings.
Inspect every compact per-item result. An exact UUID replay is safe; changing an
applied item using its UUID is a conflict. Bulk operations never discover work.

Use `actionables.bulk_prepare_tasks` only for explicit unclaimed Inbox tasks
created by the current Codex thread within the authorized `workItemId`. Use the
normal list, claim, and reconciliation workflow for pre-existing tasks. Each
item must carry that `workItemId`, its current `version`, and its own UUID; it
neither accepts nor returns claim tokens. Preview first, then apply only after correcting every item error and
keeping the UUID for the same intended task. Preparation may move an Inbox task
only through `Researching` and `Ready` when the supplied content
satisfies readiness, then releases it for normal available-work discovery. It
cannot leave or expose a claim, claim unlisted work, or bypass repository scope,
hierarchy, lifecycle, or version checks. Split 139 items into six chunks per
phase.

## Split researched work

- Split only when research confirms multiple independently implementable outcomes. A task with one outcome remains one task.
- For a top-level task, keep the root as the coordination record and create the minimum direct task set covering every implementation slice. Do not narrow the root to one slice.
- For an existing direct task, narrow it to one non-overlapping slice and create only the remaining slices as sibling direct tasks under the same top-level work item. Do not create grandchildren.
- Make every implementation task a narrow, complete, independently verifiable vertical slice. Do not split by technical layer, create adjacent cleanup, or duplicate scope.
- Record the split rationale, dependency notes, and focused validation boundary in the current task and every created task. Leave created tasks unclaimed in Inbox unless the user separately authorized more work on them.
- Unless a dedicated relationship tool is available, record dependencies only as task notes and do not claim that dependency relationships were created.
- Move a research-complete split root to Ready as the coordination record. Later work on that root coordinates its direct tasks and aggregate validation instead of implementing or duplicating their scope.

## Maintain the task

- Treat the claim token as a secret capability. Keep it only in tool-call context; never place it in chat, code, files, logs, task text, or validation evidence.
- After claim, use the task ID, claim token, and latest version where required. Do not repeat the agent ID or mutation lease duration; only explicit renewal accepts `leaseMinutes`.
- Re-fetch compact detail after a mutation version conflict, reconcile the current record, and retry only if the intended change is still valid. For detail-page version conflicts, discard the partial field and restart its paging from the current compact version.
- After each composed tool result, branch on `isError` before accessing fields such as `version`. Stop dependent calls when it is true and follow the authoritative `retryMode` plus structured `recovery`. `same_request` permits one exact retry; `after_input_change` requires corrected arguments; `after_state_change` requires the named state recovery and any `retryAt`; `never` ends that operation. Keep `correlationId` for a repeated or internal failure. Legacy `retryable` and `nextAction` mirror only coarse compatibility behavior and must not override the richer contract.
- A returned `INTERNAL_ERROR` may permit one exact retry only when its `retryMode` is `same_request`; otherwise reconcile task state and use its correlation ID for diagnostics. A thrown transport error has uncertain delivery and must be reconciled before another mutation.
- On `SCHEMA_MIGRATION_REQUIRED`, stop Actionables mutations and inspect `errors.migrations` plus the configured database's migration status. Apply missing migrations; preserve a backup and use the documented operator recovery or matching application version for incomplete or unexpected history. Retry only after `/api/health` reports `schema: "current"`. Never switch, reset, delete, or hand-edit the database as a workaround.
- Treat successful `structuredContent` as authoritative; success `content.text` is only a short compatibility notice. Routine mutations return a lean receipt, not task detail: advance with its `version`, `status`, `readiness`, and `permittedTransitions`; use `counts` for persisted and duplicate-ignored additions; and fetch only fields named by `reconciliationFields` before relying on their authoritative stored values. An empty `reconciliationFields` means the mutation did not invalidate cached implementation-critical detail.
- Prefer `appendResearch`, `appendPlannedValidation`, and `addUserSources` when adding material; use replacement fields only for intentional rewrites.
- Record meaningful state changes, research conclusions, decisions, plans, blockers, and validation evidence. Do not emit heartbeat or narration-only updates.
- Renew explicitly during long periods without mutations. Successful claimed mutations may renew the lease automatically.
- Follow `permittedTransitions` instead of forcing a status. Return In progress directly to Researching only when investigation must resume, and include a meaningful reason for the activity audit.
- Do not edit implementation files until the claimed task is In progress. Inbox is untriaged, Researching is investigation, and Ready means implementation may begin after the explicit transition.
- Before transitioning a task to Done, populate its Resolution with the completed changes and important implementation decisions.
- Lifecycle enforcement governs Actionables mutations but cannot prevent filesystem writes outside the MCP. A hard write gate requires orchestration support and is outside this workflow unless separately authorized.

## Lifecycle accountability

- Track every Actionable created, claimed, or transitioned during the task, including accidental creations. Read-only inspection does not create lifecycle ownership.
- Do not claim or mutate a Done or Dismissed Actionable. If continued work is explicitly authorized, reopen it to Ready in the dashboard with the required audited reason, then use the normal list and claim flow. A new follow-up is separate work and requires normal creation authority; do not imply a relationship that was not recorded.
- Treat user-provided reports as sources, not research. Recording, restating, or paraphrasing a report does not satisfy the Researching phase.
- A claimed Actionable may remain Researching between turns only while additional investigation is genuinely required. Before pausing, record the findings so far, remaining questions, and the next research step. Do not force a status transition merely because a turn ended.
- Move an Actionable to Ready only after at least one independent investigative action, such as inspecting relevant code, reproducing the behavior, or consulting authoritative documentation. Record the action and its observed result; an unverified research note is insufficient. Confirm the latest `readiness.requiredForReady` is empty and the intended target appears in `permittedTransitions` before moving to Ready or from Ready to In progress.
- Before reporting completion, reconcile every lifecycle-owned Actionable:
  - Completed work: record Resolution content and actual validation, then move it to Done.
  - Research complete but implementation remains: move it from Researching to Ready.
  - Invalid, accidental, or disposable work: without explicit user authorization, document the issue, leave its status unchanged, release any claim, and provide an explicit handoff.
  - Unfinished work: update its status, release any claim, and provide an explicit handoff.
- Never report research or the overall task complete while a lifecycle-owned Actionable remains Researching. If research is the entire requested outcome, advance it through the permitted lifecycle, record actual validation, and move it to Done.
- Do not advance an Actionable merely because a turn or coding task ended. Creation-only Inbox work may remain unclaimed; reconcile lifecycle-owned work according to its actual state. Archiving changes visibility; it does not satisfy lifecycle completion.
- In the final response, list every lifecycle-owned Actionable ID and status. If reconciliation failed, report the exact blocker instead of claiming completion.

Use lifecycle states consistently:

- Researching: active investigation is needed; save durable findings and research notes.
- Ready: finding, intended result, Research, and planned validation are all non-empty and sufficient for implementation.
- In progress: implementation or active execution has begun.
- Blocked: progress cannot continue; include the concrete blocker and needed resolution.
- Done: the requested outcome is complete, Resolution content is populated, and qualifying validation evidence has been recorded.
- Dismissed: work is intentionally declined or obsolete; include the reason.

## Finish or hand off

1. Record Resolution content plus actual validation with commands, results, or other evidence before transitioning to Done.
2. Transition to Done only when the existing completion rules pass. A terminal transition releases the claim.
3. Verify terminal state read-only with a scoped list or `get_task` using the top-level `workItemId`; an empty active-work list with `workItem.terminal: true` is expected.
4. Use `actionables.handoff_task` when task content must be saved before release; provide at least one of `finding`, `addFiles`, `appendResearch`, `appendPlannedValidation`, or `validation`.
5. Use `actionables.release_task` only when no task content needs to change; it releases the claim without saving or updating task content.
6. Keep the claim only when the same agent is expected to continue promptly; renew it when necessary.
7. Include the final Actionables status in the user-facing handoff without exposing credentials.

Do not create or prepare tasks beyond the authorized single or bulk operations,
modify other hierarchy or dependencies, archive records, bypass validation, or
broaden scope unless dedicated tools and explicit user authority exist.
