import {
  Activity,
  Archive,
  ArchiveRestore,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Clock3,
  Copy,
  ExternalLink,
  FileCode2,
  GitBranch,
  LayoutDashboard,
  List,
  Keyboard,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  RotateCcw,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import {
  actionableExcludeFilterKeys,
  activeActionableExcludeFilterKeys,
  assistantReasoningEfforts,
  codexPromptTemplateSchema,
  codexPromptVariables,
  defaultCodexResearchPrompt,
  defaultCodexImplementationPrompt,
  defaultInboxTriageBatchSize,
  defaultLocalCodexTimeoutSeconds,
  isActionableExcludeFilterActive,
  maximumLocalCodexTimeoutSeconds,
  maximumInboxTriageBatchSize,
  minimumLocalCodexTimeoutSeconds,
  minimumInboxTriageBatchSize,
  noteGroomerModels,
  renderCodexStartPrompt,
  type CreateActionableRequest,
  type CreateRepositoryResponse,
  type ActionableDetail,
  type ActionableExcludeFilterKey,
  type ActionableQuery,
  type ActionableSummary,
  type AgentIntegrationComponent,
  type AgentIntegrationSettings,
  type ArchiveImpactResponse,
  type ArchiveTargetKind,
  type Effort,
  type EvidenceState,
  type GroomActionableNotesProposal,
  type HelperAgentSettings,
  type InboxTriageBatchResponse,
  type AssistantReasoningEffort,
  type NoteGroomerModel,
  type RelationshipAuditResponse,
  type Priority,
  type ScopeOptionsResponse,
  type Status,
  type TaskBreakdownTemplate,
  type UserSourceReferenceInput,
  type ValidationOutcome,
  type ValidationType,
} from "@actionables/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ApiProblem,
  auditActionableRelationships,
  createDependency,
  createActionable,
  createRepository,
  createSubtask,
  createTaskBreakdown,
  detachParent,
  fetchActionable,
  fetchActionables,
  fetchAgentIntegrationSettings,
  fetchArchiveImpact,
  fetchCodexWorkspace,
  fetchDashboard,
  fetchHelperAgentSettings,
  fetchScopeOptions,
  groomActionableNotes,
  recordValidation,
  forceReleaseAgentClaim,
  removeDependency,
  restoreDependency,
  setParent,
  setActionableArchived,
  setScopeArchived,
  transitionActionable,
  triageInboxQueue,
  installAgentIntegration,
  selectRepositoryFolder,
  updateActionable,
  updateHelperAgentSettings,
  updateRepositoryProject,
  waiveDependency,
} from "./api";
import {
  availableCreationScopes,
  defaultCreationWorktreeStorageKey,
  readDefaultCreationWorktree,
  resolveCreationScope,
} from "./creation-scope";
import {
  activityEventCategory,
  groupActivityByAgentSession,
} from "./activity-timeline";
import {
  buildCodexNewChatUrl,
  codexSkillsUrl,
  codexThreadUrlFromAgentId,
} from "./codex-links";
import { Markdown } from "./Markdown";
import { safeImportedSourceUrl, safeSourceUrl } from "./source-links";

type InspectorTab =
  | "finding"
  | "research"
  | "resolution"
  | "validation"
  | "relationships"
  | "activity";

const inspectorWidthStorageKey = "actionables-inspector-width";
const agentIntegrationSetupStorageKey =
  "actionables-agent-integration-setup-dismissed-v1";
const inspectorMinWidth = 320;
const inspectorMaxWidth = 800;
const findingsMinWidth = 320;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function defaultInspectorWidth() {
  try {
    const stored = Number(localStorage.getItem(inspectorWidthStorageKey));
    if (Number.isFinite(stored) && stored >= inspectorMinWidth) {
      return clamp(stored, inspectorMinWidth, inspectorMaxWidth);
    }
  } catch {
    // Keep the responsive default when storage is unavailable.
  }

  if (window.innerWidth <= 900) return 360;
  if (window.innerWidth <= 1080) return 365;
  if (window.innerWidth <= 1320) return 390;
  return clamp(Math.round(window.innerWidth * 0.2985), 410, 500);
}

function availableInspectorWidth(sidebarCollapsed: boolean) {
  const sidebarWidth =
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        sidebarCollapsed ? "--sidebar-collapsed-width" : "--sidebar-width",
      ),
    ) || 0;

  return clamp(
    window.innerWidth - sidebarWidth - findingsMinWidth,
    inspectorMinWidth,
    inspectorMaxWidth,
  );
}

function InspectorResizeHandle({
  width,
  maximumWidth,
  onResize,
  onResizingChange,
}: {
  width: number;
  maximumWidth: number;
  onResize: (width: number) => void;
  onResizingChange: (resizing: boolean) => void;
}) {
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  const finishResize = () => {
    if (!drag.current) return;
    drag.current = null;
    onResizingChange(false);
  };

  return (
    <div
      className="inspector-resize-handle"
      role="separator"
      aria-label="Resize actionable details"
      aria-controls="actionable-inspector"
      aria-orientation="vertical"
      aria-valuemin={inspectorMinWidth}
      aria-valuemax={Math.round(maximumWidth)}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        onResizingChange(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current || drag.current.pointerId !== event.pointerId) {
          return;
        }
        onResize(drag.current.startWidth + drag.current.startX - event.clientX);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        finishResize();
      }}
      onPointerCancel={finishResize}
      onLostPointerCapture={finishResize}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        let nextWidth: number | undefined;

        if (event.key === "ArrowLeft") nextWidth = width + step;
        if (event.key === "ArrowRight") nextWidth = width - step;
        if (event.key === "Home") nextWidth = inspectorMinWidth;
        if (event.key === "End") nextWidth = maximumWidth;

        if (nextWidth === undefined) return;
        event.preventDefault();
        onResize(nextWidth);
      }}
    />
  );
}

function blocksGlobalShortcut(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, button, a, [role="dialog"], [contenteditable="true"]',
    ) || target.isContentEditable,
  );
}

function useModalIsolation(dialogRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const backdrop = dialogRef.current?.parentElement;
    const shell = backdrop?.parentElement;
    if (!backdrop || !shell) return;
    const siblings = [...shell.children].filter(
      (element) => element !== backdrop,
    ) as HTMLElement[];
    const previous = siblings.map((element) => ({
      element,
      ariaHidden: element.getAttribute("aria-hidden"),
      inert: element.inert,
    }));
    for (const sibling of siblings) {
      sibling.inert = true;
      sibling.setAttribute("aria-hidden", "true");
    }
    return () => {
      for (const state of previous) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null)
          state.element.removeAttribute("aria-hidden");
        else state.element.setAttribute("aria-hidden", state.ariaHidden);
      }
    };
  }, [dialogRef]);
}

const priorities: Priority[] = [
  "Unset",
  "Critical",
  "High",
  "Medium",
  "Low",
  "Backlog",
];
const efforts: Effort[] = [
  "Unknown",
  "XS",
  "S",
  "S–M",
  "M",
  "M–L",
  "L",
  "L–XL",
  "XL",
];
const evidenceStates: EvidenceState[] = [
  "Unclassified",
  "Confirmed",
  "Suspected",
  "Proposed",
  "Investigation",
];

function AdvancedFilterField({
  children,
  excluded,
  id,
  label,
  modeDisabled,
  onModeChange,
}: {
  children: ReactNode;
  excluded: boolean;
  id: string;
  label: string;
  modeDisabled: boolean;
  onModeChange: () => void;
}) {
  const labelId = `${id}-label`;
  return (
    <div className="filter-field">
      <div className="filter-field-heading">
        <label id={labelId} htmlFor={id}>
          {label}
        </label>
        <button
          type="button"
          className={`filter-mode ${excluded ? "is-exclude" : ""}`}
          aria-pressed={excluded}
          aria-describedby={labelId}
          disabled={modeDisabled}
          onClick={onModeChange}
          title="Toggle include or exclude mode"
        >
          {excluded ? "Exclude" : "Include"}
        </button>
      </div>
      {children}
    </div>
  );
}

function Badge({
  children,
  tone,
  title,
  ariaLabel,
}: {
  children: React.ReactNode;
  tone: string;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <span
      className={`badge badge-${tone.toLowerCase().replace(/\s+/g, "-")}`}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </span>
  );
}

function IconButton({
  label,
  children,
  onClick,
  pressed,
  expanded,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
  pressed?: boolean;
  expanded?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function WorktreeRow({
  name,
  selected,
  count,
  onClick,
}: {
  name: string;
  selected: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`worktree-row ${selected ? "is-selected" : ""}`}
      onClick={onClick}
      title={name}
      aria-label={`${name}${count === undefined ? "" : `, ${count} findings`}`}
    >
      <GitBranch aria-hidden="true" />
      <span className="worktree-name">{name}</span>
      {count !== undefined && <span className="tree-count">{count}</span>}
      <span
        className={`tree-status ${selected ? "is-active" : ""}`}
        aria-hidden="true"
      />
    </button>
  );
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }
}

function SourceActions({
  locator,
  openUrl,
  onNotice,
}: {
  locator: string;
  openUrl: string | null;
  onNotice: (notice: string) => void;
}) {
  const copy = async () => {
    if (await copyText(locator)) onNotice("Source locator copied.");
    else window.prompt("Copy this source locator:", locator);
  };
  return (
    <span className="source-actions">
      {openUrl && (
        <a href={openUrl} aria-label="Open source" title="Open source">
          <ExternalLink aria-hidden="true" />
        </a>
      )}
      <button
        type="button"
        onClick={copy}
        aria-label="Copy source locator"
        title="Copy source locator"
      >
        <Copy aria-hidden="true" />
      </button>
    </span>
  );
}

function SourceHistory({
  selected,
  onNotice,
}: {
  selected: ActionableDetail;
  onNotice: (notice: string) => void;
}) {
  const imported = selected.immutableSourceEvidence.imported;
  return (
    <section className="inspector-section">
      <h3>{imported ? "Imported source evidence" : "Source references"}</h3>
      <div className="source-history">
        <div
          className={`source-evidence-notice ${imported ? "is-imported" : ""}`}
        >
          <strong>
            {imported ? "Read-only imported evidence" : "No imported evidence"}
          </strong>
          <p>{selected.immutableSourceEvidence.note}</p>
        </div>
        {imported &&
          selected.immutableSourceEvidence.sourceFiles.map((file) => (
            <div
              className="source-event"
              key={`${file.path}-${file.lines ?? file.symbol ?? ""}`}
            >
              <div className="source-event-meta">
                <span className="source-label">imported</span>
                <span>{file.lines ?? file.symbol ?? "file"}</span>
                <span>original evidence</span>
              </div>
              <p>
                <code>{file.path}</code>
                <SourceActions
                  locator={file.path}
                  openUrl={null}
                  onNotice={onNotice}
                />
              </p>
            </div>
          ))}
        <div className="source-event">
          <div className="source-event-meta">
            <span className="source-label">
              {imported ? "import" : "manual"}
            </span>
            <span>now</span>
            <span>status provenance</span>
          </div>
          <p>
            {selected.statusProvenance.note}
            {selected.statusProvenance.kind === "neutral-import" &&
            selected.statusProvenance.suggestedStatus
              ? ` Prototype suggestion: ${selected.statusProvenance.suggestedStatus}.`
              : ""}
          </p>
        </div>
        {selected.userSources.map((source, index) => (
          <div
            className="source-event user-source"
            key={`${source.type}-${source.locator}-${index}`}
          >
            <div className="source-event-meta">
              <span className="source-label">{source.provenance}</span>
              <span>{source.type}</span>
              <span>{source.label || "source reference"}</span>
            </div>
            <p>
              <code>{source.locator}</code>
              <SourceActions
                locator={source.locator}
                openUrl={safeSourceUrl(source)}
                onNotice={onNotice}
              />
            </p>
            <time dateTime={source.createdAt}>
              Added {new Date(source.createdAt).toLocaleString()} ·{" "}
              {source.provenance}
            </time>
          </div>
        ))}
        {imported && selected.sourceThread && (
          <div className="source-link">
            <span>Imported source thread</span>
            <SourceActions
              locator={selected.sourceThread}
              openUrl={safeImportedSourceUrl(selected.sourceThread)}
              onNotice={onNotice}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function RelationshipAuditor({
  selected,
  actionables,
  onNavigate,
}: {
  selected: ActionableDetail;
  actionables: ActionableSummary[];
  onNavigate: (id: number) => void;
}) {
  const [result, setResult] = useState<RelationshipAuditResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const titleFor = (id: number) =>
    actionables.find((item) => item.id === id)?.title ?? `Actionable ${id}`;

  const audit = async () => {
    setRunning(true);
    setError("");
    try {
      setResult(
        await auditActionableRelationships(selected.id, {
          version: selected.version,
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiProblem
          ? [caught.problem.title, caught.problem.detail]
              .filter(Boolean)
              .join(" ")
          : "The local assistant could not audit this work item.",
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="assistant-panel relationship-auditor">
      <div className="assistant-heading">
        <div>
          <h3>Relationship auditor</h3>
          <p className="section-help">
            Reviews #{selected.id} and its {selected.childIds?.length ?? 0}{" "}
            direct subtasks. Recommendations never change relationships.
          </p>
        </div>
        <button
          type="button"
          className="toolbar-button"
          disabled={running}
          onClick={audit}
        >
          {running ? "Auditing…" : result ? "Audit again" : "Audit"}
        </button>
      </div>
      {error && (
        <p className="relationship-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="relationship-audit-result">
          <p className="assistant-provenance">
            <code>{result.model}</code> audited task IDs{" "}
            {result.auditedTaskIds.join(", ")} from saved version{" "}
            {result.basedOnVersion}.
          </p>
          {result.recommendations.length === 0 ? (
            <p>No relationship changes were recommended.</p>
          ) : (
            <ul className="relationship-recommendations">
              {result.recommendations.map((recommendation, index) => (
                <li
                  key={`${recommendation.kind}-${recommendation.action}-${recommendation.fromId}-${recommendation.toId}-${index}`}
                >
                  <div className="recommendation-heading">
                    <span>{recommendation.kind}</span>
                    <strong>{recommendation.action}</strong>
                    <span>{recommendation.confidence} confidence</span>
                  </div>
                  <p>
                    <button
                      type="button"
                      onClick={() => onNavigate(recommendation.fromId)}
                    >
                      #{recommendation.fromId} ·{" "}
                      {titleFor(recommendation.fromId)}
                    </button>
                    <span aria-hidden="true"> → </span>
                    <button
                      type="button"
                      onClick={() => onNavigate(recommendation.toId)}
                    >
                      #{recommendation.toId} · {titleFor(recommendation.toId)}
                    </button>
                  </p>
                  <p>{recommendation.reason}</p>
                  {recommendation.evidence.length > 0 && (
                    <ul>
                      {recommendation.evidence.map((evidence) => (
                        <li key={evidence}>{evidence}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setResult(null)}>
            Dismiss recommendations
          </button>
        </div>
      )}
    </div>
  );
}

function RelationshipSection({
  selected,
  actionables,
  relationshipAuditorEnabled,
  onNavigate,
  onMutated,
}: {
  selected: ActionableDetail;
  actionables: ActionableSummary[];
  relationshipAuditorEnabled: boolean;
  onNavigate: (id: number) => void;
  onMutated: (saved: ActionableDetail, notice: string) => void;
}) {
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [taskBreakdown, setTaskBreakdown] =
    useState<TaskBreakdownTemplate>("feature");
  const [childId, setChildId] = useState("");
  const [prerequisiteId, setPrerequisiteId] = useState("");
  const [dependentId, setDependentId] = useState("");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const hierarchyCandidates = actionables.filter(
    (item) =>
      item.id !== selected.id &&
      item.scope.projectId === selected.scope.projectId &&
      item.scope.repositoryId === selected.scope.repositoryId &&
      item.scope.worktreeId === selected.scope.worktreeId,
  );
  const options = (items: ActionableSummary[]) =>
    items.map((item) => (
      <option key={item.id} value={item.id}>
        {item.id} · {item.title} — {item.scope.projectName}/
        {item.scope.worktreeName}
      </option>
    ));
  const run = async (work: () => Promise<ActionableDetail>, notice: string) => {
    setSaving(true);
    setError("");
    try {
      onMutated(await work(), notice);
    } catch (caught) {
      if (caught instanceof ApiProblem) {
        setError(
          Object.values(caught.problem.errors ?? {})
            .flat()
            .join(" ") || caught.problem.title,
        );
        if (caught.problem.current)
          onMutated(
            caught.problem.current,
            "The saved version changed; relationship action was not applied.",
          );
      } else setError("The relationship change could not be completed.");
    } finally {
      setSaving(false);
    }
  };
  const selectedParent = selected.relationships.parent?.parent;

  return (
    <section
      className="inspector-section relationships"
      aria-label="Relationships"
    >
      {relationshipAuditorEnabled &&
        !selected.parentId &&
        !selected.archiveState.isArchived && (
          <RelationshipAuditor
            key={`relationship-auditor-${selected.id}-${selected.version}`}
            selected={selected}
            actionables={actionables}
            onNavigate={onNavigate}
          />
        )}
      {selectedParent && (
        <div className="relationship-parent">
          <span>Parent</span>
          <button type="button" onClick={() => onNavigate(selectedParent.id)}>
            {selectedParent.id} · {selectedParent.title}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              void run(
                () =>
                  detachParent(selected.id, {
                    version: selected.version,
                    parentVersion: selectedParent.version,
                  }),
                "Subtask detached; the relationship remains in activity history.",
              )
            }
          >
            Detach
          </button>
        </div>
      )}
      <div className="relationship-group">
        <h3>
          Subtasks <span>{selected.relationships.subtasks.length}</span>
        </h3>
        {selected.relationships.subtasks.map((relationship) => (
          <div className="relationship-row" key={relationship.id}>
            <button
              type="button"
              onClick={() => onNavigate(relationship.child.id)}
            >
              {relationship.child.id} · {relationship.child.title}
            </button>
            <span>{relationship.child.status}</span>
          </div>
        ))}
        <form
          className="relationship-add"
          onSubmit={(event) => {
            event.preventDefault();
            if (!subtaskTitle.trim()) return;
            void run(
              () =>
                createSubtask(selected.id, {
                  version: selected.version,
                  title: subtaskTitle,
                }),
              "Subtask created and attached.",
            ).then(() => setSubtaskTitle(""));
          }}
        >
          <input
            value={subtaskTitle}
            onChange={(event) => setSubtaskTitle(event.target.value)}
            placeholder="New subtask name"
            aria-label="New subtask name"
          />
          <button disabled={saving || !subtaskTitle.trim()} type="submit">
            Create
          </button>
        </form>
        {!selected.parentId && !selected.archiveState.isArchived && (
          <div className="relationship-add">
            <select
              value={taskBreakdown}
              onChange={(event) =>
                setTaskBreakdown(event.target.value as TaskBreakdownTemplate)
              }
              aria-label="Task breakdown template"
            >
              <option value="bug">Bug breakdown</option>
              <option value="feature">Feature breakdown</option>
              <option value="research">Research breakdown</option>
              <option value="migration">Migration breakdown</option>
            </select>
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                void run(
                  () =>
                    createTaskBreakdown(selected.id, {
                      version: selected.version,
                      template: taskBreakdown,
                    }),
                  `${taskBreakdown[0]!.toUpperCase()}${taskBreakdown.slice(1)} task breakdown created.`,
                )
              }
            >
              Apply template
            </button>
          </div>
        )}
        {!selected.parentId && (
          <div className="relationship-add">
            <select
              value={childId}
              onChange={(event) => setChildId(event.target.value)}
              aria-label="Existing subtask"
            >
              <option value="">Link existing subtask…</option>
              {options(
                hierarchyCandidates.filter(
                  (item) => !item.childIds?.length && item.id !== selected.id,
                ),
              )}
            </select>
            <button
              type="button"
              disabled={saving || !childId}
              onClick={() => {
                const child = actionables.find(
                  (item) => item.id === Number(childId),
                );
                const oldParent = child?.parentId
                  ? actionables.find((item) => item.id === child.parentId)
                  : undefined;
                if (!child) return;
                void run(
                  () =>
                    setParent(child.id, {
                      version: child.version,
                      parentId: selected.id,
                      parentVersion: selected.version,
                      currentParentVersion: oldParent?.version,
                    }),
                  oldParent
                    ? "Subtask reassigned with both relationship changes recorded."
                    : "Existing actionable attached as a subtask.",
                ).then(() => setChildId(""));
              }}
            >
              Link
            </button>
          </div>
        )}
        {selectedParent && (
          <div className="relationship-add">
            <select
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
              aria-label="Replacement parent"
            >
              <option value="">Change parent…</option>
              {options(
                hierarchyCandidates.filter(
                  (item) => !item.parentId && !item.childIds?.length,
                ),
              )}
            </select>
            <button
              type="button"
              disabled={saving || !parentId}
              onClick={() => {
                const parent = actionables.find(
                  (item) => item.id === Number(parentId),
                );
                if (!parent) return;
                void run(
                  () =>
                    setParent(selected.id, {
                      version: selected.version,
                      parentId: parent.id,
                      parentVersion: parent.version,
                      currentParentVersion: selectedParent.version,
                    }),
                  "Subtask reassigned and detach/attach history recorded.",
                ).then(() => setParentId(""));
              }}
            >
              Move
            </button>
          </div>
        )}
      </div>
      <div className="relationship-group">
        <h3>
          Blocked by <span>{selected.relationships.blockedBy.length}</span>
        </h3>
        {selected.relationships.blockedBy.map((relationship) => (
          <div
            className="relationship-row dependency-row"
            key={relationship.id}
          >
            <button
              type="button"
              onClick={() => onNavigate(relationship.prerequisite.id)}
            >
              {relationship.prerequisite.id} · {relationship.prerequisite.title}
            </button>
            <span className={`dependency-state is-${relationship.state}`}>
              {relationship.state}
            </span>
            {relationship.state === "waived" ? (
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  void run(
                    () =>
                      restoreDependency(selected.id, relationship.id, {
                        version: selected.version,
                        prerequisiteVersion: relationship.prerequisite.version,
                      }),
                    "Dependency restored; derived blocking recalculated.",
                  )
                }
              >
                Restore
              </button>
            ) : (
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  const reason = window.prompt(
                    "Why is this dependency being waived?",
                  );
                  if (reason?.trim())
                    void run(
                      () =>
                        waiveDependency(selected.id, relationship.id, {
                          version: selected.version,
                          prerequisiteVersion:
                            relationship.prerequisite.version,
                          reason,
                        }),
                      "Dependency waived with its reason recorded.",
                    );
                }}
              >
                Waive
              </button>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                const reason = window.prompt(
                  "Why is this dependency being removed?",
                );
                if (reason?.trim())
                  void run(
                    () =>
                      removeDependency(selected.id, relationship.id, {
                        version: selected.version,
                        prerequisiteVersion: relationship.prerequisite.version,
                        reason,
                      }),
                    "Dependency removed; the relationship remains auditable.",
                  );
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="relationship-add">
          <select
            value={prerequisiteId}
            onChange={(event) => setPrerequisiteId(event.target.value)}
            aria-label="Prerequisite actionable"
          >
            <option value="">Add prerequisite…</option>
            {options(actionables.filter((item) => item.id !== selected.id))}
          </select>
          <button
            type="button"
            disabled={saving || !prerequisiteId}
            onClick={() => {
              const prerequisite = actionables.find(
                (item) => item.id === Number(prerequisiteId),
              );
              if (!prerequisite) return;
              void run(
                () =>
                  createDependency(selected.id, {
                    version: selected.version,
                    prerequisiteId: prerequisite.id,
                    prerequisiteVersion: prerequisite.version,
                  }),
                "Dependency added; derived blocking recalculated.",
              ).then(() => setPrerequisiteId(""));
            }}
          >
            Add
          </button>
        </div>
      </div>
      <div className="relationship-group">
        <h3>
          Blocks <span>{selected.relationships.blocks.length}</span>
        </h3>
        {selected.relationships.blocks.map((relationship) => (
          <div className="relationship-row" key={relationship.id}>
            <button
              type="button"
              onClick={() => onNavigate(relationship.dependent.id)}
            >
              {relationship.dependent.id} · {relationship.dependent.title}
            </button>
            <span className={`dependency-state is-${relationship.state}`}>
              {relationship.state}
            </span>
          </div>
        ))}
        <div className="relationship-add">
          <select
            value={dependentId}
            onChange={(event) => setDependentId(event.target.value)}
            aria-label="Dependent actionable"
          >
            <option value="">Link dependent…</option>
            {options(actionables.filter((item) => item.id !== selected.id))}
          </select>
          <button
            type="button"
            disabled={saving || !dependentId}
            onClick={() => {
              const dependent = actionables.find(
                (item) => item.id === Number(dependentId),
              );
              if (!dependent) return;
              void run(
                () =>
                  createDependency(dependent.id, {
                    version: dependent.version,
                    prerequisiteId: selected.id,
                    prerequisiteVersion: selected.version,
                  }),
                "Dependent linked; derived blocking recalculated.",
              ).then(() => setDependentId(""));
            }}
          >
            Link
          </button>
        </div>
      </div>
      {error && (
        <p className="relationship-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function LifecycleControls({
  selected,
  onMutated,
}: {
  selected: ActionableDetail;
  onMutated: (saved: ActionableDetail, notice: string) => void;
}) {
  const [target, setTarget] = useState<Status | null>(null);
  const [reason, setReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const needsReason =
    target === "Blocked" ||
    target === "Dismissed" ||
    (selected.status === "In progress" && target === "Researching") ||
    (target === "Ready" &&
      (selected.status === "Done" || selected.status === "Dismissed"));

  const submit = async () => {
    if (!target) return;
    setSaving(true);
    setError("");
    try {
      const saved = await transitionActionable(selected.id, {
        version: selected.version,
        status: target,
        reason: needsReason ? reason : undefined,
        completionOverrideReason:
          target === "Done" && overrideReason.trim()
            ? overrideReason
            : undefined,
        origin: "user",
      });
      const notice =
        target === "Done" && overrideReason.trim()
          ? "Completion override recorded distinctly from validated completion."
          : `Actionable moved to ${target}.`;
      setTarget(null);
      setReason("");
      setOverrideReason("");
      onMutated(saved, notice);
    } catch (caught) {
      if (caught instanceof ApiProblem) {
        setError(
          Object.values(caught.problem.errors ?? {})
            .flat()
            .join(" ") || caught.problem.title,
        );
        if (
          caught.problem.code === "VERSION_CONFLICT" &&
          caught.problem.current
        ) {
          onMutated(
            caught.problem.current,
            "This lifecycle action was stale and was not applied. The current version is loaded; your reason remains available.",
          );
        }
      } else {
        setError("The lifecycle action could not be completed.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="lifecycle-strip" aria-label="Lifecycle actions">
      <div className="lifecycle-heading">
        <strong>Lifecycle</strong>
        <span>Server-permitted actions</span>
      </div>
      {selected.manualBlocker && (
        <div className="manual-blocker">
          <strong>Blocked — manual</strong>
          <Markdown>{selected.manualBlocker}</Markdown>
        </div>
      )}
      {selected.readiness.blockers.length > 0 && (
        <div className="readiness-blockers" aria-label="Ready requirements">
          <strong>Before Ready</strong>
          <ul>
            {selected.readiness.blockers.map((blocker) => (
              <li key={blocker.field}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="lifecycle-actions">
        {selected.permittedTransitions.map((status) => (
          <button
            type="button"
            key={status}
            className={status === "Done" ? "lifecycle-done" : ""}
            onClick={() => {
              setTarget(status);
              setReason("");
              setOverrideReason("");
              setError("");
            }}
          >
            {status}
          </button>
        ))}
      </div>
      {target && (
        <div
          className="lifecycle-confirm"
          role="group"
          aria-label={`Move to ${target}`}
        >
          <div>
            <strong>
              {selected.status} → {target}
            </strong>
            {target === "Done" && (
              <p>
                {selected.completionEligibility.qualifyingValidationRecordId
                  ? "A current Passed validation qualifies. Leave override blank for validated completion."
                  : "No current validation qualifies. An override is exceptional and remains visibly distinct from validation."}
              </p>
            )}
            {target === "Dismissed" && (
              <p>Dismissal means no longer intended; it is not completion.</p>
            )}
            {target === "Ready" &&
              (selected.status === "Done" || selected.status === "Dismissed") &&
              selected.relationships.parent?.parent.status === "Done" && (
                <p>
                  Reopening this subtask will also reopen its Done parent to
                  Ready in the same transaction.
                </p>
              )}
          </div>
          {needsReason && (
            <label>
              <span>
                {target === "Blocked"
                  ? "Blocker note"
                  : target === "Dismissed"
                    ? "Dismissal reason"
                    : selected.status === "In progress" &&
                        target === "Researching"
                      ? "Research rollback reason"
                      : "Reopening reason"}
              </span>
              <textarea
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          )}
          {target === "Done" && (
            <label className="override-field">
              <span>
                Completion override reason
                {selected.completionEligibility.qualifyingValidationRecordId
                  ? " (optional and exceptional)"
                  : " (required without qualifying validation)"}
              </span>
              <textarea
                rows={2}
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
              />
            </label>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="lifecycle-confirm-actions">
            <button
              type="button"
              onClick={() => setTarget(null)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-action"
              onClick={submit}
              disabled={saving}
            >
              {saving
                ? "Saving…"
                : target === "Done" && overrideReason.trim()
                  ? "Complete with override"
                  : `Confirm ${target}`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ValidationRecords({
  selected,
  onMutated,
}: {
  selected: ActionableDetail;
  onMutated: (saved: ActionableDetail, notice: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ValidationType>("Automated test");
  const [outcome, setOutcome] = useState<ValidationOutcome>("Passed");
  const [notes, setNotes] = useState("");
  const [evidence, setEvidence] = useState("");
  const [supersedesId, setSupersedesId] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setOpen(false);
    setType("Automated test");
    setOutcome("Passed");
    setNotes("");
    setEvidence("");
    setSupersedesId(undefined);
    setError("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const saved = await recordValidation(selected.id, {
        version: selected.version,
        type,
        outcome,
        notes,
        evidence,
        origin: "user",
        supersedesId,
      });
      reset();
      onMutated(
        saved,
        supersedesId
          ? "Validation correction appended; the earlier record remains in history."
          : "Validation result appended.",
      );
    } catch (caught) {
      if (caught instanceof ApiProblem) {
        setError(
          Object.values(caught.problem.errors ?? {})
            .flat()
            .join(" ") || caught.problem.title,
        );
        if (
          caught.problem.code === "VERSION_CONFLICT" &&
          caught.problem.current
        ) {
          onMutated(
            caught.problem.current,
            "This validation save was stale and was not applied. The current version is loaded; your evidence remains in the form.",
          );
        }
      } else {
        setError("The validation result could not be saved.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="inspector-section validation-records">
      <div className="section-title-row">
        <div>
          <h3>Validation records</h3>
          <p className="section-help">
            {selected.completionEligibility.policy}
          </p>
        </div>
        <button
          type="button"
          className="secondary-action"
          onClick={() => {
            setOpen(true);
            setSupersedesId(undefined);
          }}
        >
          Record result
        </button>
      </div>
      {selected.validationRecords.map((record) => (
        <article
          className={`validation-record ${record.supersededById ? "is-superseded" : ""}`}
          key={record.id}
        >
          <header>
            <Badge tone={record.outcome}>{record.outcome}</Badge>
            <strong>{record.type}</strong>
            {record.qualifiesForCompletion && (
              <span className="qualifying-label">
                <CheckCircle2 aria-hidden="true" /> Qualifying
              </span>
            )}
            {record.supersededById && <span>Superseded</span>}
          </header>
          {record.notes && <Markdown>{record.notes}</Markdown>}
          {record.evidence && (
            <div className="validation-evidence">
              <span>Evidence</span>
              <Markdown>{record.evidence}</Markdown>
            </div>
          )}
          <footer>
            <time dateTime={record.recordedAt}>
              {new Date(record.recordedAt).toLocaleString()}
            </time>
            <span>{record.origin}</span>
            {!record.supersededById && (
              <button
                type="button"
                onClick={() => {
                  setOpen(true);
                  setSupersedesId(record.id);
                  setType(record.type);
                  setOutcome(record.outcome);
                  setNotes(record.notes);
                  setEvidence(record.evidence);
                }}
              >
                <RotateCcw aria-hidden="true" /> Correct
              </button>
            )}
          </footer>
        </article>
      ))}
      {selected.validationRecords.length === 0 && (
        <p className="section-help">
          No validation results have been recorded.
        </p>
      )}
      {open && (
        <form className="validation-form" onSubmit={submit}>
          <strong>
            {supersedesId
              ? "Append validation correction"
              : "Record validation result"}
          </strong>
          {supersedesId && (
            <p>
              The prior record remains unchanged and this record will point to
              it.
            </p>
          )}
          <div className="validation-form-grid">
            <label>
              <span>Type</span>
              <select
                value={type}
                onChange={(event) =>
                  setType(event.target.value as ValidationType)
                }
              >
                {[
                  "Automated test",
                  "Manual test",
                  "Command",
                  "Review",
                  "Document",
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Outcome</span>
              <select
                value={outcome}
                onChange={(event) =>
                  setOutcome(event.target.value as ValidationOutcome)
                }
              >
                {["Passed", "Failed", "Partial"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            <span>Notes</span>
            <textarea
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
          <label>
            <span>Evidence</span>
            <textarea
              rows={3}
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
            />
          </label>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="lifecycle-confirm-actions">
            <button type="button" onClick={reset} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="primary-action" disabled={saving}>
              {saving
                ? "Saving…"
                : supersedesId
                  ? "Append correction"
                  : "Record result"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function ActivityTimeline({ selected }: { selected: ActionableDetail }) {
  const groups = groupActivityByAgentSession(selected.activity);

  const agentSessionId = (agentId: string) => {
    const threadUrl = codexThreadUrlFromAgentId(agentId);
    return threadUrl ? (
      <strong className="mono activity-session-agent">
        <a href={threadUrl}>{agentId}</a>
      </strong>
    ) : (
      <strong className="mono">{agentId}</strong>
    );
  };

  const eventRow = (event: ActionableDetail["activity"][number]) => {
    const category = activityEventCategory(event);
    return (
      <article
        key={event.id}
        className={[
          event.type === "completion-overridden" ? "is-override" : "",
          category === "Failure" ? "is-failure" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <Activity aria-hidden="true" />
        <div>
          <span className="activity-event-category">{category}</span>
          <strong>{event.summary}</strong>
          {event.context.reason && <Markdown>{event.context.reason}</Markdown>}
          <time dateTime={event.occurredAt}>
            {new Date(event.occurredAt).toLocaleString()}
          </time>
        </div>
      </article>
    );
  };

  return (
    <section className="inspector-section activity-timeline">
      <h3>Activity</h3>
      {groups.map((group) =>
        group.kind === "session" ? (
          <section className="activity-session" key={group.id}>
            <header>
              <div>
                <span>Agent session</span>
                {agentSessionId(group.agentId)}
              </div>
              <span
                className={`activity-session-state is-${group.state
                  .toLowerCase()
                  .replace(" ", "-")}`}
              >
                {group.state}
              </span>
            </header>
            <p className="activity-session-time">
              <time dateTime={group.startedAt}>
                Started {new Date(group.startedAt).toLocaleString()}
              </time>
              {group.endedAt && (
                <>
                  {" · "}
                  <time dateTime={group.endedAt}>
                    Ended {new Date(group.endedAt).toLocaleString()}
                  </time>
                </>
              )}
            </p>
            <div className="activity-session-events">
              {group.events.map(eventRow)}
            </div>
          </section>
        ) : (
          <div className="activity-other-events" key={group.id}>
            {group.events.map(eventRow)}
          </div>
        ),
      )}
      {groups.length === 0 && <p>No activity has been recorded.</p>}
    </section>
  );
}

function AgentClaimPanel({
  selected,
  onNotice,
  onReleaseClaim,
}: {
  selected: ActionableDetail;
  onNotice: (notice: string) => void;
  onReleaseClaim: () => void;
}) {
  const claim = selected.agentClaim;
  const claimantUrl = claim ? codexThreadUrlFromAgentId(claim.agentId) : null;
  const isTerminal =
    selected.status === "Done" || selected.status === "Dismissed";
  const hasReadyBlockers = selected.readiness.requiredForReady.length > 0;
  const canRecommendPrompt =
    !claim &&
    !selected.archiveState.isArchived &&
    !selected.isEffectivelyBlocked &&
    !isTerminal &&
    !(selected.status === "Ready" && hasReadyBlockers);
  const promptSettingsQuery = useQuery({
    queryKey: ["helper-agent-settings"],
    queryFn: fetchHelperAgentSettings,
  });
  const workspaceQuery = useQuery({
    queryKey: [
      "codex-workspace",
      selected.id,
      selected.version,
      selected.workspacePath,
      selected.projectRoot,
    ],
    queryFn: () => fetchCodexWorkspace(selected.id),
    enabled: canRecommendPrompt && Boolean(selected.projectRoot),
    retry: false,
  });
  const startPrompt =
    canRecommendPrompt &&
    (!selected.projectRoot ||
      (workspaceQuery.isSuccess && !workspaceQuery.isFetching)) &&
    promptSettingsQuery.data &&
    !promptSettingsQuery.isError
      ? renderCodexStartPrompt(selected, promptSettingsQuery.data)
      : null;
  const preparedChatUrl = startPrompt
    ? buildCodexNewChatUrl(
        startPrompt,
        selected.projectRoot
          ? workspaceQuery.data!.path
          : selected.workspacePath,
      )
    : null;
  const unavailableGuidance = selected.archiveState.isArchived
    ? "Restore this Actionable before starting agent work."
    : isTerminal
      ? `Reopen this ${selected.status} Actionable before starting agent work.`
      : claim
        ? null
        : selected.isEffectivelyBlocked
          ? "Resolve this Actionable's blockers before starting agent work."
          : selected.status === "Ready" && hasReadyBlockers
            ? "Restore every Ready prerequisite before starting implementation."
            : null;

  const copyStartPrompt = async () => {
    if (!startPrompt) return;
    if (await copyText(startPrompt))
      onNotice("Codex start-task prompt copied.");
    else window.prompt("Copy this Codex start-task prompt:", startPrompt);
  };

  return (
    <section
      className={`agent-claim-panel ${claim?.state === "expired" ? "is-expired" : ""}`}
      aria-labelledby={`agent-claim-title-${selected.id}`}
    >
      <div className="agent-claim-heading">
        <div>
          <h3 id={`agent-claim-title-${selected.id}`} tabIndex={-1}>
            Agent claim
          </h3>
          <p>
            {claim
              ? claim.state === "expired"
                ? "This lease has expired and no longer permits agent work."
                : "An agent currently holds the task lease."
              : "No agent currently holds this task."}
          </p>
        </div>
        <Badge tone={claim?.state === "expired" ? "Failed" : "Inbox"}>
          {claim
            ? claim.state === "expired"
              ? "Expired"
              : "Claimed"
            : "Unclaimed"}
        </Badge>
      </div>
      {claim && (
        <dl className="agent-claim-details">
          <div>
            <dt>Claimant</dt>
            <dd className="mono">
              {claimantUrl ? (
                <a href={claimantUrl}>{claimantUrl}</a>
              ) : (
                claim.agentId
              )}
            </dd>
          </div>
          <div>
            <dt>Lease expiry</dt>
            <dd>
              <time dateTime={claim.leaseExpiresAt}>
                {new Date(claim.leaseExpiresAt).toLocaleString()}
              </time>
            </dd>
          </div>
          <div>
            <dt>Task state</dt>
            <dd>{selected.status}</dd>
          </div>
        </dl>
      )}
      {startPrompt && (
        <div className="agent-start-prompt">
          <div className="agent-start-heading">
            <span>Start with Codex</span>
            <div className="agent-start-actions">
              {preparedChatUrl && (
                <a className="toolbar-button" href={preparedChatUrl}>
                  <ExternalLink aria-hidden="true" />
                  Open in Codex
                </a>
              )}
              <button
                type="button"
                className="toolbar-button"
                onClick={copyStartPrompt}
                aria-label="Copy Codex start-task prompt"
              >
                <Copy aria-hidden="true" />
                Copy prompt
              </button>
            </div>
          </div>
        </div>
      )}
      {unavailableGuidance && (
        <p className="agent-start-guidance">{unavailableGuidance}</p>
      )}
      {canRecommendPrompt && promptSettingsQuery.isPending && (
        <p className="agent-start-guidance" role="status">
          Loading Codex prompt settings…
        </p>
      )}
      {canRecommendPrompt && promptSettingsQuery.isError && (
        <div className="inline-error" role="alert">
          <p>
            Could not load Codex prompt settings. Retry before starting this
            task.
          </p>
          <button
            type="button"
            className="toolbar-button"
            onClick={() => void promptSettingsQuery.refetch()}
          >
            Retry prompt settings
          </button>
        </div>
      )}
      {canRecommendPrompt &&
        selected.projectRoot &&
        workspaceQuery.isFetching && (
          <p className="agent-start-guidance" role="status">
            Checking the project directory…
          </p>
        )}
      {canRecommendPrompt && selected.projectRoot && workspaceQuery.isError && (
        <div className="inline-error" role="alert">
          <p>
            {workspaceQuery.error instanceof ApiProblem
              ? (workspaceQuery.error.problem.errors?.projectRoot?.join(" ") ??
                workspaceQuery.error.problem.title)
              : "Could not check the project directory. Retry before starting this task."}
          </p>
          <button
            type="button"
            className="toolbar-button"
            onClick={() => void workspaceQuery.refetch()}
          >
            Retry project directory
          </button>
        </div>
      )}
      {claim && (
        <button
          type="button"
          className="toolbar-button agent-claim-release"
          onClick={onReleaseClaim}
          aria-label={
            claim.state === "expired"
              ? `Release expired claim held by ${claim.agentId}`
              : `Force release claim held by ${claim.agentId}`
          }
        >
          {claim.state === "expired"
            ? "Release stale claim"
            : "Force release claim"}
        </button>
      )}
    </section>
  );
}

function NoteGroomer({
  selected,
  onMutated,
}: {
  selected: ActionableDetail;
  onMutated: (saved: ActionableDetail, notice: string) => void;
}) {
  const [proposal, setProposal] = useState<GroomActionableNotesProposal | null>(
    null,
  );
  const [basedOnVersion, setBasedOnVersion] = useState<number | null>(null);
  const [model, setModel] = useState("");
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");

  const generate = async () => {
    setRunning(true);
    setError("");
    try {
      const response = await groomActionableNotes(selected.id, {
        version: selected.version,
      });
      setProposal(response.proposal);
      setBasedOnVersion(response.basedOnVersion);
      setModel(response.model);
    } catch (caught) {
      setError(
        caught instanceof ApiProblem
          ? [caught.problem.title, caught.problem.detail]
              .filter(Boolean)
              .join(" ")
          : "The local assistant could not generate a proposal.",
      );
    } finally {
      setRunning(false);
    }
  };

  const apply = async () => {
    if (!proposal || basedOnVersion !== selected.version) {
      setError(
        "This proposal is based on an older saved version. Generate it again.",
      );
      return;
    }
    setApplying(true);
    setError("");
    try {
      const saved = await updateActionable(selected.id, {
        version: selected.version,
        title: selected.title,
        priority: selected.priority,
        status: selected.status,
        effort: selected.effort,
        evidenceState: selected.evidenceState,
        projectId: selected.scope.projectId,
        repositoryId: selected.scope.repositoryId,
        worktreeId: selected.scope.worktreeId,
        finding: selected.finding,
        description: proposal.description,
        research: proposal.research,
        validation: proposal.validation,
        tags: selected.tags,
        userSources: selected.userSources.map(({ type, locator, label }) => ({
          type,
          locator,
          label,
        })),
      });
      onMutated(saved, "Reviewed note-grooming proposal applied.");
    } catch (caught) {
      setError(
        caught instanceof ApiProblem
          ? [caught.problem.title, caught.problem.detail]
              .filter(Boolean)
              .join(" ")
          : "The reviewed proposal could not be applied.",
      );
    } finally {
      setApplying(false);
    }
  };

  return (
    <section className="assistant-panel inspector-section note-groomer">
      <div className="assistant-heading">
        <div>
          <h3>Groom notes with local Codex</h3>
          <p className="section-help">
            Reorganizes description, research, and planned validation.
            Generation does not save changes.
          </p>
        </div>
        <button
          type="button"
          className="toolbar-button"
          disabled={running || applying}
          onClick={generate}
        >
          {running ? "Generating…" : proposal ? "Generate again" : "Generate"}
        </button>
      </div>

      {error && (
        <p className="relationship-error" role="alert">
          {error}
        </p>
      )}

      {proposal && (
        <div className="assistant-proposal">
          <details className="assistant-original">
            <summary>Compare original notes</summary>
            <h4>Description</h4>
            {selected.description ? (
              <Markdown>{selected.description}</Markdown>
            ) : (
              <p>No description.</p>
            )}
            <h4>Research</h4>
            {selected.research.length > 0 ? (
              selected.research.map((note) => (
                <Markdown key={note}>{note}</Markdown>
              ))
            ) : (
              <p>No research notes.</p>
            )}
            <h4>Planned validation</h4>
            {selected.validation.length > 0 ? (
              selected.validation.map((step) => (
                <Markdown key={step}>{step}</Markdown>
              ))
            ) : (
              <p>No planned validation.</p>
            )}
          </details>
          <p className="assistant-provenance">
            Proposal from <code>{model}</code>, based on saved version{" "}
            {basedOnVersion}. Review every field before applying.
          </p>
          {proposal.changes.length > 0 && (
            <ul>
              {proposal.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          )}
          <label>
            <span>Description</span>
            <textarea
              rows={5}
              value={proposal.description}
              onChange={(event) =>
                setProposal((current) =>
                  current
                    ? { ...current, description: event.target.value }
                    : current,
                )
              }
            />
          </label>
          <label>
            <span>Research notes</span>
            <small>One note per line.</small>
            <textarea
              rows={6}
              value={proposal.research.join("\n")}
              onChange={(event) =>
                setProposal((current) =>
                  current
                    ? { ...current, research: lines(event.target.value) }
                    : current,
                )
              }
            />
          </label>
          <label>
            <span>Planned validation</span>
            <small>
              One future check per line; these are not test results.
            </small>
            <textarea
              rows={6}
              value={proposal.validation.join("\n")}
              onChange={(event) =>
                setProposal((current) =>
                  current
                    ? { ...current, validation: lines(event.target.value) }
                    : current,
                )
              }
            />
          </label>
          <div className="assistant-actions">
            <button
              type="button"
              className="primary-action"
              disabled={applying}
              onClick={apply}
            >
              {applying ? "Applying…" : "Apply reviewed proposal"}
            </button>
            <button
              type="button"
              disabled={applying}
              onClick={() => {
                setProposal(null);
                setBasedOnVersion(null);
                setModel("");
                setError("");
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Inspector({
  selected,
  actionables,
  activeTab,
  setActiveTab,
  onCloseMobile,
  validationChecks,
  toggleValidation,
  onEdit,
  onMutated,
  onNavigate,
  onNotice,
  onArchive,
  onReleaseClaim,
}: {
  selected: ActionableDetail;
  actionables: ActionableSummary[];
  activeTab: InspectorTab;
  setActiveTab: (tab: InspectorTab) => void;
  onCloseMobile: () => void;
  validationChecks: Set<string>;
  toggleValidation: (key: string) => void;
  onEdit: () => void;
  onMutated: (saved: ActionableDetail, notice: string) => void;
  onNavigate: (id: number) => void;
  onNotice: (notice: string) => void;
  onArchive: () => void;
  onReleaseClaim: () => void;
}) {
  const helperSettingsQuery = useQuery({
    queryKey: ["helper-agent-settings"],
    queryFn: fetchHelperAgentSettings,
  });
  const noteGroomerEnabled =
    helperSettingsQuery.data?.noteGroomerEnabled === true;
  const relationshipAuditorEnabled =
    helperSettingsQuery.data?.relationshipAuditorEnabled === true;
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || activeTab !== "activity") return;

    const updateFocusability = () => {
      // Timeline links already provide keyboard access to their scroll container.
      const hasLink = [
        ...content.querySelectorAll<HTMLAnchorElement>("a[href]"),
      ].some((link) => link.tabIndex >= 0 && link.getClientRects().length > 0);
      const overflows =
        content.scrollHeight > content.clientHeight ||
        content.scrollWidth > content.clientWidth;
      if (overflows && !hasLink) content.tabIndex = 0;
      else content.removeAttribute("tabindex");
    };
    const resizeObserver = new ResizeObserver(updateFocusability);
    resizeObserver.observe(content);
    if (content.firstElementChild)
      resizeObserver.observe(content.firstElementChild);
    const mutationObserver = new MutationObserver(updateFocusability);
    mutationObserver.observe(content, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    updateFocusability();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      content.removeAttribute("tabindex");
    };
  }, [activeTab, selected.activity]);

  return (
    <>
      <header className="inspector-header">
        <div className="inspector-title-row">
          <button type="button" className="mobile-back" onClick={onCloseMobile}>
            <ChevronRight aria-hidden="true" /> Findings
          </button>
          <h2>{selected.title}</h2>
          <div className="inspector-actions">
            <IconButton label="Edit actionable" onClick={onEdit}>
              <Pencil />
            </IconButton>
            {!selected.archiveState.isArchived && (
              <IconButton label="Archive actionable" onClick={onArchive}>
                <Archive />
              </IconButton>
            )}
            {selected.archiveState.directlyArchived && (
              <IconButton label="Restore actionable" onClick={onArchive}>
                <ArchiveRestore />
              </IconButton>
            )}
          </div>
        </div>
        <div className="metadata-row">
          <Badge tone={selected.priority}>{selected.priority}</Badge>
          <Badge
            tone={selected.status}
            title={selected.statusProvenance.note}
            ariaLabel={`${selected.status}. ${selected.statusProvenance.note}`}
          >
            {selected.status}
          </Badge>
          <span className="metadata-divider" />
          <span className="mono metadata-item">
            <GitBranch aria-hidden="true" />
            {selected.worktree}
          </span>
          <span className="metadata-divider" />
          <span className="metadata-item">
            <span className="effort-mark">{selected.effort}</span>
          </span>
          <span className="metadata-divider" />
          <span className="metadata-item">
            <Clock3 aria-hidden="true" />
            {selected.updated}
          </span>
        </div>
      </header>

      {selected.archiveState.isArchived && (
        <div className="archived-banner" role="status">
          <Archive aria-hidden="true" />
          <div>
            <strong>Archived actionable</strong>
            <span>
              {selected.archiveState.directlyArchived
                ? "Hidden from normal views. Restore preserves workflow, validation, relationships, and history."
                : `Hidden by archived ${selected.archiveState.inheritedFrom.join(" and ")}. Restore that scope first.`}
            </span>
          </div>
          {selected.archiveState.directlyArchived && (
            <button type="button" onClick={onArchive}>
              Restore
            </button>
          )}
        </div>
      )}

      {!selected.archiveState.isArchived && (
        <LifecycleControls
          key={`lifecycle-${selected.id}`}
          selected={selected}
          onMutated={onMutated}
        />
      )}

      <AgentClaimPanel
        selected={selected}
        onNotice={onNotice}
        onReleaseClaim={onReleaseClaim}
      />

      <nav
        className="inspector-tabs"
        aria-label="Actionable detail"
        role="tablist"
      >
        {(
          [
            ["finding", "Finding"],
            ["research", "Research notes"],
            ["resolution", "Resolution"],
            ["validation", "Validation"],
            ["relationships", "Relationships"],
            ["activity", "Activity"],
          ] satisfies [InspectorTab, string][]
        ).map(([tab, label]) => (
          <button
            type="button"
            key={tab}
            className={activeTab === tab ? "is-active" : ""}
            aria-selected={activeTab === tab}
            role="tab"
            onClick={() => setActiveTab(tab)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div
        className="inspector-content"
        ref={contentRef}
        role={activeTab === "activity" ? "region" : undefined}
        aria-label={activeTab === "activity" ? "Activity" : undefined}
      >
        {activeTab === "finding" && (
          <>
            <section className="inspector-section">
              <h3>Finding</h3>
              {selected.finding ? (
                <Markdown>{selected.finding}</Markdown>
              ) : (
                <p>No finding has been written yet.</p>
              )}
            </section>
            <section className="inspector-section">
              <h3>Description</h3>
              {selected.description ? (
                <Markdown>{selected.description}</Markdown>
              ) : (
                <p>No intended result has been written yet.</p>
              )}
            </section>

            <section className="inspector-section">
              <h3>Files and symbols</h3>
              <div className="file-list">
                {selected.files.map((file) => (
                  <div
                    className="file-row"
                    key={`${file.path}-${file.lines ?? file.symbol ?? ""}`}
                  >
                    <FileCode2 aria-hidden="true" />
                    <code>{file.path}</code>
                    <span>{file.symbol ?? file.lines ?? "reference"}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="inspector-section">
              <h3>Research notes</h3>
              {selected.research.length > 0 ? (
                <div className="research-list">
                  {selected.research.map((note) => (
                    <Markdown key={note}>{note}</Markdown>
                  ))}
                </div>
              ) : (
                <p>No research notes yet.</p>
              )}
            </section>

            <section className="inspector-section">
              <h3>Validation</h3>
              {selected.validation.length > 0 ? (
                <div className="validation-list">
                  {selected.validation.map((step, index) => {
                    const key = `${selected.id}-${index}`;
                    return (
                      <label key={key}>
                        <input
                          type="checkbox"
                          checked={validationChecks.has(key)}
                          onChange={() => toggleValidation(key)}
                        />
                        <Markdown inline>{step}</Markdown>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p>No validation plan yet.</p>
              )}
            </section>
            <SourceHistory selected={selected} onNotice={onNotice} />
          </>
        )}

        {activeTab === "research" && (
          <>
            <section className="inspector-section tab-lead">
              <h3>Research notes</h3>
              <div className="finding-callout">
                <Markdown>{selected.finding}</Markdown>
              </div>
              <div className="research-list expanded">
                {selected.research.map((note) => (
                  <Markdown key={note}>{note}</Markdown>
                ))}
              </div>
            </section>
            {noteGroomerEnabled && !selected.archiveState.isArchived && (
              <NoteGroomer
                key={`note-groomer-${selected.id}-${selected.version}`}
                selected={selected}
                onMutated={onMutated}
              />
            )}
            <SourceHistory selected={selected} onNotice={onNotice} />
          </>
        )}

        {activeTab === "resolution" && (
          <section className="inspector-section tab-lead">
            <h3>Resolution</h3>
            <p className="section-help">
              Describe the completed changes and important implementation
              decisions. Resolution content is required before this actionable
              can be marked Done.
            </p>
            {selected.resolution ? (
              <Markdown>{selected.resolution}</Markdown>
            ) : (
              <p>No resolution has been recorded yet.</p>
            )}
          </section>
        )}

        {activeTab === "validation" && (
          <>
            <section className="inspector-section tab-lead">
              <h3>Validation procedure</h3>
              <p className="section-help">
                This is the editable plan. Completion uses the append-only
                records below, not these local reading checkmarks.
              </p>
              <div className="validation-list validation-large">
                {selected.validation.map((step, index) => {
                  const key = `${selected.id}-${index}`;
                  return (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={validationChecks.has(key)}
                        onChange={() => toggleValidation(key)}
                      />
                      <Markdown inline>{step}</Markdown>
                    </label>
                  );
                })}
              </div>
            </section>
            <ValidationRecords
              key={`validation-${selected.id}`}
              selected={selected}
              onMutated={onMutated}
            />
          </>
        )}

        {activeTab === "relationships" && (
          <RelationshipSection
            selected={selected}
            actionables={actionables}
            relationshipAuditorEnabled={relationshipAuditorEnabled}
            onNavigate={onNavigate}
            onMutated={onMutated}
          />
        )}

        {activeTab === "activity" && <ActivityTimeline selected={selected} />}
      </div>
    </>
  );
}

type ActionableDraft = {
  title: string;
  priority: Priority;
  status: Status;
  effort: Effort;
  evidenceState: EvidenceState;
  projectId: string;
  repositoryId: string;
  worktreeId: string;
  finding: string;
  description: string;
  resolution: string;
  researchText: string;
  validationText: string;
  tagsText: string;
  userSources: UserSourceReferenceInput[];
  version: number;
};

function lines(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function draftFromItem(item: ActionableDetail): ActionableDraft {
  return {
    title: item.title,
    priority: item.priority,
    status: item.status,
    effort: item.effort,
    evidenceState: item.evidenceState,
    projectId: item.scope.projectId,
    repositoryId: item.scope.repositoryId,
    worktreeId: item.scope.worktreeId,
    finding: item.finding,
    description: item.description,
    resolution: item.resolution,
    researchText: item.research.join("\n"),
    validationText: item.validation.join("\n"),
    tagsText: item.tags.join(", "),
    userSources: item.userSources.map(({ type, locator, label }) => ({
      type,
      locator,
      label,
    })),
    version: item.version,
  };
}

function emptyDraft(
  scopes: ScopeOptionsResponse,
  initialScope?: {
    projectId?: string;
    repositoryId?: string;
    worktreeId?: string;
  },
): ActionableDraft {
  const scope = resolveCreationScope(
    scopes,
    initialScope,
    readDefaultCreationWorktree(),
  );
  return {
    title: "",
    priority: "Unset",
    status: "Inbox",
    effort: "Unknown",
    evidenceState: "Unclassified",
    projectId: scope?.projectId ?? "",
    repositoryId: scope?.repositoryId ?? "",
    worktreeId: scope?.worktreeId ?? "",
    finding: "",
    description: "",
    resolution: "",
    researchText: "",
    validationText: "",
    tagsText: "",
    userSources: [],
    version: 1,
  };
}

function fieldError(errors: Record<string, string[]>, field: string) {
  const messages = errors[field];
  return messages ? (
    <span className="field-error" id={`${field}-error`}>
      {messages.join(" ")}
    </span>
  ) : null;
}

function ActionableForm({
  item,
  scopes,
  initialScope,
  onClose,
  onSaved,
}: {
  item?: ActionableDetail;
  scopes: ScopeOptionsResponse;
  initialScope?: {
    projectId?: string;
    repositoryId?: string;
    worktreeId?: string;
  };
  onClose: () => void;
  onSaved: (saved: ActionableDetail, created: boolean) => void;
}) {
  const initialDraft = useMemo(
    () => (item ? draftFromItem(item) : emptyDraft(scopes, initialScope)),
    [initialScope, item, scopes],
  );
  const [draft, setDraft] = useState(initialDraft);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ActionableDetail | null>(null);
  const [reviewCurrent, setReviewCurrent] = useState(false);
  const [formNotice, setFormNotice] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const initialSnapshot = useMemo(
    () => JSON.stringify(initialDraft),
    [initialDraft],
  );
  const dirty = JSON.stringify(draft) !== initialSnapshot;

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useModalIsolation(dialogRef);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  const project = scopes.projects.find(
    (candidate) => candidate.id === draft.projectId,
  );
  const repositories = project?.repositories ?? [];
  const repository = repositories.find(
    (candidate) => candidate.id === draft.repositoryId,
  );
  const worktrees = repository?.worktrees ?? [];

  const update = <K extends keyof ActionableDraft>(
    key: K,
    value: ActionableDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const matchingKeys = Object.keys(current).filter(
        (errorKey) =>
          errorKey === key || errorKey.startsWith(`${String(key)}.`),
      );
      if (matchingKeys.length === 0) return current;
      const next = { ...current };
      for (const errorKey of matchingKeys) delete next[errorKey];
      return next;
    });
  };

  const requestClose = () => {
    if (dirty && !window.confirm("Discard your unsaved actionable changes?"))
      return;
    onClose();
  };

  const addSource = () => {
    update("userSources", [
      ...draft.userSources,
      { type: "File", locator: "", label: "" },
    ]);
  };

  const updateSource = (
    index: number,
    key: keyof UserSourceReferenceInput,
    value: string,
  ) => {
    const next = draft.userSources.map((source, sourceIndex) =>
      sourceIndex === index ? { ...source, [key]: value } : source,
    );
    update("userSources", next);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    setConflict(null);
    setFormNotice(item ? "Saving changes…" : "Creating actionable…");

    const base: CreateActionableRequest = {
      title: draft.title,
      priority: draft.priority,
      effort: draft.effort,
      evidenceState: draft.evidenceState,
      projectId: draft.projectId,
      repositoryId: draft.repositoryId,
      worktreeId: draft.worktreeId,
      finding: draft.finding,
      description: draft.description,
      resolution: draft.resolution,
      research: lines(draft.researchText),
      validation: lines(draft.validationText),
      tags: draft.tagsText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      userSources: draft.userSources,
    };

    try {
      const saved = item
        ? await updateActionable(item.id, {
            ...base,
            status: draft.status,
            version: draft.version,
          })
        : await createActionable(base);
      setFormNotice(item ? "Changes saved." : "Actionable created.");
      onSaved(saved, !item);
    } catch (error) {
      if (error instanceof ApiProblem) {
        setErrors(error.problem.errors ?? {});
        if (
          error.problem.code === "VERSION_CONFLICT" &&
          error.problem.current
        ) {
          setConflict(error.problem.current);
          setFormNotice(
            "A newer saved version was found. Your draft is still here.",
          );
        } else {
          setFormNotice(
            `${error.problem.title} Request ${error.problem.requestId}.`,
          );
        }
      } else {
        setFormNotice(
          "The actionable could not be saved. Your draft is still here.",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const errorEntries = Object.entries(errors);
  return (
    <div
      className="form-backdrop"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === "Escape") requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="actionable-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="actionable-form-title"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ].filter((element) => element.offsetParent !== null);
          const first = controls[0];
          const last = controls.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="dialog-header">
          <div>
            <span className="dialog-eyebrow">
              {item ? `Version ${draft.version}` : "Neutral status: Inbox"}
            </span>
            <h2 id="actionable-form-title">
              {item ? "Edit actionable" : "New actionable"}
            </h2>
          </div>
          <IconButton label="Close actionable form" onClick={requestClose}>
            <X />
          </IconButton>
        </header>

        <form onSubmit={submit} noValidate>
          <div className="dialog-content">
            {errorEntries.length > 0 && (
              <div
                className="error-summary"
                role="alert"
                aria-labelledby="error-summary-title"
              >
                <strong id="error-summary-title">
                  Check the highlighted fields.
                </strong>
                <ul>
                  {errorEntries.map(([field, messages]) => (
                    <li key={field}>
                      <a href={`#${field}`}>{messages.join(" ")}</a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {conflict && (
              <div className="conflict-panel" role="alert">
                <strong>
                  Someone saved version {conflict.version} while you were
                  editing version {draft.version}.
                </strong>
                <p>Your unsaved draft has not been changed or discarded.</p>
                <div className="conflict-actions">
                  <button
                    type="button"
                    onClick={() => setReviewCurrent((value) => !value)}
                  >
                    {reviewCurrent
                      ? "Hide current saved version"
                      : "Review current saved version"}
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(
                        JSON.stringify(draft, null, 2),
                      );
                      setFormNotice("Draft copied to the clipboard.");
                    }}
                  >
                    Copy my draft
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft((current) => ({
                        ...current,
                        version: conflict.version,
                      }));
                      setConflict(null);
                      setReviewCurrent(false);
                      setFormNotice(
                        "Current version loaded. Your field values remain ready to reapply.",
                      );
                    }}
                  >
                    Reload version and reapply draft
                  </button>
                </div>
                {reviewCurrent && (
                  <dl className="current-version">
                    <div>
                      <dt>Title</dt>
                      <dd>{conflict.title}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{conflict.status}</dd>
                    </div>
                    <div>
                      <dt>Updated</dt>
                      <dd>{conflict.updated}</dd>
                    </div>
                  </dl>
                )}
              </div>
            )}

            <div className="form-grid">
              <label className="form-field form-field-wide" htmlFor="title">
                <span>
                  Title <b aria-hidden="true">*</b>
                </span>
                <small>
                  A concise outcome or next action. This is the only content
                  required for Inbox capture.
                </small>
                <input
                  ref={titleRef}
                  id="title"
                  value={draft.title}
                  onChange={(event) => update("title", event.target.value)}
                  aria-invalid={Boolean(errors.title)}
                  aria-describedby={
                    errors.title ? "title-help title-error" : "title-help"
                  }
                />
                <span id="title-help" className="sr-only">
                  Required at capture time.
                </span>
                {fieldError(errors, "title")}
              </label>

              <label className="form-field" htmlFor="priority">
                <span>Priority</span>
                <small>Leave Unset when it has not been established.</small>
                <select
                  id="priority"
                  value={draft.priority}
                  onChange={(event) =>
                    update("priority", event.target.value as Priority)
                  }
                >
                  {priorities.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>

              <label className="form-field" htmlFor="status">
                <span>Workflow status</span>
                <small>
                  {item
                    ? "Use the server-permitted lifecycle actions in the inspector so guarded transitions collect their evidence."
                    : "New manual items start in Inbox; triage after creation."}
                </small>
                <select
                  id="status"
                  value={draft.status}
                  disabled
                  onChange={() => undefined}
                >
                  <option>{draft.status}</option>
                </select>
                {fieldError(errors, "status")}
              </label>

              <label className="form-field" htmlFor="effort">
                <span>Likely effort</span>
                <small>Use Unknown instead of guessing.</small>
                <select
                  id="effort"
                  value={draft.effort}
                  onChange={(event) =>
                    update("effort", event.target.value as Effort)
                  }
                >
                  {efforts.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>

              <label className="form-field" htmlFor="evidenceState">
                <span>Evidence state</span>
                <small>Describe how established the finding is.</small>
                <select
                  id="evidenceState"
                  value={draft.evidenceState}
                  onChange={(event) =>
                    update("evidenceState", event.target.value as EvidenceState)
                  }
                >
                  {evidenceStates.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>

              <label className="form-field" htmlFor="projectId">
                <span>Project</span>
                <select
                  id="projectId"
                  value={draft.projectId}
                  onChange={(event) => {
                    const nextProject = scopes.projects.find(
                      (candidate) => candidate.id === event.target.value,
                    );
                    const nextRepository = nextProject?.repositories[0];
                    setDraft((current) => ({
                      ...current,
                      projectId: event.target.value,
                      repositoryId: nextRepository?.id ?? "",
                      worktreeId: nextRepository?.worktrees[0]?.id ?? "",
                    }));
                  }}
                >
                  {scopes.projects.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
                    </option>
                  ))}
                </select>
                {fieldError(errors, "projectId")}
              </label>

              <label className="form-field" htmlFor="repositoryId">
                <span>Repository</span>
                <select
                  id="repositoryId"
                  value={draft.repositoryId}
                  onChange={(event) => {
                    const nextRepository = repositories.find(
                      (candidate) => candidate.id === event.target.value,
                    );
                    setDraft((current) => ({
                      ...current,
                      repositoryId: event.target.value,
                      worktreeId: nextRepository?.worktrees[0]?.id ?? "",
                    }));
                  }}
                >
                  {repositories.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
                    </option>
                  ))}
                </select>
                {fieldError(errors, "repositoryId")}
              </label>

              <label className="form-field" htmlFor="worktreeId">
                <span>Worktree</span>
                <select
                  id="worktreeId"
                  value={draft.worktreeId}
                  onChange={(event) => update("worktreeId", event.target.value)}
                >
                  {worktrees.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
                    </option>
                  ))}
                </select>
                {fieldError(errors, "worktreeId")}
              </label>

              <label className="form-field form-field-wide" htmlFor="finding">
                <span>Finding</span>
                <small>
                  User-authored statement of what is known. Required only before
                  Ready.
                </small>
                <textarea
                  id="finding"
                  rows={3}
                  value={draft.finding}
                  onChange={(event) => update("finding", event.target.value)}
                />
                {fieldError(errors, "finding")}
              </label>

              <label
                className="form-field form-field-wide"
                htmlFor="description"
              >
                <span>Description</span>
                <small>
                  Intended result or bounded next investigation. Required only
                  before Ready.
                </small>
                <textarea
                  id="description"
                  rows={5}
                  value={draft.description}
                  onChange={(event) =>
                    update("description", event.target.value)
                  }
                />
                {fieldError(errors, "description")}
              </label>

              <label
                className="form-field form-field-wide"
                htmlFor="resolution"
              >
                <span>Resolution</span>
                <small>
                  Completed changes and important implementation decisions.
                  Required before Done.
                </small>
                <textarea
                  id="resolution"
                  rows={5}
                  value={draft.resolution}
                  onChange={(event) => update("resolution", event.target.value)}
                />
                {fieldError(errors, "resolution")}
              </label>

              <label className="form-field form-field-wide" htmlFor="research">
                <span>Research notes</span>
                <small>
                  One Markdown note per line. Leave blank rather than inventing
                  research.
                </small>
                <textarea
                  id="research"
                  rows={5}
                  value={draft.researchText}
                  onChange={(event) =>
                    update("researchText", event.target.value)
                  }
                />
                {fieldError(errors, "research")}
              </label>

              <label
                className="form-field form-field-wide"
                htmlFor="validation"
              >
                <span>Validation plan</span>
                <small>
                  One check per line. At least one check is required before
                  Ready.
                </small>
                <textarea
                  id="validation"
                  rows={5}
                  value={draft.validationText}
                  onChange={(event) =>
                    update("validationText", event.target.value)
                  }
                />
                {fieldError(errors, "validation")}
              </label>

              <label className="form-field form-field-wide" htmlFor="tags">
                <span>Tags</span>
                <small>Comma-separated user-authored labels.</small>
                <input
                  id="tags"
                  value={draft.tagsText}
                  onChange={(event) => update("tagsText", event.target.value)}
                />
                {fieldError(errors, "tags")}
              </label>

              <fieldset className="source-editor form-field-wide">
                <legend>User-added source references</legend>
                <p>
                  Add only references you know. Imported evidence remains
                  read-only outside this form.
                </p>
                {draft.userSources.map((source, index) => (
                  <div className="source-edit-row" key={index}>
                    <label>
                      <span>Type</span>
                      <select
                        value={source.type}
                        onChange={(event) =>
                          updateSource(index, "type", event.target.value)
                        }
                      >
                        {[
                          "File",
                          "URL",
                          "Command",
                          "Commit",
                          "Codex thread",
                          "Text",
                        ].map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Locator</span>
                      <input
                        id={`userSources.${index}.locator`}
                        value={source.locator}
                        onChange={(event) =>
                          updateSource(index, "locator", event.target.value)
                        }
                        aria-label={`Source ${index + 1} locator`}
                        aria-invalid={Boolean(
                          errors[`userSources.${index}.locator`],
                        )}
                      />
                      {fieldError(errors, `userSources.${index}.locator`)}
                    </label>
                    <label>
                      <span>Label</span>
                      <input
                        value={source.label ?? ""}
                        onChange={(event) =>
                          updateSource(index, "label", event.target.value)
                        }
                        aria-label={`Source ${index + 1} label`}
                      />
                    </label>
                    <button
                      type="button"
                      className="remove-source"
                      onClick={() =>
                        update(
                          "userSources",
                          draft.userSources.filter(
                            (_, sourceIndex) => sourceIndex !== index,
                          ),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {fieldError(errors, "userSources")}
                <button
                  type="button"
                  className="secondary-action"
                  onClick={addSource}
                >
                  Add source reference
                </button>
              </fieldset>

              {item?.immutableSourceEvidence.imported && (
                <div className="immutable-reminder form-field-wide">
                  <strong>Imported evidence is protected.</strong>
                  <p>
                    The original thread, file references, source ordinal, import
                    key, hash, and raw source are not editable here and are not
                    included in this save request.
                  </p>
                </div>
              )}
            </div>
          </div>

          <footer className="dialog-footer">
            <span className="save-status" role="status" aria-live="polite">
              {formNotice}
            </span>
            <button
              type="button"
              className="secondary-action"
              onClick={requestClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button type="submit" className="primary-action" disabled={saving}>
              {saving ? "Saving…" : item ? "Save changes" : "Create actionable"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

type ViewMode = "dashboard" | "actionables" | "archive" | "settings";
type QueryState = Partial<Record<keyof ActionableQuery, string>>;
type ArchiveDialogTarget = {
  kind: ArchiveTargetKind;
  id: string;
  name: string;
  version: number;
  archived: boolean;
};

const queryKeys: Array<keyof ActionableQuery> = [
  "project",
  "repository",
  "worktree",
  "status",
  "manualBlocked",
  "dependencyBlocked",
  "priority",
  "effort",
  "evidence",
  "tag",
  "archived",
  "parent",
  "validation",
  "reopened",
  "exclude",
  "q",
  "sort",
];

function isExcludeFilterKey(
  key: keyof ActionableQuery,
): key is ActionableExcludeFilterKey {
  return actionableExcludeFilterKeys.includes(
    key as ActionableExcludeFilterKey,
  );
}

function viewFromLocation(): ViewMode {
  if (window.location.pathname === "/dashboard") {
    return "dashboard";
  }
  if (window.location.pathname === "/archive") return "archive";
  if (window.location.pathname === "/settings") return "settings";
  return "actionables";
}

function queryFromLocation(): QueryState {
  const params = new URLSearchParams(window.location.search);
  return Object.fromEntries(
    queryKeys.flatMap((key) => {
      const value = params.get(key);
      return value ? [[key, value]] : [];
    }),
  ) as QueryState;
}

function selectedFromLocation() {
  const match = window.location.pathname.match(/^\/actionables\/(\d+)\/?$/);
  return match ? Number(match[1]) : null;
}

function searchFor(query: QueryState) {
  const params = new URLSearchParams();
  queryKeys.forEach((key) => {
    const value = query[key];
    if (value) params.set(key, value);
  });
  const text = params.toString();
  return text ? `?${text}` : "";
}

function routeFor(
  view: ViewMode,
  selectedId: number | null,
  query: QueryState,
) {
  const path =
    selectedId !== null
      ? `/actionables/${selectedId}`
      : view === "dashboard"
        ? "/dashboard"
        : view === "archive"
          ? "/archive"
          : view === "settings"
            ? "/settings"
            : "/";
  return `${path}${searchFor(query)}`;
}

function errorMessage(error: unknown) {
  if (error instanceof ApiProblem) {
    return `${error.problem.title} · Request ${error.problem.requestId}`;
  }
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}

function agentIntegrationError(error: unknown) {
  if (error instanceof ApiProblem) {
    return error.problem.detail ?? errorMessage(error);
  }
  return errorMessage(error);
}

function agentIntegrationState(component: AgentIntegrationComponent) {
  if (component.state === "installed") return "Installed";
  if (component.state === "outdated") return "Update available";
  if (component.state === "modified") return "Manual review required";
  return "Not installed";
}

const mcpTokenSetupPowerShell = `$bytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
[Environment]::SetEnvironmentVariable("ACTIONABLES_MCP_TOKEN", $token, "User")
Remove-Variable token,bytes`;

function AgentMcpStatus({ mcp }: { mcp: AgentIntegrationSettings["mcp"] }) {
  return (
    <div className="agent-mcp-status" data-enabled={mcp.enabled}>
      <div>
        <strong>Actionables MCP route</strong>
        <span>{mcp.enabled ? "Enabled" : "Disabled"}</span>
      </div>
      <dl>
        <div>
          <dt>API origin</dt>
          <dd>
            <code>{mcp.apiOrigin}</code>
          </dd>
        </div>
        <div>
          <dt>MCP endpoint</dt>
          <dd>
            <code>{mcp.endpoint}</code>
          </dd>
        </div>
      </dl>
      <p>
        {mcp.enabled
          ? `The route is available. Codex reads its bearer token from ${mcp.bearerTokenEnvironmentVariable}.`
          : `Create a strong local token, save it in the current Windows user's ${mcp.bearerTokenEnvironmentVariable} environment variable, and restart Actionables to enable this route.`}
      </p>
      <p>
        Actionables never displays the token. Restart Codex after registering
        the server or changing its configuration so it reloads both the
        configuration and user environment.
      </p>
      <details>
        <summary>Generate and save a token on Windows</summary>
        <pre>
          <code>{mcpTokenSetupPowerShell}</code>
        </pre>
      </details>
    </div>
  );
}

function AgentIntegrationSettingsSection() {
  const queryClient = useQueryClient();
  const integrationQuery = useQuery({
    queryKey: ["agent-integration-settings"],
    queryFn: fetchAgentIntegrationSettings,
  });
  const [installing, setInstalling] = useState<
    AgentIntegrationComponent["id"] | "all" | null
  >(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const install = async (
    mcpServer: boolean,
    agentInstructions: boolean,
    skill: boolean,
    pending: AgentIntegrationComponent["id"] | "all",
  ) => {
    setInstalling(pending);
    setNotice("");
    setError("");
    try {
      const response = await installAgentIntegration({
        mcpServer,
        agentInstructions,
        skill,
      });
      queryClient.setQueryData(
        ["agent-integration-settings"],
        response.settings,
      );
      setNotice(response.results.map((result) => result.message).join(" "));
    } catch (caught) {
      setError(agentIntegrationError(caught));
    } finally {
      setInstalling(null);
    }
  };

  if (integrationQuery.isPending) {
    return (
      <section className="settings-integration" aria-busy="true">
        <div className="settings-state" role="status">
          <RefreshCw className="spin" aria-hidden="true" />
          Checking Actionables agent integration…
        </div>
      </section>
    );
  }

  if (integrationQuery.isError || !integrationQuery.data) {
    return (
      <section className="settings-integration">
        <div className="settings-state" role="alert">
          <AlertTriangle aria-hidden="true" />
          <strong>Could not check the Actionables agent integration</strong>
          <span>{agentIntegrationError(integrationQuery.error)}</span>
          <button
            type="button"
            className="toolbar-button"
            onClick={() => void integrationQuery.refetch()}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  const components = [
    integrationQuery.data.mcpServer,
    integrationQuery.data.agentInstructions,
    integrationQuery.data.skill,
  ];
  const installable = components.filter(
    (component) =>
      component.state === "missing" || component.state === "outdated",
  );

  return (
    <section
      className="settings-integration"
      aria-labelledby="agent-integration-title"
    >
      <div className="settings-section-heading">
        <div>
          <h2 id="agent-integration-title">Actionables agent integration</h2>
          <p>
            MCP registration, Codex instructions, and the workflow skill are
            separate and never installed automatically. Choose only the
            components you want.
          </p>
        </div>
        {installable.length > 1 && (
          <button
            type="button"
            className="primary-action"
            disabled={installing !== null}
            onClick={() =>
              void install(
                installable.some((component) => component.id === "mcpServer"),
                installable.some(
                  (component) => component.id === "agentInstructions",
                ),
                installable.some((component) => component.id === "skill"),
                "all",
              )
            }
          >
            {installing === "all" ? "Installing…" : "Install all available"}
          </button>
        )}
      </div>
      <AgentMcpStatus mcp={integrationQuery.data.mcp} />
      <div className="agent-integration-grid">
        {components.map((component) => (
          <article key={component.id}>
            <header>
              <div>
                <h3>{component.label}</h3>
                <span data-state={component.state}>
                  {agentIntegrationState(component)}
                </span>
              </div>
              {component.state === "installed" ? (
                <CheckCircle2 aria-hidden="true" />
              ) : (
                <FileCode2 aria-hidden="true" />
              )}
            </header>
            <p>{component.description}</p>
            <code>{component.targetPath}</code>
            {(component.state === "missing" ||
              component.state === "outdated") && (
              <button
                type="button"
                className="toolbar-button"
                disabled={installing !== null}
                onClick={() =>
                  void install(
                    component.id === "mcpServer",
                    component.id === "agentInstructions",
                    component.id === "skill",
                    component.id,
                  )
                }
              >
                {installing === component.id
                  ? "Installing…"
                  : component.id === "mcpServer"
                    ? "Register server"
                    : `${component.state === "outdated" ? "Update" : "Install"} ${component.id === "skill" ? "skill" : "instructions"}`}
              </button>
            )}
            {component.state === "outdated" && (
              <small>
                This matches a known older bundled copy. Updating replaces only
                that unmodified copy.
              </small>
            )}
            {component.state === "modified" && (
              <small>
                Actionables will not overwrite this user-managed or ambiguous
                configuration. Reconcile it manually, then retry.
              </small>
            )}
            {component.id === "skill" && component.state === "installed" && (
              <a
                className="toolbar-button codex-skills-link"
                href={codexSkillsUrl}
              >
                Open Skills in Codex
                <ExternalLink aria-hidden="true" />
              </a>
            )}
          </article>
        ))}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="integration-notice" role="status" aria-live="polite">
          {notice}
        </div>
      )}
    </section>
  );
}

function AgentIntegrationSetupDialog({
  settings,
  onDismiss,
  onNotice,
}: {
  settings: AgentIntegrationSettings;
  onDismiss: () => void;
  onNotice: (notice: string) => void;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLElement>(null);
  const [mcpServer, setMcpServer] = useState(false);
  const [agentInstructions, setAgentInstructions] = useState(false);
  const [skill, setSkill] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [skillInstalled, setSkillInstalled] = useState(
    settings.skill.state === "installed",
  );
  useModalIsolation(dialogRef);

  const install = async () => {
    setInstalling(true);
    setNotice("");
    setError("");
    try {
      const response = await installAgentIntegration({
        mcpServer,
        agentInstructions,
        skill,
      });
      queryClient.setQueryData(
        ["agent-integration-settings"],
        response.settings,
      );
      setSkillInstalled(response.settings.skill.state === "installed");
      setNotice(response.results.map((result) => result.message).join(" "));
    } catch (caught) {
      setError(agentIntegrationError(caught));
    } finally {
      setInstalling(false);
    }
  };

  const components = [
    settings.mcpServer,
    settings.agentInstructions,
    settings.skill,
  ];

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="archive-dialog agent-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-setup-title"
        aria-describedby="agent-setup-description"
      >
        <header className="archive-dialog-header">
          <FileCode2 aria-hidden="true" />
          <div>
            <h2 id="agent-setup-title">Set up Actionables for Codex</h2>
            <p id="agent-setup-description">
              MCP registration, Codex instructions, and the workflow skill are
              independent, optional, and unchecked by default. You can install
              any combination later from Settings.
            </p>
          </div>
        </header>
        <AgentMcpStatus mcp={settings.mcp} />
        <div className="agent-setup-options">
          {components.map((component) => {
            const checked =
              component.state === "installed" ||
              (component.id === "mcpServer"
                ? mcpServer
                : component.id === "agentInstructions"
                  ? agentInstructions
                  : skill);
            const unavailable =
              component.state === "installed" || component.state === "modified";
            return (
              <label key={component.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={unavailable || installing || Boolean(notice)}
                  onChange={(event) => {
                    if (component.id === "mcpServer") {
                      setMcpServer(event.target.checked);
                    } else if (component.id === "agentInstructions") {
                      setAgentInstructions(event.target.checked);
                    } else {
                      setSkill(event.target.checked);
                    }
                    setError("");
                  }}
                />
                <span>
                  <strong>{component.label}</strong>
                  <small>
                    {component.description} Target: {component.targetPath}
                  </small>
                  {unavailable && <em>{agentIntegrationState(component)}</em>}
                </span>
              </label>
            );
          })}
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="agent-setup-notice">
            <span role="status">{notice}</span>
            {skillInstalled && (
              <a
                className="toolbar-button codex-skills-link"
                href={codexSkillsUrl}
              >
                Open Skills in Codex
                <ExternalLink aria-hidden="true" />
              </a>
            )}
          </div>
        )}
        <footer>
          {notice ? (
            <button
              type="button"
              className="primary-action"
              onClick={() => {
                onNotice(notice);
                onDismiss();
              }}
            >
              Continue
            </button>
          ) : (
            <>
              <button
                type="button"
                className="toolbar-button"
                disabled={installing}
                onClick={onDismiss}
              >
                Not now
              </button>
              <button
                type="button"
                className="primary-action"
                disabled={
                  installing || (!mcpServer && !agentInstructions && !skill)
                }
                onClick={() => void install()}
              >
                {installing ? "Installing…" : "Install selected"}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function DashboardPanel({
  data,
  pending,
  error,
  onRetry,
  onOpenQueue,
  onOpenItem,
  onTriaged,
}: {
  data: Awaited<ReturnType<typeof fetchDashboard>> | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  onOpenQueue: (query: Record<string, string>) => void;
  onOpenItem: (item: ActionableSummary) => void;
  onTriaged: (result: InboxTriageBatchResponse) => Promise<void>;
}) {
  const helperSettingsQuery = useQuery({
    queryKey: ["helper-agent-settings"],
    queryFn: fetchHelperAgentSettings,
  });
  const [triageRunning, setTriageRunning] = useState(false);
  const [triageError, setTriageError] = useState("");
  const [triageResult, setTriageResult] =
    useState<InboxTriageBatchResponse | null>(null);

  const runInboxTriage = async (query: Record<string, string>) => {
    setTriageRunning(true);
    setTriageError("");
    setTriageResult(null);
    try {
      const result = await triageInboxQueue({
        project: query.project,
        repository: query.repository,
        worktree: query.worktree,
      });
      setTriageResult(result);
      await onTriaged(result);
    } catch (caught) {
      setTriageError(
        caught instanceof ApiProblem
          ? [caught.problem.title, caught.problem.detail]
              .filter(Boolean)
              .join(" ")
          : "The Inbox triage batch could not be completed.",
      );
    } finally {
      setTriageRunning(false);
    }
  };

  if (pending) {
    return (
      <div className="dashboard-state" role="status">
        <RefreshCw className="spin" />
        Loading operational queues…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="dashboard-state error-state" role="alert">
        <AlertTriangle />
        <strong>Could not load the dashboard</strong>
        <span>{errorMessage(error)}</span>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (data.counts.total === 0) {
    return (
      <div className="dashboard-state">
        <CircleDot />
        <strong>No actionables yet</strong>
        <span>
          Capture an actionable or import reviewed findings to start the daily
          queue.
        </span>
      </div>
    );
  }
  const alertCount = data.alerts.reduce(
    (total, alert) => total + alert.count,
    0,
  );
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-title">
      <header className="dashboard-heading">
        <div>
          <h1 id="dashboard-title">Dashboard</h1>
          <p>
            Operational queues derived from current workflow, validation,
            hierarchy, and dependency state.
          </p>
        </div>
        <div className="dashboard-counts" aria-label="Actionable totals">
          <span>
            <strong>{data.counts.total}</strong> total
          </span>
          <span>
            <strong>{data.counts.topLevel}</strong> top-level
          </span>
          <span>
            <strong>{data.counts.nested}</strong> subtasks
          </span>
        </div>
      </header>
      <section
        className="stale-work-alerts"
        aria-labelledby="stale-work-alerts-title"
      >
        <div className="stale-work-alerts-heading">
          <div>
            <h2 id="stale-work-alerts-title">Stale-work alerts</h2>
            <p>
              Coordination risks that may need intervention before work can
              continue.
            </p>
          </div>
          <span>
            {alertCount} {alertCount === 1 ? "alert" : "alerts"}
          </span>
        </div>
        <div className="stale-work-alert-grid">
          {data.alerts.map((alert) => (
            <section
              className={`stale-work-alert is-${alert.tone}`}
              key={alert.key}
              aria-labelledby={`stale-work-alert-${alert.key}`}
            >
              <header>
                <AlertTriangle aria-hidden="true" />
                <h3 id={`stale-work-alert-${alert.key}`}>{alert.label}</h3>
                <strong>{alert.count}</strong>
              </header>
              <p>{alert.description}</p>
              {alert.items.length ? (
                <ol>
                  {alert.items.map((item) => (
                    <li key={item.actionable.id}>
                      <button
                        type="button"
                        onClick={() => onOpenItem(item.actionable)}
                      >
                        <span>{item.actionable.title}</span>
                        <small>{item.detail}</small>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <span className="stale-work-alert-empty">
                  No current alerts.
                </span>
              )}
            </section>
          ))}
        </div>
      </section>
      <div className="queue-grid">
        {data.queues.map((queue) => (
          <section className="queue-panel" key={queue.key}>
            <button
              type="button"
              className="queue-heading"
              onClick={() => onOpenQueue(queue.query)}
            >
              <span>{queue.label}</span>
              <strong>{queue.count}</strong>
              <ChevronRight aria-hidden="true" />
            </button>
            <div className="queue-description-row">
              <p>{queue.description}</p>
              {queue.key === "inbox" &&
                helperSettingsQuery.data?.inboxTriagerEnabled === true && (
                  <button
                    type="button"
                    className="icon-button queue-triage-button"
                    disabled={triageRunning}
                    onClick={() => void runInboxTriage(queue.query)}
                    aria-label={
                      triageRunning
                        ? "Triaging Inbox"
                        : `Triage up to ${helperSettingsQuery.data.inboxTriagerBatchSize}`
                    }
                    title={
                      triageRunning
                        ? "Triaging Inbox"
                        : `Triage up to ${helperSettingsQuery.data.inboxTriagerBatchSize} Inbox tasks`
                    }
                  >
                    {triageRunning ? (
                      <RefreshCw className="spin" aria-hidden="true" />
                    ) : (
                      <Sparkles aria-hidden="true" />
                    )}
                  </button>
                )}
            </div>
            {queue.key === "inbox" && triageError && (
              <p className="relationship-error" role="alert">
                {triageError}
              </p>
            )}
            {queue.key === "inbox" && triageResult && (
              <div
                className="integration-notice"
                role={
                  triageResult.outcome === "completed" ||
                  triageResult.outcome === "empty"
                    ? "status"
                    : "alert"
                }
              >
                <strong>
                  {triageResult.outcome === "completed"
                    ? `Triaged ${triageResult.triagedCount} task${triageResult.triagedCount === 1 ? "" : "s"}.`
                    : triageResult.outcome === "empty"
                      ? "No Inbox tasks require triage in this scope."
                      : triageResult.outcome === "partial"
                        ? `Partial triage: ${triageResult.triagedCount} of ${triageResult.selectedCount} tasks completed.`
                        : "Inbox triage failed for every selected task."}
                </strong>
                {triageResult.results.length > 0 && (
                  <ul>
                    {triageResult.results.map((result) => (
                      <li key={result.id}>
                        <strong>
                          #{result.id} · {result.title}
                        </strong>{" "}
                        — {result.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {queue.items.length ? (
              <ol>
                {queue.items.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => onOpenItem(item)}>
                      <Badge tone={item.priority}>{item.priority}</Badge>
                      <span>{item.title}</span>
                      {item.isDependencyBlocked && (
                        <span className="queue-blocked">blocked</span>
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <span className="queue-empty">No items in this queue.</span>
            )}
          </section>
        ))}
      </div>
    </section>
  );
}

/** Persist a browser-local default without changing current scope or existing work. */
function DefaultCreationScopeSection() {
  const scopesQuery = useQuery({
    queryKey: ["scopes"],
    queryFn: fetchScopeOptions,
  });
  const [saved, setSaved] = useState(readDefaultCreationWorktree);
  const [draft, setDraft] = useState(saved ?? "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const options = scopesQuery.data
    ? availableCreationScopes(scopesQuery.data)
    : [];
  const unavailable = Boolean(
    saved &&
    scopesQuery.isSuccess &&
    !options.some((scope) => scope.worktreeId === saved),
  );
  const save = (worktreeId: string) => {
    setError("");
    setNotice("");
    try {
      if (worktreeId)
        localStorage.setItem(defaultCreationWorktreeStorageKey, worktreeId);
      else localStorage.removeItem(defaultCreationWorktreeStorageKey);
      setSaved(worktreeId || null);
      setDraft(worktreeId);
      setNotice(
        worktreeId
          ? "Default scope saved for this browser."
          : "Default scope cleared.",
      );
    } catch {
      setError(
        "Could not save the default scope. Allow browser storage and try again. You can still choose a scope when creating an Actionable.",
      );
    }
  };
  return (
    <section
      className="settings-integration settings-form"
      aria-labelledby="default-creation-scope-title"
    >
      <h2 id="default-creation-scope-title">Default actionable scope</h2>
      <p id="default-creation-scope-help">
        Used for new Actionables in this browser when no current scope is
        selected. Your current scope takes precedence. If the default is
        archived or removed, an available scope is used.
      </p>
      {scopesQuery.isPending && <p role="status">Loading scopes…</p>}
      {scopesQuery.isError && (
        <div role="alert">
          Could not load scopes.{" "}
          <button
            type="button"
            className="toolbar-button"
            onClick={() => void scopesQuery.refetch()}
          >
            Retry scopes
          </button>
        </div>
      )}
      <div className="form-field">
        <label htmlFor="default-creation-scope">Default scope</label>
        <select
          id="default-creation-scope"
          value={draft}
          disabled={!scopesQuery.isSuccess}
          aria-describedby="default-creation-scope-help"
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
            setNotice("");
          }}
        >
          <option value="">No saved default</option>
          {unavailable && (
            <option value={saved!} disabled>
              Unavailable saved scope
            </option>
          )}
          {options.map((scope) => (
            <option key={scope.worktreeId} value={scope.worktreeId}>
              {scope.label}
            </option>
          ))}
        </select>
      </div>
      {unavailable && (
        <p>
          Saved scope is unavailable. New Actionables will use an available
          scope.
        </p>
      )}
      <div className="agent-start-actions">
        <button
          type="button"
          className="toolbar-button"
          disabled={
            !scopesQuery.isSuccess ||
            draft === (saved ?? "") ||
            Boolean(
              draft && !options.some((scope) => scope.worktreeId === draft),
            )
          }
          onClick={() => save(draft)}
        >
          Save default scope
        </button>
        <button
          type="button"
          className="toolbar-button"
          disabled={!saved && !draft}
          onClick={() => save("")}
        >
          Clear default scope
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

/** Manage repository membership while preserving its worktrees and work. */
function RepositoryAssignmentsSection() {
  const queryClient = useQueryClient();
  const scopesQuery = useQuery({
    queryKey: ["scopes"],
    queryFn: fetchScopeOptions,
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rootDrafts, setRootDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const projects =
    scopesQuery.data?.projects.filter((project) => !project.archivedAt) ?? [];
  const save = async (
    id: string,
    version: number,
    projectId: string,
    projectRoot: string,
  ) => {
    setSaving(id);
    setError("");
    setNotice("");
    try {
      const scopes = await updateRepositoryProject(id, {
        version,
        projectId: projectId || null,
        projectRoot,
      });
      queryClient.setQueryData(["scopes"], scopes);
      setDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setRootDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      await Promise.all(
        ["actionables", "actionable", "dashboard"].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
      setNotice("Repository project assignment saved.");
    } catch (caught) {
      setError(
        caught instanceof ApiProblem
          ? [
              caught.problem.title,
              ...Object.values(caught.problem.errors ?? {}).flat(),
            ].join(" ")
          : errorMessage(caught),
      );
      if (
        caught instanceof ApiProblem &&
        caught.problem.code === "VERSION_CONFLICT"
      ) {
        await scopesQuery.refetch();
        setDrafts((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        setRootDrafts((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    } finally {
      setSaving(null);
    }
  };
  return (
    <section
      className="settings-integration settings-form"
      aria-labelledby="repository-assignments-title"
    >
      <h2 id="repository-assignments-title">Repository projects</h2>
      <p id="repository-assignments-help">
        Choose No project to remove an assignment. Worktrees, Actionables and
        their history move with the repository. Release any agent claims before
        changing its project. Archived repositories must be restored first.
      </p>
      <p id="repository-root-help">
        For a monorepo, enter the relative project directory, such as apps/web.
        Leave it blank to open the checkout root. Each project directory can be
        tracked as a separate repository entry.
      </p>
      {scopesQuery.isPending && <p role="status">Loading repositories…</p>}
      {scopesQuery.isError && (
        <div role="alert">
          Could not load repositories.{" "}
          <button
            type="button"
            className="toolbar-button"
            onClick={() => void scopesQuery.refetch()}
          >
            Retry repositories
          </button>
        </div>
      )}
      {projects.flatMap((project) =>
        project.repositories
          .filter((repository) => !repository.archivedAt)
          .map((repository) => {
            const current = project.isUnassigned ? "" : project.id;
            const value = drafts[repository.id] ?? current;
            const root =
              rootDrafts[repository.id] ?? repository.projectRoot ?? "";
            return (
              <form
                key={repository.id}
                className="repository-assignment"
                aria-label={`Project assignment for ${repository.name} in ${project.name}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(repository.id, repository.version, value, root);
                }}
              >
                <label
                  className="form-field"
                  htmlFor={`repository-project-${repository.id}`}
                >
                  <span>{repository.name}</span>
                  <select
                    id={`repository-project-${repository.id}`}
                    value={value}
                    disabled={saving !== null}
                    aria-describedby="repository-assignments-help"
                    onChange={(event) => {
                      setDrafts((draft) => ({
                        ...draft,
                        [repository.id]: event.target.value,
                      }));
                      setError("");
                      setNotice("");
                    }}
                  >
                    <option value="">No project</option>
                    {projects
                      .filter((candidate) => !candidate.isUnassigned)
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label
                  className="form-field"
                  htmlFor={`repository-root-${repository.id}`}
                >
                  <span>Project directory for {repository.name}</span>
                  <input
                    id={`repository-root-${repository.id}`}
                    value={root}
                    maxLength={4096}
                    placeholder="apps/web"
                    disabled={saving !== null}
                    aria-describedby="repository-root-help"
                    onChange={(event) => {
                      setRootDrafts((draft) => ({
                        ...draft,
                        [repository.id]: event.target.value,
                      }));
                      setError("");
                      setNotice("");
                    }}
                  />
                </label>
                <button
                  type="submit"
                  className="toolbar-button"
                  disabled={
                    saving !== null ||
                    (current === value &&
                      root === (repository.projectRoot ?? ""))
                  }
                >
                  {saving === repository.id ? "Saving…" : "Save assignment"}
                </button>
              </form>
            );
          }),
      )}
      {scopesQuery.isSuccess &&
        !projects.some((project) =>
          project.repositories.some((repository) => !repository.archivedAt),
        ) && <p>No active repositories.</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

function SettingsPanel() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["helper-agent-settings"],
    queryFn: fetchHelperAgentSettings,
  });
  const [agentClaimLeaseMinutes, setAgentClaimLeaseMinutes] = useState("30");
  const [agentClaimExpiryWarningMinutes, setAgentClaimExpiryWarningMinutes] =
    useState("10");
  const [localCodexTimeoutSeconds, setLocalCodexTimeoutSeconds] = useState("");
  const [codexResearchPrompt, setCodexResearchPrompt] = useState("");
  const [codexImplementationPrompt, setCodexImplementationPrompt] =
    useState("");
  const [inboxTriagerBatchSize, setInboxTriagerBatchSize] = useState(
    String(defaultInboxTriageBatchSize),
  );
  const [inboxTriagerEnabled, setInboxTriagerEnabled] = useState(true);
  const [inboxTriagerModel, setInboxTriagerModel] =
    useState<NoteGroomerModel | null>(null);
  const [inboxTriagerReasoningEffort, setInboxTriagerReasoningEffort] =
    useState<AssistantReasoningEffort | null>(null);
  const [inboxTriagerPrompt, setInboxTriagerPrompt] = useState("");
  const [noteGroomerEnabled, setNoteGroomerEnabled] = useState(true);
  const [noteGroomerModel, setNoteGroomerModel] =
    useState<NoteGroomerModel | null>(null);
  const [noteGroomerReasoningEffort, setNoteGroomerReasoningEffort] =
    useState<AssistantReasoningEffort | null>(null);
  const [noteGroomerPrompt, setNoteGroomerPrompt] = useState("");
  const [relationshipAuditorEnabled, setRelationshipAuditorEnabled] =
    useState(true);
  const [relationshipAuditorModel, setRelationshipAuditorModel] =
    useState<NoteGroomerModel | null>(null);
  const [
    relationshipAuditorReasoningEffort,
    setRelationshipAuditorReasoningEffort,
  ] = useState<AssistantReasoningEffort | null>(null);
  const [relationshipAuditorPrompt, setRelationshipAuditorPrompt] =
    useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const loadDraft = (settings: HelperAgentSettings) => {
    setCodexResearchPrompt(settings.codexResearchPrompt);
    setCodexImplementationPrompt(settings.codexImplementationPrompt);
    setAgentClaimLeaseMinutes(String(settings.agentClaimLeaseMinutes));
    setAgentClaimExpiryWarningMinutes(
      String(settings.agentClaimExpiryWarningMinutes),
    );
    setLocalCodexTimeoutSeconds(
      settings.localCodexTimeoutSeconds === null
        ? ""
        : String(settings.localCodexTimeoutSeconds),
    );
    setInboxTriagerBatchSize(String(settings.inboxTriagerBatchSize));
    setInboxTriagerEnabled(settings.inboxTriagerEnabled);
    setInboxTriagerModel(settings.inboxTriagerModel);
    setInboxTriagerReasoningEffort(settings.inboxTriagerReasoningEffort);
    setInboxTriagerPrompt(settings.inboxTriagerPrompt);
    setNoteGroomerEnabled(settings.noteGroomerEnabled);
    setNoteGroomerModel(settings.noteGroomerModel);
    setNoteGroomerReasoningEffort(settings.noteGroomerReasoningEffort);
    setNoteGroomerPrompt(settings.noteGroomerPrompt);
    setRelationshipAuditorEnabled(settings.relationshipAuditorEnabled);
    setRelationshipAuditorModel(settings.relationshipAuditorModel);
    setRelationshipAuditorReasoningEffort(
      settings.relationshipAuditorReasoningEffort,
    );
    setRelationshipAuditorPrompt(settings.relationshipAuditorPrompt);
  };

  useEffect(() => {
    if (settingsQuery.data) loadDraft(settingsQuery.data);
  }, [settingsQuery.data]);

  const dirty = Boolean(
    settingsQuery.data &&
    (codexResearchPrompt !== settingsQuery.data.codexResearchPrompt ||
      codexImplementationPrompt !==
        settingsQuery.data.codexImplementationPrompt ||
      agentClaimLeaseMinutes !==
        String(settingsQuery.data.agentClaimLeaseMinutes) ||
      agentClaimExpiryWarningMinutes !==
        String(settingsQuery.data.agentClaimExpiryWarningMinutes) ||
      localCodexTimeoutSeconds !==
        (settingsQuery.data.localCodexTimeoutSeconds === null
          ? ""
          : String(settingsQuery.data.localCodexTimeoutSeconds)) ||
      inboxTriagerBatchSize !==
        String(settingsQuery.data.inboxTriagerBatchSize) ||
      inboxTriagerEnabled !== settingsQuery.data.inboxTriagerEnabled ||
      inboxTriagerModel !== settingsQuery.data.inboxTriagerModel ||
      inboxTriagerReasoningEffort !==
        settingsQuery.data.inboxTriagerReasoningEffort ||
      inboxTriagerPrompt !== settingsQuery.data.inboxTriagerPrompt ||
      noteGroomerEnabled !== settingsQuery.data.noteGroomerEnabled ||
      noteGroomerModel !== settingsQuery.data.noteGroomerModel ||
      noteGroomerReasoningEffort !==
        settingsQuery.data.noteGroomerReasoningEffort ||
      noteGroomerPrompt !== settingsQuery.data.noteGroomerPrompt ||
      relationshipAuditorEnabled !==
        settingsQuery.data.relationshipAuditorEnabled ||
      relationshipAuditorModel !==
        settingsQuery.data.relationshipAuditorModel ||
      relationshipAuditorReasoningEffort !==
        settingsQuery.data.relationshipAuditorReasoningEffort ||
      relationshipAuditorPrompt !==
        settingsQuery.data.relationshipAuditorPrompt),
  );

  const clearFieldError = (field: string) => {
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setError("");
    setNotice("");
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settingsQuery.data) return;
    const leaseMinutes = Number(agentClaimLeaseMinutes);
    const warningMinutes = Number(agentClaimExpiryWarningMinutes);
    const timeoutSeconds =
      localCodexTimeoutSeconds === "" ? null : Number(localCodexTimeoutSeconds);
    const triageBatchSize = Number(inboxTriagerBatchSize);
    const validationErrors: Record<string, string[]> = {};
    for (const [field, value] of Object.entries({
      codexResearchPrompt,
      codexImplementationPrompt,
    })) {
      const parsed = codexPromptTemplateSchema.safeParse(value);
      if (!parsed.success)
        validationErrors[field] = parsed.error.issues.map(
          (issue) => issue.message,
        );
    }
    if (
      !Number.isInteger(leaseMinutes) ||
      leaseMinutes < 5 ||
      leaseMinutes > 120
    ) {
      validationErrors.agentClaimLeaseMinutes = [
        "Enter a whole number from 5 through 120.",
      ];
    }
    if (
      !Number.isInteger(warningMinutes) ||
      warningMinutes < 1 ||
      warningMinutes > 119
    ) {
      validationErrors.agentClaimExpiryWarningMinutes = [
        "Enter a whole number from 1 through 119.",
      ];
    } else if (
      Number.isInteger(leaseMinutes) &&
      warningMinutes >= leaseMinutes
    ) {
      validationErrors.agentClaimExpiryWarningMinutes = [
        "The expiry warning must be shorter than the claim lease.",
      ];
    }
    if (
      timeoutSeconds !== null &&
      (!Number.isInteger(timeoutSeconds) ||
        timeoutSeconds < minimumLocalCodexTimeoutSeconds ||
        timeoutSeconds > maximumLocalCodexTimeoutSeconds)
    ) {
      validationErrors.localCodexTimeoutSeconds = [
        `Enter a whole number from ${minimumLocalCodexTimeoutSeconds} through ${maximumLocalCodexTimeoutSeconds}, or reset to the default.`,
      ];
    }
    if (
      !Number.isInteger(triageBatchSize) ||
      triageBatchSize < minimumInboxTriageBatchSize ||
      triageBatchSize > maximumInboxTriageBatchSize
    ) {
      validationErrors.inboxTriagerBatchSize = [
        `Enter a whole number from ${minimumInboxTriageBatchSize} through ${maximumInboxTriageBatchSize}.`,
      ];
    }
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      setError(
        validationErrors.codexResearchPrompt ||
          validationErrors.codexImplementationPrompt
          ? "Check the Codex start prompt templates."
          : validationErrors.localCodexTimeoutSeconds
            ? "Check the Local Codex runtime settings."
            : validationErrors.inboxTriagerBatchSize
              ? "Check the Inbox triage settings."
              : "Check the agent coordination settings.",
      );
      setNotice("");
      return;
    }
    setSaving(true);
    setNotice("");
    setError("");
    setErrors({});
    try {
      const saved = await updateHelperAgentSettings({
        version: settingsQuery.data.version,
        codexResearchPrompt,
        codexImplementationPrompt,
        agentClaimLeaseMinutes: leaseMinutes,
        agentClaimExpiryWarningMinutes: warningMinutes,
        localCodexTimeoutSeconds: timeoutSeconds,
        inboxTriagerBatchSize: triageBatchSize,
        inboxTriagerEnabled,
        inboxTriagerModel,
        inboxTriagerReasoningEffort,
        inboxTriagerPrompt,
        noteGroomerEnabled,
        noteGroomerModel,
        noteGroomerReasoningEffort,
        noteGroomerPrompt,
        relationshipAuditorEnabled,
        relationshipAuditorModel,
        relationshipAuditorReasoningEffort,
        relationshipAuditorPrompt,
      });
      queryClient.setQueryData(["helper-agent-settings"], saved);
      loadDraft(saved);
      setNotice("Helper agent settings saved.");
    } catch (caught) {
      if (
        caught instanceof ApiProblem &&
        caught.problem.code === "VERSION_CONFLICT"
      ) {
        try {
          const current = await fetchHelperAgentSettings();
          queryClient.setQueryData(["helper-agent-settings"], current);
          loadDraft(current);
          setError(
            "A newer saved version was loaded. Review it before editing again.",
          );
        } catch (reloadError) {
          setError(errorMessage(reloadError));
        }
      } else if (caught instanceof ApiProblem) {
        setErrors(caught.problem.errors ?? {});
        setError(caught.problem.title);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setSaving(false);
    }
  };

  if (settingsQuery.isPending) {
    return (
      <section className="settings-panel" aria-busy="true">
        <div className="settings-state" role="status">
          <RefreshCw className="spin" aria-hidden="true" />
          Loading helper agent settings…
        </div>
      </section>
    );
  }

  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <section className="settings-panel">
        <div className="settings-state" role="alert">
          <AlertTriangle aria-hidden="true" />
          <strong>Could not load helper agent settings</strong>
          <span>{errorMessage(settingsQuery.error)}</span>
          <button
            type="button"
            className="toolbar-button"
            onClick={() => void settingsQuery.refetch()}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="settings-panel">
      <header className="settings-heading">
        <div>
          <h1>Settings</h1>
          <p>
            Configure optional Codex integration and customize the instructions
            sent to local helper actions.
          </p>
        </div>
      </header>
      <AgentIntegrationSettingsSection />
      <DefaultCreationScopeSection />
      <RepositoryAssignmentsSection />
      <form
        className="settings-form"
        noValidate
        onSubmit={(event) => void save(event)}
      >
        <section aria-labelledby="codex-start-prompts-title">
          <h2 id="codex-start-prompts-title">Codex start prompts</h2>
          <p>
            Customize the text used by Open in Codex and Copy prompt. Active or
            expired claims keep their existing task link instead of offering a
            new start.
          </p>
          <p id="codex-prompt-variables-help">
            Use the literal variables below. Both ID variables are required.
            Unknown or malformed double-brace variables cannot be saved;
            expressions are not supported.
          </p>
          <dl>
            {Object.entries(codexPromptVariables).map(([name, description]) => (
              <div key={name}>
                <dt>
                  <code>{`{{${name}}}`}</code>
                </dt>
                <dd>{description}</dd>
              </div>
            ))}
          </dl>
          {(
            [
              {
                field: "codexResearchPrompt",
                label: "Research prompt template",
                value: codexResearchPrompt,
                setValue: setCodexResearchPrompt,
                defaultValue: defaultCodexResearchPrompt,
              },
              {
                field: "codexImplementationPrompt",
                label: "Implementation prompt template",
                value: codexImplementationPrompt,
                setValue: setCodexImplementationPrompt,
                defaultValue: defaultCodexImplementationPrompt,
              },
            ] as const
          ).map(({ field, label, value, setValue, defaultValue }) => (
            <div className="form-field" key={field}>
              <label htmlFor={field}>{label}</label>
              <textarea
                id={field}
                value={value}
                rows={8}
                maxLength={20_000}
                required
                disabled={saving}
                aria-invalid={Boolean(errors[field])}
                aria-describedby={`codex-prompt-variables-help${errors[field] ? ` ${field}-error` : ""}`}
                onChange={(event) => {
                  setValue(event.target.value);
                  clearFieldError(field);
                }}
              />
              {fieldError(errors, field)}
              <button
                type="button"
                className="toolbar-button"
                disabled={saving || value === defaultValue}
                onClick={() => {
                  setValue(defaultValue);
                  clearFieldError(field);
                }}
                aria-label={`Reset ${label.toLowerCase()} to default`}
              >
                <RotateCcw aria-hidden="true" />
                Reset to default
              </button>
            </div>
          ))}
          <small>
            Reset changes only that template. Choose Save settings to persist
            your edits.
          </small>
        </section>
        <section aria-labelledby="agent-coordination-title">
          <div>
            <h2 id="agent-coordination-title">Agent coordination</h2>
            <p>
              Controls the default claim lease and when active claims appear as
              expiring soon.
            </p>
          </div>
          <div className="helper-runtime-grid">
            <label className="form-field" htmlFor="agent-claim-lease-minutes">
              <span>Default claim lease (minutes)</span>
              <input
                id="agent-claim-lease-minutes"
                type="number"
                inputMode="numeric"
                min={5}
                max={120}
                step={1}
                value={agentClaimLeaseMinutes}
                onChange={(event) => {
                  setAgentClaimLeaseMinutes(event.target.value);
                  clearFieldError("agentClaimLeaseMinutes");
                }}
                aria-invalid={Boolean(errors.agentClaimLeaseMinutes)}
                aria-describedby={
                  errors.agentClaimLeaseMinutes
                    ? "agentClaimLeaseMinutes-help agentClaimLeaseMinutes-error"
                    : "agentClaimLeaseMinutes-help"
                }
                disabled={saving}
              />
              <small id="agentClaimLeaseMinutes-help">
                Used when a claim or renewal omits an explicit lease duration.
              </small>
              {fieldError(errors, "agentClaimLeaseMinutes")}
            </label>
            <label
              className="form-field"
              htmlFor="agent-claim-expiry-warning-minutes"
            >
              <span>Expiry warning window (minutes)</span>
              <input
                id="agent-claim-expiry-warning-minutes"
                type="number"
                inputMode="numeric"
                min={1}
                max={119}
                step={1}
                value={agentClaimExpiryWarningMinutes}
                onChange={(event) => {
                  setAgentClaimExpiryWarningMinutes(event.target.value);
                  clearFieldError("agentClaimExpiryWarningMinutes");
                }}
                aria-invalid={Boolean(errors.agentClaimExpiryWarningMinutes)}
                aria-describedby={
                  errors.agentClaimExpiryWarningMinutes
                    ? "agentClaimExpiryWarningMinutes-help agentClaimExpiryWarningMinutes-error"
                    : "agentClaimExpiryWarningMinutes-help"
                }
                disabled={saving}
              />
              <small id="agentClaimExpiryWarningMinutes-help">
                Must be shorter than the default claim lease.
              </small>
              {fieldError(errors, "agentClaimExpiryWarningMinutes")}
            </label>
          </div>
        </section>
        <section aria-labelledby="local-codex-runtime-title">
          <div>
            <h2 id="local-codex-runtime-title">Local Codex runtime</h2>
            <p>
              Sets one request timeout for note grooming and relationship
              auditing.
            </p>
          </div>
          <div className="helper-runtime-grid">
            <label className="form-field" htmlFor="local-codex-timeout-seconds">
              <span>Request timeout (seconds)</span>
              <input
                id="local-codex-timeout-seconds"
                type="number"
                inputMode="numeric"
                min={minimumLocalCodexTimeoutSeconds}
                max={maximumLocalCodexTimeoutSeconds}
                step={1}
                placeholder={String(defaultLocalCodexTimeoutSeconds)}
                value={localCodexTimeoutSeconds}
                onChange={(event) => {
                  setLocalCodexTimeoutSeconds(event.target.value);
                  clearFieldError("localCodexTimeoutSeconds");
                }}
                aria-invalid={Boolean(errors.localCodexTimeoutSeconds)}
                aria-describedby={
                  errors.localCodexTimeoutSeconds
                    ? "localCodexTimeoutSeconds-help localCodexTimeoutSeconds-error"
                    : "localCodexTimeoutSeconds-help"
                }
                disabled={saving}
              />
              <small id="localCodexTimeoutSeconds-help">
                Whole seconds from {minimumLocalCodexTimeoutSeconds} through{" "}
                {maximumLocalCodexTimeoutSeconds}. Effective timeout:{" "}
                <code>
                  {localCodexTimeoutSeconds || defaultLocalCodexTimeoutSeconds}
                </code>{" "}
                seconds
                {localCodexTimeoutSeconds ? " (override)" : " (default)"}.
              </small>
              {fieldError(errors, "localCodexTimeoutSeconds")}
            </label>
            <div className="form-field">
              <span>Default</span>
              <button
                type="button"
                className="toolbar-button"
                onClick={() => {
                  setLocalCodexTimeoutSeconds("");
                  clearFieldError("localCodexTimeoutSeconds");
                }}
                disabled={saving || localCodexTimeoutSeconds === ""}
              >
                <RotateCcw aria-hidden="true" />
                Reset to default
              </button>
              <small>
                Uses the built-in {defaultLocalCodexTimeoutSeconds}-second limit
                when no override is saved.
              </small>
            </div>
          </div>
        </section>
        <section aria-labelledby="inbox-triager-prompt-title">
          <div>
            <h2 id="inbox-triager-prompt-title">
              Triage Inbox with local Codex
            </h2>
            <p>
              Controls how a batch from the Inbox requiring triage queue is
              clarified before moving to Researching.
            </p>
          </div>
          <label className="form-field" htmlFor="inbox-triager-batch-size">
            <span>Tasks per run</span>
            <input
              id="inbox-triager-batch-size"
              type="number"
              min={minimumInboxTriageBatchSize}
              max={maximumInboxTriageBatchSize}
              step={1}
              value={inboxTriagerBatchSize}
              disabled={saving}
              aria-invalid={Boolean(errors.inboxTriagerBatchSize)}
              aria-describedby={
                errors.inboxTriagerBatchSize
                  ? "inboxTriagerBatchSize-error"
                  : undefined
              }
              onChange={(event) => {
                setInboxTriagerBatchSize(event.target.value);
                clearFieldError("inboxTriagerBatchSize");
              }}
            />
            {errors.inboxTriagerBatchSize && (
              <small id="inboxTriagerBatchSize-error" className="field-error">
                {errors.inboxTriagerBatchSize.join(" ")}
              </small>
            )}
            <small>
              Each run selects up to this many tasks from the current dashboard
              scope, in queue order.
            </small>
          </label>
          <div className="helper-action-toggle">
            <label htmlFor="inbox-triager-enabled">
              <input
                id="inbox-triager-enabled"
                type="checkbox"
                checked={inboxTriagerEnabled}
                disabled={saving}
                onChange={(event) => {
                  setInboxTriagerEnabled(event.target.checked);
                  setNotice("");
                }}
              />
              <span>Enable Triage Inbox with local Codex</span>
            </label>
            <small>
              Show the bulk action on the Inbox dashboard queue and allow direct
              API requests.
            </small>
          </div>
          <div className="helper-runtime-grid">
            <div className="form-field">
              <label htmlFor="inbox-triager-model">Model</label>
              <select
                id="inbox-triager-model"
                value={inboxTriagerModel ?? ""}
                disabled={saving}
                onChange={(event) => {
                  setInboxTriagerModel(
                    noteGroomerModels.find(
                      (model) => model === event.target.value,
                    ) ?? null,
                  );
                  setNotice("");
                }}
              >
                <option value="">Use environment/default model</option>
                <option value="gpt-5.6-sol">GPT-5.6 Sol</option>
                <option value="gpt-5.6-terra">GPT-5.6 Terra</option>
                <option value="gpt-5.6-luna">GPT-5.6 Luna</option>
              </select>
              <small>
                Effective model:{" "}
                <code>
                  {inboxTriagerModel ??
                    settingsQuery.data.inboxTriagerEffectiveModel}
                </code>
                {inboxTriagerModel
                  ? " (saved override)"
                  : " (environment/default)"}
              </small>
            </div>
            <div className="form-field">
              <label htmlFor="inbox-triager-reasoning-effort">
                Reasoning level
              </label>
              <select
                id="inbox-triager-reasoning-effort"
                value={inboxTriagerReasoningEffort ?? ""}
                disabled={saving}
                onChange={(event) => {
                  setInboxTriagerReasoningEffort(
                    assistantReasoningEfforts.find(
                      (effort) => effort === event.target.value,
                    ) ?? null,
                  );
                  setNotice("");
                }}
              >
                <option value="">Use selected model default</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
              </select>
              <small>
                Effective reasoning:{" "}
                <code>
                  {inboxTriagerReasoningEffort ?? "selected model default"}
                </code>
                {inboxTriagerReasoningEffort ? " (saved override)" : ""}
              </small>
            </div>
          </div>
          <label className="form-field" htmlFor="inbox-triager-prompt">
            <span>Prompt instructions</span>
            <textarea
              id="inbox-triager-prompt"
              value={inboxTriagerPrompt}
              onChange={(event) => {
                setInboxTriagerPrompt(event.target.value);
                setNotice("");
              }}
              rows={13}
              maxLength={20_000}
              required
              disabled={saving}
            />
            <small>
              Queue selection, task data, output schema instructions, lifecycle
              rules, and prompt-injection boundaries remain
              application-controlled.
            </small>
          </label>
        </section>
        <section aria-labelledby="note-groomer-prompt-title">
          <div>
            <h2 id="note-groomer-prompt-title">Groom notes with local Codex</h2>
            <p>
              Controls how description, research, and planned validation are
              reorganized.
            </p>
          </div>
          <div className="helper-action-toggle">
            <label htmlFor="note-groomer-enabled">
              <input
                id="note-groomer-enabled"
                type="checkbox"
                checked={noteGroomerEnabled}
                disabled={saving}
                onChange={(event) => {
                  setNoteGroomerEnabled(event.target.checked);
                  setNotice("");
                }}
              />
              <span>Enable Groom notes with local Codex</span>
            </label>
            <small>
              Show the helper in Actionable research notes and allow direct API
              requests.
            </small>
          </div>
          <div className="helper-runtime-grid">
            <div className="form-field">
              <label htmlFor="note-groomer-model">Model</label>
              <select
                id="note-groomer-model"
                value={noteGroomerModel ?? ""}
                disabled={saving}
                onChange={(event) => {
                  setNoteGroomerModel(
                    noteGroomerModels.find(
                      (model) => model === event.target.value,
                    ) ?? null,
                  );
                  setNotice("");
                }}
              >
                <option value="">Use environment/default model</option>
                <option value="gpt-5.6-sol">GPT-5.6 Sol</option>
                <option value="gpt-5.6-terra">GPT-5.6 Terra</option>
                <option value="gpt-5.6-luna">GPT-5.6 Luna</option>
              </select>
              <small>
                Effective model:{" "}
                <code>
                  {noteGroomerModel ??
                    settingsQuery.data.noteGroomerEffectiveModel}
                </code>
                {noteGroomerModel
                  ? " (saved override)"
                  : " (environment/default)"}
              </small>
            </div>
            <div className="form-field">
              <label htmlFor="note-groomer-reasoning-effort">
                Reasoning level
              </label>
              <select
                id="note-groomer-reasoning-effort"
                value={noteGroomerReasoningEffort ?? ""}
                disabled={saving}
                onChange={(event) => {
                  setNoteGroomerReasoningEffort(
                    assistantReasoningEfforts.find(
                      (effort) => effort === event.target.value,
                    ) ?? null,
                  );
                  setNotice("");
                }}
              >
                <option value="">Use selected model default</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
              </select>
              <small>
                Effective reasoning:{" "}
                <code>
                  {noteGroomerReasoningEffort ?? "selected model default"}
                </code>
                {noteGroomerReasoningEffort ? " (saved override)" : ""}
              </small>
            </div>
          </div>
          <label className="form-field" htmlFor="note-groomer-prompt">
            <span>Prompt instructions</span>
            <textarea
              id="note-groomer-prompt"
              value={noteGroomerPrompt}
              onChange={(event) => {
                setNoteGroomerPrompt(event.target.value);
                setNotice("");
              }}
              rows={13}
              maxLength={20_000}
              required
              disabled={saving}
            />
            <small>
              Task data, output schema instructions, and prompt-injection
              boundaries are appended by the application.
            </small>
          </label>
        </section>
        <section aria-labelledby="relationship-auditor-prompt-title">
          <div>
            <h2 id="relationship-auditor-prompt-title">Relationship auditor</h2>
            <p>
              Controls how hierarchy and dependency recommendations are
              evaluated.
            </p>
          </div>
          <div className="helper-action-toggle">
            <label htmlFor="relationship-auditor-enabled">
              <input
                id="relationship-auditor-enabled"
                type="checkbox"
                checked={relationshipAuditorEnabled}
                disabled={saving}
                onChange={(event) => {
                  setRelationshipAuditorEnabled(event.target.checked);
                  setNotice("");
                }}
              />
              <span>Enable Relationship auditor</span>
            </label>
            <small>
              Show the auditor in Actionable relationships and allow direct API
              requests.
            </small>
          </div>
          <div className="helper-runtime-grid">
            <div className="form-field">
              <label htmlFor="relationship-auditor-model">Model</label>
              <select
                id="relationship-auditor-model"
                value={relationshipAuditorModel ?? ""}
                disabled={saving}
                onChange={(event) => {
                  setRelationshipAuditorModel(
                    noteGroomerModels.find(
                      (model) => model === event.target.value,
                    ) ?? null,
                  );
                  setNotice("");
                }}
              >
                <option value="">Use environment/default model</option>
                <option value="gpt-5.6-sol">GPT-5.6 Sol</option>
                <option value="gpt-5.6-terra">GPT-5.6 Terra</option>
                <option value="gpt-5.6-luna">GPT-5.6 Luna</option>
              </select>
              <small>
                Effective model:{" "}
                <code>
                  {relationshipAuditorModel ??
                    settingsQuery.data.relationshipAuditorEffectiveModel}
                </code>
                {relationshipAuditorModel
                  ? " (saved override)"
                  : " (environment/default)"}
              </small>
            </div>
            <div className="form-field">
              <label htmlFor="relationship-auditor-reasoning-effort">
                Reasoning level
              </label>
              <select
                id="relationship-auditor-reasoning-effort"
                value={relationshipAuditorReasoningEffort ?? ""}
                disabled={saving}
                onChange={(event) => {
                  setRelationshipAuditorReasoningEffort(
                    assistantReasoningEfforts.find(
                      (effort) => effort === event.target.value,
                    ) ?? null,
                  );
                  setNotice("");
                }}
              >
                <option value="">Use selected model default</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
              </select>
              <small>
                Effective reasoning:{" "}
                <code>
                  {relationshipAuditorReasoningEffort ??
                    "selected model default"}
                </code>
                {relationshipAuditorReasoningEffort ? " (saved override)" : ""}
              </small>
            </div>
          </div>
          <label className="form-field" htmlFor="relationship-auditor-prompt">
            <span>Prompt instructions</span>
            <textarea
              id="relationship-auditor-prompt"
              value={relationshipAuditorPrompt}
              onChange={(event) => {
                setRelationshipAuditorPrompt(event.target.value);
                setNotice("");
              }}
              rows={13}
              maxLength={20_000}
              required
              disabled={saving}
            />
            <small>
              Work-item data, output schema instructions, and safety boundaries
              remain application-controlled.
            </small>
          </label>
        </section>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <footer>
          <span role="status" aria-live="polite">
            {notice}
          </span>
          <button
            type="submit"
            className="primary-action"
            disabled={
              saving ||
              !dirty ||
              !noteGroomerPrompt.trim() ||
              !relationshipAuditorPrompt.trim()
            }
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
        </footer>
      </form>
    </section>
  );
}

function RepositoryDialog({
  scopes,
  initialProjectId,
  onClose,
  onCreated,
}: {
  scopes: ScopeOptionsResponse;
  initialProjectId?: string;
  onClose: () => void;
  onCreated: (created: CreateRepositoryResponse) => void;
}) {
  const projects = scopes.projects.filter((project) => !project.archivedAt);
  const initialProject =
    projects.find((project) => project.id === initialProjectId) ?? projects[0];
  const [projectMode, setProjectMode] = useState<"existing" | "new">(
    projects.length > 0 ? "existing" : "new",
  );
  const [projectId, setProjectId] = useState(initialProject?.id ?? "");
  const [projectName, setProjectName] = useState("");
  const [name, setName] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const projectModeRef = useRef<HTMLInputElement>(null);

  useModalIsolation(dialogRef);
  useEffect(() => projectModeRef.current?.focus(), []);

  const clearFieldError = (field: string) => {
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setErrors({});
    try {
      onCreated(
        await createRepository(
          projectMode === "existing"
            ? { projectMode, projectId, name, localPath, projectRoot }
            : { projectMode, projectName, name, localPath, projectRoot },
        ),
      );
    } catch (caught) {
      if (caught instanceof ApiProblem) {
        setErrors(caught.problem.errors ?? {});
        setError(caught.problem.title);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setSaving(false);
    }
  };

  const browse = async () => {
    setBrowsing(true);
    setError("");
    try {
      const selected = await selectRepositoryFolder();
      if (selected.path === null) return;
      setLocalPath(selected.path);
      clearFieldError("localPath");
    } catch (caught) {
      setError(
        caught instanceof ApiProblem
          ? caught.problem.title
          : "The folder picker could not be opened.",
      );
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="archive-dialog repository-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="repository-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <form onSubmit={(event) => void submit(event)}>
          <header className="archive-dialog-header">
            <GitBranch aria-hidden="true" />
            <div>
              <h2 id="repository-dialog-title">Add repository</h2>
              <p>
                Track a local repository and create its initial Default
                worktree.
              </p>
            </div>
          </header>
          <div className="repository-form-fields">
            <fieldset className="repository-project-choice form-field-wide">
              <legend>Project assignment</legend>
              <div>
                <label>
                  <input
                    ref={projects.length > 0 ? projectModeRef : undefined}
                    type="radio"
                    name="repository-project-mode"
                    value="existing"
                    checked={projectMode === "existing"}
                    onChange={() => {
                      setProjectMode("existing");
                      clearFieldError("projectId");
                      clearFieldError("projectName");
                    }}
                    disabled={saving || projects.length === 0}
                  />
                  <span>Existing project</span>
                </label>
                <label>
                  <input
                    ref={projects.length === 0 ? projectModeRef : undefined}
                    type="radio"
                    name="repository-project-mode"
                    value="new"
                    checked={projectMode === "new"}
                    onChange={() => {
                      setProjectMode("new");
                      clearFieldError("projectId");
                      clearFieldError("projectName");
                    }}
                    disabled={saving}
                  />
                  <span>New project</span>
                </label>
              </div>
            </fieldset>
            {projectMode === "existing" ? (
              <label className="form-field" htmlFor="repository-project">
                <span>Project</span>
                <select
                  id="repository-project"
                  value={projectId}
                  onChange={(event) => {
                    setProjectId(event.target.value);
                    clearFieldError("projectId");
                  }}
                  aria-invalid={Boolean(errors.projectId)}
                  aria-describedby={
                    errors.projectId ? "projectId-error" : undefined
                  }
                  required
                  disabled={saving}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                {fieldError(errors, "projectId")}
              </label>
            ) : (
              <label className="form-field" htmlFor="repository-project-name">
                <span>Project name</span>
                <input
                  id="repository-project-name"
                  value={projectName}
                  onChange={(event) => {
                    setProjectName(event.target.value);
                    clearFieldError("projectName");
                  }}
                  aria-invalid={Boolean(errors.projectName)}
                  aria-describedby={
                    errors.projectName ? "projectName-error" : undefined
                  }
                  maxLength={240}
                  required
                  disabled={saving}
                />
                {fieldError(errors, "projectName")}
              </label>
            )}
            <label className="form-field" htmlFor="repository-name">
              <span>Repository name</span>
              <input
                id="repository-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  clearFieldError("name");
                }}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? "name-error" : undefined}
                maxLength={240}
                required
                disabled={saving}
              />
              {fieldError(errors, "name")}
            </label>
            <div className="form-field form-field-wide">
              <label htmlFor="repository-path">Local path</label>
              <div className="repository-path-control">
                <input
                  id="repository-path"
                  value={localPath}
                  onChange={(event) => {
                    setLocalPath(event.target.value);
                    clearFieldError("localPath");
                  }}
                  aria-invalid={Boolean(errors.localPath)}
                  aria-describedby={
                    errors.localPath ? "localPath-error" : undefined
                  }
                  placeholder="C:\repos\Example"
                  maxLength={4096}
                  required
                  disabled={saving}
                />
                <button
                  type="button"
                  className="toolbar-button repository-browse-button"
                  aria-label="Browse for a local repository folder"
                  onClick={() => void browse()}
                  disabled={saving || browsing}
                >
                  {browsing ? "Browsing…" : "Browse…"}
                </button>
              </div>
              {fieldError(errors, "localPath")}
            </div>
            <div className="form-field form-field-wide">
              <label htmlFor="repository-root">Project directory</label>
              <input
                id="repository-root"
                value={projectRoot}
                onChange={(event) => {
                  setProjectRoot(event.target.value);
                  clearFieldError("projectRoot");
                }}
                placeholder="apps/web"
                maxLength={4096}
                disabled={saving}
                aria-invalid={Boolean(errors.projectRoot)}
                aria-describedby={
                  errors.projectRoot
                    ? "projectRoot-error repository-root-help-dialog"
                    : "repository-root-help-dialog"
                }
              />
              <span id="repository-root-help-dialog">
                Optional relative directory inside the checkout. Leave blank to
                open the checkout root.
              </span>
              {fieldError(errors, "projectRoot")}
            </div>
          </div>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <footer>
            <button
              type="button"
              className="toolbar-button"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary-action"
              disabled={
                saving || (projectMode === "existing" && projects.length === 0)
              }
            >
              {saving ? "Adding…" : "Add repository"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function ArchiveDialog({
  target,
  impact,
  pending,
  saving,
  error,
  onClose,
  onConfirm,
}: {
  target: ArchiveDialogTarget;
  impact: ArchiveImpactResponse | undefined;
  pending: boolean;
  saving: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const action = target.archived ? "Restore" : "Archive";
  const dialogRef = useRef<HTMLElement>(null);
  useModalIsolation(dialogRef);
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="archive-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) {
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          );
          if (!controls?.length) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="archive-dialog-header">
          <Archive aria-hidden="true" />
          <div>
            <h2 id="archive-dialog-title">
              {action} {target.name}?
            </h2>
            <p>
              {target.archived
                ? "Restoring preserves its prior workflow, validation, hierarchy, dependencies, and history."
                : "Archiving changes visibility only. Workflow status and relationships are preserved."}
            </p>
          </div>
        </div>
        {pending ? (
          <div className="archive-impact" role="status">
            Checking impact…
          </div>
        ) : impact ? (
          <div className="archive-impact">
            <strong>Impact</strong>
            {impact.warnings.length ? (
              <ul>
                {impact.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : (
              <p>No related active work will be hidden.</p>
            )}
          </div>
        ) : null}
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <footer>
          <button
            type="button"
            className="toolbar-button"
            onClick={onClose}
            disabled={saving}
            autoFocus
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-action"
            onClick={onConfirm}
            disabled={pending || saving}
          >
            {saving ? `${action}ing…` : `${action} ${target.name}`}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ClaimReleaseDialog({
  target,
  saving,
  error,
  conflict,
  onClose,
  onConfirm,
}: {
  target: ActionableDetail;
  saving: boolean;
  error: string;
  conflict: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const claim = target.agentClaim;
  useModalIsolation(dialogRef);
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="archive-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-release-dialog-title"
        aria-describedby="claim-release-dialog-description"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) {
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
          );
          if (!controls?.length) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="archive-dialog-header">
          <AlertTriangle aria-hidden="true" />
          <div>
            <h2 id="claim-release-dialog-title">
              {claim?.state === "active"
                ? "Force release agent claim?"
                : "Release stale agent claim?"}
            </h2>
            <p id="claim-release-dialog-description">
              {claim
                ? `Confirm release of the claim on Actionable #${target.id} — “${target.title}” — held by ${claim.agentId} since ${new Date(claim.claimedAt).toLocaleString()}. The task will remain ${target.status}, and this agent’s current claim token will stop working.`
                : "This claim has already been cleared."}
            </p>
          </div>
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <footer>
          <button
            type="button"
            className="toolbar-button"
            onClick={onClose}
            disabled={saving}
            autoFocus
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-action"
            onClick={onConfirm}
            disabled={saving || !claim || conflict}
          >
            {saving
              ? "Releasing…"
              : claim?.state === "active"
                ? "Force release claim"
                : "Release stale claim"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const [agentSetupDismissed, setAgentSetupDismissed] = useState(() => {
    try {
      return (
        localStorage.getItem(agentIntegrationSetupStorageKey) === "dismissed"
      );
    } catch {
      return false;
    }
  });
  const [view, setView] = useState<ViewMode>(viewFromLocation);
  const [query, setQuery] = useState<QueryState>(() => {
    const initial = queryFromLocation();
    return viewFromLocation() === "archive"
      ? { ...initial, archived: "archived" }
      : initial;
  });
  const [selectedId, setSelectedId] = useState<number | null>(
    selectedFromLocation,
  );
  const [searchInput, setSearchInput] = useState(
    () => queryFromLocation().q ?? "",
  );
  const [activeTab, setActiveTab] = useState<InspectorTab>("finding");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorHidden, setInspectorHidden] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(defaultInspectorWidth);
  const [maximumInspectorWidth, setMaximumInspectorWidth] = useState(() =>
    availableInspectorWidth(false),
  );
  const [inspectorResizing, setInspectorResizing] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState<
    "project" | "worktree" | null
  >(null);
  const [collapsedRepositories, setCollapsedRepositories] = useState<
    Set<string>
  >(() => new Set());
  const [expandedParents, setExpandedParents] = useState<Set<number>>(() => {
    try {
      return new Set<number>(
        JSON.parse(
          sessionStorage.getItem("expanded-actionable-parents") ?? "[]",
        ),
      );
    } catch {
      return new Set<number>();
    }
  });
  const [mobileDetailOpen, setMobileDetailOpen] = useState(
    () =>
      selectedFromLocation() !== null &&
      window.matchMedia("(max-width: 760px)").matches,
  );
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [repositoryFormOpen, setRepositoryFormOpen] = useState(false);
  const [validationChecks, setValidationChecks] = useState<Set<string>>(
    new Set(),
  );
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [archiveTarget, setArchiveTarget] =
    useState<ArchiveDialogTarget | null>(null);
  const [archiveSaving, setArchiveSaving] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [claimReleaseTarget, setClaimReleaseTarget] =
    useState<ActionableDetail | null>(null);
  const [claimReleaseSaving, setClaimReleaseSaving] = useState(false);
  const [claimReleaseError, setClaimReleaseError] = useState("");
  const [claimReleaseConflict, setClaimReleaseConflict] = useState(false);
  const archiveReturnFocus = useRef<HTMLElement | null>(null);
  const claimReleaseReturnFocus = useRef<HTMLElement | null>(null);
  const repositoryReturnFocus = useRef<HTMLElement | null>(null);
  const scopeSelectorsRef = useRef<HTMLDivElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
  const worktreeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const tableBodyRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const listQuery = useQuery({
    queryKey: ["actionables", query],
    queryFn: () => fetchActionables(query),
    enabled:
      view === "actionables" || view === "archive" || selectedId !== null,
  });
  const scopesQuery = useQuery({
    queryKey: ["scopes"],
    queryFn: fetchScopeOptions,
  });
  const agentIntegrationQuery = useQuery({
    queryKey: ["agent-integration-settings"],
    queryFn: fetchAgentIntegrationSettings,
  });
  const dashboardScope = {
    project: query.project,
    repository: query.repository,
    worktree: query.worktree,
  };
  const dashboardQuery = useQuery({
    queryKey: ["dashboard", dashboardScope],
    queryFn: () => fetchDashboard(dashboardScope),
    enabled: view === "dashboard" && selectedId === null,
  });
  const detailQuery = useQuery({
    queryKey: ["actionable", selectedId],
    queryFn: () => fetchActionable(selectedId!),
    enabled: selectedId !== null,
  });
  const impactQuery = useQuery({
    queryKey: ["archive-impact", archiveTarget?.kind, archiveTarget?.id],
    queryFn: () => fetchArchiveImpact(archiveTarget!.kind, archiveTarget!.id),
    enabled: archiveTarget !== null,
  });

  const actionables = listQuery.data?.items ?? [];
  const selected = detailQuery.data;
  const scopes = scopesQuery.data?.projects ?? [];
  const sidebarProjects = scopes.filter((project) => !project.archivedAt);
  const activeProject = query.project
    ? scopes.find((item) => item.id === query.project)
    : undefined;
  const repositories = activeProject?.repositories ?? [];
  const activeRepository = query.repository
    ? repositories.find((item) => item.id === query.repository)
    : undefined;
  const worktrees = activeRepository?.worktrees ?? [];
  const activeWorktree = query.worktree
    ? worktrees.find((item) => item.id === query.worktree)
    : undefined;

  const replaceLocation = (
    nextView: ViewMode,
    nextSelected: number | null,
    nextQuery: QueryState,
    replace = false,
  ) => {
    const method = replace ? "replaceState" : "pushState";
    window.history[method]({}, "", routeFor(nextView, nextSelected, nextQuery));
    setView(nextView);
    setSelectedId(nextSelected);
    setQuery(nextQuery);
  };

  const patchQuery = (patch: QueryState, nextView = view) => {
    const next = { ...query };
    Object.entries(patch).forEach(([key, value]) => {
      if (
        !value ||
        (value === "all" && key !== "status") ||
        (key === "status" && value === "active") ||
        (key === "archived" && value === "active") ||
        (key === "sort" && value === "priority")
      ) {
        delete next[key as keyof ActionableQuery];
      } else {
        next[key as keyof ActionableQuery] = value;
      }
    });
    const excluded = activeActionableExcludeFilterKeys(next);
    if (excluded.length > 0) next.exclude = excluded.join(",");
    else delete next.exclude;
    if (nextView === "archive") next.archived = "archived";
    replaceLocation(nextView, null, next);
  };

  useEffect(() => {
    const onPopState = () => {
      const nextView = viewFromLocation();
      const nextQuery = queryFromLocation();
      if (nextView === "archive") nextQuery.archived = "archived";
      setView(nextView);
      setQuery(nextQuery);
      setSearchInput(nextQuery.q ?? "");
      const nextSelected = selectedFromLocation();
      setSelectedId(nextSelected);
      setMobileDetailOpen(
        nextSelected !== null &&
          window.matchMedia("(max-width: 760px)").matches,
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const updateMaximumInspectorWidth = () => {
      setMaximumInspectorWidth(availableInspectorWidth(sidebarCollapsed));
    };
    updateMaximumInspectorWidth();
    window.addEventListener("resize", updateMaximumInspectorWidth);
    return () =>
      window.removeEventListener("resize", updateMaximumInspectorWidth);
  }, [sidebarCollapsed]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = query.q ?? "";
      if (searchInput.trim() === current) return;
      const next = { ...query };
      if (searchInput.trim()) next.q = searchInput.trim();
      else delete next.q;
      replaceLocation(
        view === "dashboard" ? "actionables" : view,
        null,
        next,
        true,
      );
    }, 220);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!listQuery.data) return;
    const normalized = listQuery.data.result.normalizedQuery;
    const canonical = searchFor(normalized);
    if (canonical !== searchFor(query)) {
      const next = normalized as QueryState;
      window.history.replaceState({}, "", routeFor(view, selectedId, next));
      setQuery(next);
      setSearchInput(next.q ?? "");
    }
  }, [listQuery.data]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (!scopeMenuOpen) return;

    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !scopeSelectorsRef.current?.contains(event.target)
      ) {
        setScopeMenuOpen(null);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const trigger =
        scopeMenuOpen === "project"
          ? projectSelectorRef.current
          : worktreeSelectorRef.current;
      setScopeMenuOpen(null);
      trigger?.focus();
    };

    window.addEventListener("pointerdown", dismissOnOutsidePointer);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissOnOutsidePointer);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [scopeMenuOpen]);

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 900px)");
    const collapse = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setSidebarCollapsed(true);
    };
    collapse(mobileViewport);
    mobileViewport.addEventListener("change", collapse);
    return () => mobileViewport.removeEventListener("change", collapse);
  }, []);

  useEffect(() => {
    sessionStorage.setItem(
      "expanded-actionable-parents",
      JSON.stringify([...expandedParents]),
    );
  }, [expandedParents]);

  useEffect(() => {
    if (!listQuery.data || !tableBodyRef.current) return;
    const saved = Number(
      sessionStorage.getItem("actionables-scroll-position") ?? "0",
    );
    if (Number.isFinite(saved)) tableBodyRef.current.scrollTop = saved;
  }, [listQuery.data, view]);

  useEffect(() => {
    const deepLinkedId = selectedFromLocation();
    if (deepLinkedId !== null && deepLinkedId !== selectedId) {
      setSelectedId(deepLinkedId);
    }
  }, [selectedId, view]);

  const discoveryActive = queryKeys.some(
    (key) =>
      !["project", "repository", "worktree", "sort", "archived"].includes(
        key,
      ) && Boolean(query[key]),
  );
  const visibleRows = useMemo(() => {
    if (discoveryActive || query.parent || query.archived === "archived")
      return actionables;
    const byId = new Map(actionables.map((item) => [item.id, item]));
    return actionables
      .filter((item) => !item.parentId)
      .flatMap((item) => {
        if (!item.childIds || !expandedParents.has(item.id)) return [item];
        return [item, ...item.childIds.flatMap((id) => byId.get(id) ?? [])];
      });
  }, [
    actionables,
    discoveryActive,
    expandedParents,
    query.parent,
    query.archived,
  ]);

  const selectRow = (item: ActionableSummary) => {
    replaceLocation("actionables", item.id, query);
    setActiveTab("finding");
    setInspectorHidden(false);
    if (window.matchMedia("(max-width: 760px)").matches)
      setMobileDetailOpen(true);
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        blocksGlobalShortcut(event.target) ||
        formMode !== null ||
        repositoryFormOpen ||
        archiveTarget !== null
      ) {
        return;
      }

      if (event.key === "/" && view !== "settings") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (event.key.toLowerCase() === "c" && view !== "settings") {
        event.preventDefault();
        if (scopesQuery.data) setFormMode("create");
        else setNotice("Scope options are still loading.");
        return;
      }
      if (event.key.toLowerCase() === "e" && selected) {
        event.preventDefault();
        setFormMode("edit");
        return;
      }
      if (
        (event.key === "j" || event.key === "k") &&
        view === "actionables" &&
        visibleRows.length
      ) {
        event.preventDefault();
        const currentIndex = visibleRows.findIndex(
          (item) => item.id === selectedId,
        );
        const delta = event.key === "j" ? 1 : -1;
        const nextIndex =
          currentIndex < 0
            ? delta > 0
              ? 0
              : visibleRows.length - 1
            : Math.min(
                Math.max(currentIndex + delta, 0),
                visibleRows.length - 1,
              );
        const item = visibleRows[nextIndex];
        replaceLocation("actionables", item.id, query, true);
        setActiveTab("finding");
        setInspectorHidden(false);
        window.requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(`[data-actionable-id="${item.id}"]`)
            ?.focus();
        });
        return;
      }
      if (
        event.key === "Enter" &&
        selectedId !== null &&
        view === "actionables" &&
        !document.activeElement?.closest('[role="row"]')
      ) {
        event.preventDefault();
        setInspectorHidden(false);
        if (window.matchMedia("(max-width: 760px)").matches)
          setMobileDetailOpen(true);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    archiveTarget,
    formMode,
    query,
    repositoryFormOpen,
    scopesQuery.data,
    selected,
    selectedId,
    view,
    visibleRows,
  ]);

  const invalidateDailyUse = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["actionables"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["scopes"] }),
      queryClient.invalidateQueries({ queryKey: ["actionable"] }),
    ]);
  };

  const handleSaved = (saved: ActionableDetail, created: boolean) => {
    queryClient.setQueryData(["actionable", saved.id], saved);
    void invalidateDailyUse();
    replaceLocation("actionables", saved.id, query);
    setActiveTab("finding");
    setInspectorHidden(false);
    setFormMode(null);
    setNotice(
      created ? "Actionable created and opened." : "Actionable changes saved.",
    );
  };

  const handleMutated = (saved: ActionableDetail, mutationNotice: string) => {
    queryClient.setQueryData(["actionable", saved.id], saved);
    void invalidateDailyUse();
    setNotice(mutationNotice);
  };

  const openRepositoryForm = () => {
    repositoryReturnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setRepositoryFormOpen(true);
  };

  const closeRepositoryForm = () => {
    setRepositoryFormOpen(false);
    window.requestAnimationFrame(() => repositoryReturnFocus.current?.focus());
  };

  const handleRepositoryCreated = (created: CreateRepositoryResponse) => {
    queryClient.setQueryData(["scopes"], created.scopes);
    closeRepositoryForm();
    replaceLocation("actionables", null, {
      project: created.projectId,
      repository: created.repositoryId,
      worktree: created.worktreeId,
    });
    setNotice("Repository added and selected.");
  };

  const openArchive = (
    kind: ArchiveTargetKind,
    id: string | number,
    name: string,
    version: number,
    archived: boolean,
  ) => {
    archiveReturnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setArchiveError("");
    setArchiveTarget({ kind, id: String(id), name, version, archived });
  };

  const closeArchive = () => {
    setArchiveTarget(null);
    window.requestAnimationFrame(() => archiveReturnFocus.current?.focus());
  };

  const confirmArchive = async () => {
    if (!archiveTarget) return;
    setArchiveSaving(true);
    setArchiveError("");
    try {
      if (archiveTarget.kind === "actionable") {
        const saved = await setActionableArchived(
          Number(archiveTarget.id),
          archiveTarget.version,
          !archiveTarget.archived,
        );
        queryClient.setQueryData(["actionable", saved.id], saved);
      } else {
        await setScopeArchived(
          archiveTarget.kind,
          archiveTarget.id,
          archiveTarget.version,
          !archiveTarget.archived,
        );
      }
      setNotice(
        `${archiveTarget.name} ${archiveTarget.archived ? "restored" : "archived"}.`,
      );
      closeArchive();
      await invalidateDailyUse();
    } catch (error) {
      setArchiveError(errorMessage(error));
    } finally {
      setArchiveSaving(false);
    }
  };

  const openClaimRelease = (item: ActionableDetail) => {
    claimReleaseReturnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setClaimReleaseError("");
    setClaimReleaseConflict(false);
    setClaimReleaseTarget(item);
  };

  const closeClaimRelease = (released = false) => {
    const releasedId = claimReleaseTarget?.id;
    setClaimReleaseTarget(null);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (released && releasedId) {
          document.getElementById(`agent-claim-title-${releasedId}`)?.focus();
        } else {
          claimReleaseReturnFocus.current?.focus();
        }
      });
    });
  };

  const confirmClaimRelease = async () => {
    if (!claimReleaseTarget) return;
    setClaimReleaseSaving(true);
    setClaimReleaseError("");
    setClaimReleaseConflict(false);
    try {
      const claim = claimReleaseTarget.agentClaim;
      if (!claim) {
        setClaimReleaseConflict(true);
        setClaimReleaseError("This claim has already been cleared.");
        return;
      }
      const saved = await forceReleaseAgentClaim(claimReleaseTarget.id, {
        version: claimReleaseTarget.version,
        agentId: claim.agentId,
        claimedAt: claim.claimedAt,
      });
      handleMutated(saved, "Agent claim force-released.");
      closeClaimRelease(true);
    } catch (error) {
      if (error instanceof ApiProblem && error.problem.current) {
        queryClient.setQueryData(
          ["actionable", error.problem.current.id],
          error.problem.current,
        );
        setClaimReleaseTarget(error.problem.current);
        setClaimReleaseConflict(true);
        void invalidateDailyUse();
      }
      setClaimReleaseError(errorMessage(error));
    } finally {
      setClaimReleaseSaving(false);
    }
  };

  const clearFilters = () => {
    const preserved: QueryState = {};
    if (query.project) preserved.project = query.project;
    if (query.repository) preserved.repository = query.repository;
    if (query.worktree) preserved.worktree = query.worktree;
    if (view === "archive") preserved.archived = "archived";
    setSearchInput("");
    replaceLocation(view, null, preserved);
  };

  const excludedFilters = new Set(activeActionableExcludeFilterKeys(query));
  const activeFilters = queryKeys.filter(
    (key) =>
      key !== "exclude" &&
      (Boolean(query[key]) ||
        (isExcludeFilterKey(key) && excludedFilters.has(key))) &&
      !["project", "repository", "worktree"].includes(key) &&
      !(key === "archived" && view === "archive"),
  );
  const setFilterExcluded = (
    key: ActionableExcludeFilterKey,
    excluded: boolean,
  ) => {
    const next = new Set(excludedFilters);
    if (excluded) next.add(key);
    else next.delete(key);
    patchQuery({
      exclude: actionableExcludeFilterKeys
        .filter((candidate) => next.has(candidate))
        .join(","),
    });
  };
  const clearFilter = (key: keyof ActionableQuery) => {
    const patch: QueryState = { [key]: "" };
    if (isExcludeFilterKey(key) && excludedFilters.has(key)) {
      patch.exclude = actionableExcludeFilterKeys
        .filter(
          (candidate) => candidate !== key && excludedFilters.has(candidate),
        )
        .join(",");
    }
    if (key === "q") setSearchInput("");
    patchQuery(patch);
  };
  const filterMode = (key: ActionableExcludeFilterKey) => ({
    excluded: excludedFilters.has(key),
    modeDisabled: !isActionableExcludeFilterActive(query, key),
    onModeChange: () => setFilterExcluded(key, !excludedFilters.has(key)),
  });
  const projectName = activeProject?.name ?? "All projects";
  const worktreeName =
    activeWorktree?.name ??
    (activeRepository ? `${activeRepository.name} / All` : "All worktrees");
  const activeSort = query.sort ?? "priority";
  const totalFindings =
    listQuery.data?.counts.total ?? dashboardQuery.data?.counts.total ?? 0;
  const effectiveInspectorWidth = Math.min(
    inspectorWidth,
    maximumInspectorWidth,
  );
  const resizeInspector = (width: number) => {
    const nextWidth = Math.round(
      clamp(width, inspectorMinWidth, maximumInspectorWidth),
    );
    setInspectorWidth(nextWidth);
    try {
      localStorage.setItem(inspectorWidthStorageKey, String(nextWidth));
    } catch {
      // Resizing still works when storage is unavailable.
    }
  };
  const shellClasses = [
    "app-shell",
    sidebarCollapsed ? "sidebar-collapsed" : "",
    inspectorHidden ? "inspector-hidden" : "",
    inspectorResizing ? "inspector-resizing" : "",
    mobileDetailOpen ? "mobile-detail-open" : "",
    view === "dashboard" && selectedId === null ? "dashboard-mode" : "",
    view === "settings" && selectedId === null ? "settings-mode" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const dismissAgentSetup = () => {
    try {
      localStorage.setItem(agentIntegrationSetupStorageKey, "dismissed");
    } catch {
      // The current session can still dismiss setup when storage is blocked.
    }
    setAgentSetupDismissed(true);
  };

  return (
    <div
      className={shellClasses}
      style={
        {
          "--inspector-width": `${effectiveInspectorWidth}px`,
        } as CSSProperties
      }
    >
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside className="sidebar" aria-label="Repositories and worktrees">
        <div className="product-bar">
          <span>Actionables</span>
          <IconButton
            label={
              sidebarCollapsed ? "Expand left sidebar" : "Collapse left sidebar"
            }
            expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </IconButton>
        </div>
        <nav className="primary-navigation" aria-label="Primary">
          <button
            type="button"
            className={view === "dashboard" ? "is-selected" : ""}
            onClick={() =>
              replaceLocation("dashboard", null, {
                ...(query.project ? { project: query.project } : {}),
                ...(query.repository ? { repository: query.repository } : {}),
                ...(query.worktree ? { worktree: query.worktree } : {}),
              })
            }
          >
            <LayoutDashboard aria-hidden="true" />
            <span
              className={`primary-navigation-label ${sidebarCollapsed ? "sr-only" : ""}`}
            >
              Dashboard
            </span>
          </button>
          <button
            type="button"
            className={
              view === "actionables" && query.status !== "Done"
                ? "is-selected"
                : ""
            }
            onClick={() =>
              patchQuery(
                {
                  project: "",
                  repository: "",
                  worktree: "",
                  ...(query.status === "Done" ? { status: "active" } : {}),
                },
                "actionables",
              )
            }
          >
            <List aria-hidden="true" />
            <span
              className={`primary-navigation-label ${sidebarCollapsed ? "sr-only" : ""}`}
            >
              Actionables
            </span>
          </button>
          <button
            type="button"
            className={
              view === "actionables" && query.status === "Done"
                ? "is-selected"
                : ""
            }
            onClick={() => patchQuery({ status: "Done" }, "actionables")}
          >
            <CheckCircle2 aria-hidden="true" />
            <span
              className={`primary-navigation-label ${sidebarCollapsed ? "sr-only" : ""}`}
            >
              Done
            </span>
          </button>
          <button
            type="button"
            className={view === "archive" ? "is-selected" : ""}
            onClick={() =>
              replaceLocation("archive", null, { archived: "archived" })
            }
          >
            <Archive aria-hidden="true" />
            <span
              className={`primary-navigation-label ${sidebarCollapsed ? "sr-only" : ""}`}
            >
              Archive
            </span>
          </button>
        </nav>
        <div className="project-tree">
          <div className="tree-label">Repositories</div>
          {sidebarProjects.flatMap((project) =>
            project.repositories.map((repository) => (
              <div key={repository.id} className="repository-group">
                <div
                  className={`repository-row ${query.repository === repository.id && !query.worktree ? "is-selected" : ""}`}
                >
                  <button
                    type="button"
                    className="repository-expander"
                    aria-label={`${collapsedRepositories.has(repository.id) ? "Expand" : "Collapse"} repository ${repository.name}`}
                    aria-expanded={!collapsedRepositories.has(repository.id)}
                    aria-controls={`repository-worktrees-${repository.id}`}
                    onClick={() =>
                      setCollapsedRepositories((current) => {
                        const next = new Set(current);
                        if (next.has(repository.id)) next.delete(repository.id);
                        else next.add(repository.id);
                        return next;
                      })
                    }
                  >
                    {collapsedRepositories.has(repository.id) ? (
                      <ChevronRight aria-hidden="true" />
                    ) : (
                      <ChevronDown aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="repository-select"
                    aria-current={
                      query.repository === repository.id && !query.worktree
                        ? "page"
                        : undefined
                    }
                    onClick={() =>
                      patchQuery(
                        {
                          project: project.id,
                          repository: repository.id,
                          worktree: "",
                        },
                        "actionables",
                      )
                    }
                  >
                    <span>{repository.name}</span>
                    {repository.archivedAt && <Archive aria-label="Archived" />}
                  </button>
                </div>
                <div
                  id={`repository-worktrees-${repository.id}`}
                  hidden={collapsedRepositories.has(repository.id)}
                >
                  {repository.worktrees.map((worktree) => (
                    <div className="scope-action-row" key={worktree.id}>
                      <WorktreeRow
                        name={worktree.name}
                        count={
                          project.id === activeProject?.id &&
                          repository.id === activeRepository?.id &&
                          worktree.id === activeWorktree?.id
                            ? listQuery.data?.result.openScopeTotal
                            : undefined
                        }
                        selected={query.worktree === worktree.id}
                        onClick={() =>
                          patchQuery(
                            {
                              project: project.id,
                              repository: repository.id,
                              worktree: worktree.id,
                            },
                            "actionables",
                          )
                        }
                      />
                      <IconButton
                        label={`${worktree.archivedAt ? "Restore" : "Archive"} worktree ${worktree.name}`}
                        onClick={() =>
                          openArchive(
                            "worktree",
                            worktree.id,
                            worktree.name,
                            worktree.version,
                            Boolean(worktree.archivedAt),
                          )
                        }
                      >
                        {worktree.archivedAt ? <ArchiveRestore /> : <Archive />}
                      </IconButton>
                    </div>
                  ))}
                </div>
              </div>
            )),
          )}
          <button
            type="button"
            className="add-project"
            onClick={openRepositoryForm}
          >
            <Plus aria-hidden="true" /> Add repository
          </button>
          <button
            type="button"
            className="scope-row"
            onClick={() => replaceLocation("actionables", null, {})}
          >
            <span className="scope-dot all" /> All actionables{" "}
            <span>{totalFindings}</span>
          </button>
        </div>
        <div className="sidebar-status">
          <button
            type="button"
            className={view === "settings" ? "is-selected" : ""}
            onClick={() => replaceLocation("settings", null, query)}
          >
            <Settings aria-hidden="true" />
            <span
              className={`primary-navigation-label ${sidebarCollapsed ? "sr-only" : ""}`}
            >
              Settings
            </span>
          </button>
        </div>
      </aside>

      <header className="topbar">
        <div className="scope-selectors" ref={scopeSelectorsRef}>
          <IconButton
            label={
              sidebarCollapsed
                ? "Open project navigation"
                : "Close project navigation"
            }
            onClick={() => setSidebarCollapsed((value) => !value)}
            expanded={!sidebarCollapsed}
            className="nav-toggle"
          >
            {sidebarCollapsed ? <PanelLeftOpen /> : <Menu />}
          </IconButton>
          <div className="scope-selector-wrap">
            <button
              ref={projectSelectorRef}
              type="button"
              className="selector-button"
              aria-expanded={scopeMenuOpen === "project"}
              aria-controls="project-selector-menu"
              onClick={() => {
                setFilterOpen(false);
                setShortcutHelpOpen(false);
                setScopeMenuOpen((current) =>
                  current === "project" ? null : "project",
                );
              }}
            >
              {projectName} <ChevronDown aria-hidden="true" />
            </button>
            {scopeMenuOpen === "project" && (
              <div
                id="project-selector-menu"
                className="scope-selector-menu"
                role="menu"
                aria-label="Select project"
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!query.project}
                  className={!query.project ? "is-selected" : ""}
                  onClick={() => {
                    setScopeMenuOpen(null);
                    patchQuery(
                      { project: "", repository: "", worktree: "" },
                      "actionables",
                    );
                  }}
                >
                  <span>All projects</span>
                  {!query.project && <CheckCircle2 aria-hidden="true" />}
                </button>
                {scopes.map((project) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={query.project === project.id}
                    className={
                      query.project === project.id ? "is-selected" : ""
                    }
                    key={project.id}
                    onClick={() => {
                      setScopeMenuOpen(null);
                      patchQuery(
                        {
                          project: project.id,
                          repository: "",
                          worktree: "",
                        },
                        "actionables",
                      );
                    }}
                  >
                    <span>{project.name}</span>
                    {query.project === project.id ? (
                      <CheckCircle2 aria-hidden="true" />
                    ) : (
                      project.archivedAt && <small>Archived</small>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="topbar-divider" />
          <div className="scope-selector-wrap">
            <button
              ref={worktreeSelectorRef}
              type="button"
              className="selector-button mono"
              title={worktreeName}
              aria-expanded={scopeMenuOpen === "worktree"}
              aria-controls="worktree-selector-menu"
              onClick={() => {
                setFilterOpen(false);
                setShortcutHelpOpen(false);
                setScopeMenuOpen((current) =>
                  current === "worktree" ? null : "worktree",
                );
              }}
            >
              <GitBranch aria-hidden="true" />
              {worktreeName} <ChevronDown aria-hidden="true" />
            </button>
            {scopeMenuOpen === "worktree" && (
              <div
                id="worktree-selector-menu"
                className="scope-selector-menu worktree-selector-menu"
                role="menu"
                aria-label="Select repository or worktree"
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!query.repository && !query.worktree}
                  className={
                    !query.repository && !query.worktree ? "is-selected" : ""
                  }
                  onClick={() => {
                    setScopeMenuOpen(null);
                    patchQuery(
                      {
                        project: activeProject?.id ?? "",
                        repository: "",
                        worktree: "",
                      },
                      "actionables",
                    );
                  }}
                >
                  <span>
                    {activeProject
                      ? `All worktrees in ${activeProject.name}`
                      : "All worktrees"}
                  </span>
                  {!query.repository && !query.worktree && (
                    <CheckCircle2 aria-hidden="true" />
                  )}
                </button>
                {(activeProject ? [activeProject] : scopes).map((project) =>
                  project.repositories.map((repository) => (
                    <div
                      className="scope-menu-group"
                      key={repository.id}
                      role="group"
                      aria-label={
                        activeProject
                          ? repository.name
                          : `${project.name} / ${repository.name}`
                      }
                    >
                      <div className="scope-menu-label" aria-hidden="true">
                        {activeProject
                          ? repository.name
                          : `${project.name} / ${repository.name}`}
                      </div>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={
                          query.repository === repository.id && !query.worktree
                        }
                        className={
                          query.repository === repository.id && !query.worktree
                            ? "is-selected"
                            : ""
                        }
                        onClick={() => {
                          setScopeMenuOpen(null);
                          patchQuery(
                            {
                              project: project.id,
                              repository: repository.id,
                              worktree: "",
                            },
                            "actionables",
                          );
                        }}
                      >
                        <span>All in {repository.name}</span>
                        {query.repository === repository.id &&
                        !query.worktree ? (
                          <CheckCircle2 aria-hidden="true" />
                        ) : (
                          repository.archivedAt && <small>Archived</small>
                        )}
                      </button>
                      {repository.worktrees.map((worktree) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={query.worktree === worktree.id}
                          className={
                            query.worktree === worktree.id ? "is-selected" : ""
                          }
                          key={worktree.id}
                          onClick={() => {
                            setScopeMenuOpen(null);
                            patchQuery(
                              {
                                project: project.id,
                                repository: repository.id,
                                worktree: worktree.id,
                              },
                              "actionables",
                            );
                          }}
                        >
                          <span>{worktree.name}</span>
                          {query.worktree === worktree.id ? (
                            <CheckCircle2 aria-hidden="true" />
                          ) : (
                            worktree.archivedAt && <small>Archived</small>
                          )}
                        </button>
                      ))}
                    </div>
                  )),
                )}
              </div>
            )}
          </div>
        </div>
        {view !== "settings" ? (
          <label className="global-search">
            <Search aria-hidden="true" />
            <kbd className="shortcut">/</kbd>
            <input
              ref={searchInputRef}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search titles, findings, notes, tags, paths, symbols…"
              aria-label="Search actionables"
            />
            {searchInput && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearchInput("")}
              >
                <X />
              </button>
            )}
          </label>
        ) : (
          <div className="settings-context">
            <Settings aria-hidden="true" /> Helper agents
          </div>
        )}
        <div className="topbar-actions">
          <div className="shortcut-help-wrap">
            <button
              type="button"
              className="toolbar-button shortcut-help-button"
              aria-expanded={shortcutHelpOpen}
              aria-controls="shortcut-help"
              onClick={() => {
                setScopeMenuOpen(null);
                setFilterOpen(false);
                setShortcutHelpOpen((open) => !open);
              }}
              title="Keyboard shortcuts"
            >
              <Keyboard aria-hidden="true" /> Shortcuts
            </button>
            {shortcutHelpOpen && (
              <div id="shortcut-help" className="shortcut-help" role="status">
                <span>
                  <kbd>/</kbd> search
                </span>
                <span>
                  <kbd>j</kbd>/<kbd>k</kbd> move
                </span>
                <span>
                  <kbd>Enter</kbd> open
                </span>
                <span>
                  <kbd>e</kbd> edit
                </span>
                <span>
                  <kbd>c</kbd> create
                </span>
              </div>
            )}
          </div>
          {view !== "settings" && (
            <button
              type="button"
              className="primary-action"
              disabled={!scopesQuery.data}
              onClick={() =>
                scopesQuery.data
                  ? setFormMode("create")
                  : setNotice("Scope options are still loading.")
              }
            >
              <Plus /> New actionable
            </button>
          )}
          {(view === "actionables" || view === "archive") && (
            <div className="filter-wrap">
              <button
                type="button"
                className={`toolbar-button ${filterOpen ? "is-active" : ""}`}
                onClick={() => {
                  setScopeMenuOpen(null);
                  setShortcutHelpOpen(false);
                  setFilterOpen((value) => !value);
                }}
                aria-expanded={filterOpen}
              >
                <SlidersHorizontal /> Filters{" "}
                {activeFilters.length > 0 && (
                  <span className="filter-count">{activeFilters.length}</span>
                )}
              </button>
              {filterOpen && (
                <div className="filter-popover advanced-filters">
                  <AdvancedFilterField
                    id="filter-status"
                    label="Status"
                    {...filterMode("status")}
                  >
                    <select
                      id="filter-status"
                      value={query.status ?? "active"}
                      onChange={(event) =>
                        patchQuery({ status: event.target.value })
                      }
                    >
                      <option value="active">Active</option>
                      <option value="all">All</option>
                      {[
                        "Inbox",
                        "Researching",
                        "Ready",
                        "In progress",
                        "Blocked",
                        "Done",
                        "Dismissed",
                      ].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </AdvancedFilterField>
                  <AdvancedFilterField
                    id="filter-manual-blocking"
                    label="Manual blocking"
                    {...filterMode("manualBlocked")}
                  >
                    <select
                      id="filter-manual-blocking"
                      value={query.manualBlocked ?? ""}
                      onChange={(event) =>
                        patchQuery({ manualBlocked: event.target.value })
                      }
                    >
                      <option value="">All</option>
                      <option value="yes">Blocked</option>
                      <option value="no">Not manually blocked</option>
                    </select>
                  </AdvancedFilterField>
                  <AdvancedFilterField
                    id="filter-dependency-blocking"
                    label="Dependency blocking"
                    {...filterMode("dependencyBlocked")}
                  >
                    <select
                      id="filter-dependency-blocking"
                      value={query.dependencyBlocked ?? ""}
                      onChange={(event) =>
                        patchQuery({ dependencyBlocked: event.target.value })
                      }
                    >
                      <option value="">All</option>
                      <option value="yes">Blocked</option>
                      <option value="no">Unblocked</option>
                    </select>
                  </AdvancedFilterField>
                  <AdvancedFilterField
                    id="filter-priority"
                    label="Priority"
                    {...filterMode("priority")}
                  >
                    <select
                      id="filter-priority"
                      value={query.priority ?? ""}
                      onChange={(event) =>
                        patchQuery({ priority: event.target.value })
                      }
                    >
                      <option value="">All</option>
                      {priorities.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </AdvancedFilterField>
                  <AdvancedFilterField
                    id="filter-effort"
                    label="Effort"
                    {...filterMode("effort")}
                  >
                    <select
                      id="filter-effort"
                      value={query.effort ?? ""}
                      onChange={(event) =>
                        patchQuery({ effort: event.target.value })
                      }
                    >
                      <option value="">All</option>
                      {efforts.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </AdvancedFilterField>
                  <AdvancedFilterField
                    id="filter-evidence"
                    label="Evidence"
                    {...filterMode("evidence")}
                  >
                    <select
                      id="filter-evidence"
                      value={query.evidence ?? ""}
                      onChange={(event) =>
                        patchQuery({ evidence: event.target.value })
                      }
                    >
                      <option value="">All</option>
                      {evidenceStates.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </AdvancedFilterField>
                  <AdvancedFilterField
                    id="filter-hierarchy"
                    label="Hierarchy"
                    {...filterMode("parent")}
                  >
                    <select
                      id="filter-hierarchy"
                      value={query.parent ?? ""}
                      onChange={(event) =>
                        patchQuery({ parent: event.target.value })
                      }
                    >
                      <option value="">All</option>
                      <option value="top-level">Top-level</option>
                      <option value="subtasks">Subtasks</option>
                    </select>
                  </AdvancedFilterField>
                  <AdvancedFilterField
                    id="filter-validation"
                    label="Validation"
                    {...filterMode("validation")}
                  >
                    <select
                      id="filter-validation"
                      value={query.validation ?? ""}
                      onChange={(event) =>
                        patchQuery({ validation: event.target.value })
                      }
                    >
                      <option value="">All</option>
                      <option value="yes">Qualifying</option>
                      <option value="no">Awaiting</option>
                    </select>
                  </AdvancedFilterField>
                  <AdvancedFilterField
                    id="filter-tag"
                    label="Tag"
                    {...filterMode("tag")}
                  >
                    <input
                      id="filter-tag"
                      value={query.tag ?? ""}
                      onChange={(event) =>
                        patchQuery({ tag: event.target.value })
                      }
                      placeholder="Exact tag"
                    />
                  </AdvancedFilterField>
                  <button type="button" onClick={clearFilters}>
                    Clear all
                  </button>
                </div>
              )}
            </div>
          )}
          {(view === "actionables" || view === "archive") && (
            <IconButton
              label={inspectorHidden ? "Show inspector" : "Hide inspector"}
              onClick={() => setInspectorHidden((value) => !value)}
              pressed={!inspectorHidden}
            >
              {inspectorHidden ? <PanelRightOpen /> : <PanelRightClose />}
            </IconButton>
          )}
        </div>
      </header>

      {view === "settings" && selectedId === null ? (
        <main className="findings-panel" id="main-content" tabIndex={-1}>
          <SettingsPanel />
        </main>
      ) : view === "dashboard" && selectedId === null ? (
        <main className="findings-panel" id="main-content" tabIndex={-1}>
          <DashboardPanel
            data={dashboardQuery.data}
            pending={dashboardQuery.isPending}
            error={dashboardQuery.error}
            onRetry={() => void dashboardQuery.refetch()}
            onOpenQueue={(queue) => {
              setSearchInput(queue.q ?? "");
              replaceLocation("actionables", null, queue as QueryState);
            }}
            onOpenItem={selectRow}
            onTriaged={async (result) => {
              await invalidateDailyUse();
              setNotice(
                result.outcome === "completed"
                  ? `Inbox triage completed for ${result.triagedCount} task${result.triagedCount === 1 ? "" : "s"}.`
                  : result.outcome === "empty"
                    ? "No Inbox tasks require triage in this scope."
                    : result.outcome === "partial"
                      ? `Inbox triage was partial: ${result.triagedCount} triaged, ${result.failedCount} failed, ${result.skippedCount} skipped.`
                      : "Inbox triage did not complete any selected tasks.",
              );
            }}
          />
        </main>
      ) : (
        <main className="findings-panel" id="main-content" tabIndex={-1}>
          <div className="findings-heading">
            <h1>
              {view === "archive"
                ? "Archive"
                : query.status === "Done"
                  ? "Done"
                  : "Actionables"}{" "}
              <span>{listQuery.data?.result.matched ?? 0}</span>
            </h1>
            <div className="filter-chips">
              {activeFilters.map((key) => (
                <button
                  type="button"
                  className="active-filter"
                  key={key}
                  onClick={() => clearFilter(key)}
                >
                  {isExcludeFilterKey(key) && excludedFilters.has(key)
                    ? "Exclude "
                    : ""}
                  {key}: {query[key] ?? (key === "status" ? "active" : "")}{" "}
                  <X />
                </button>
              ))}
              {activeFilters.length > 1 && (
                <button
                  type="button"
                  className="clear-filters"
                  onClick={clearFilters}
                >
                  Clear all
                </button>
              )}
            </div>
          </div>
          {!online && (
            <div className="connection-banner" role="status">
              Local API unreachable. Existing context is preserved; reconnect
              and retry.
            </div>
          )}
          {listQuery.isFetching && !listQuery.isPending && (
            <div className="background-refresh" role="status">
              Refreshing results…
            </div>
          )}
          <div
            className="findings-table"
            role="table"
            aria-label="Actionable findings"
          >
            <div className="table-header table-grid" role="row">
              <div
                role="columnheader"
                aria-sort={activeSort === "title" ? "ascending" : undefined}
              >
                <button
                  type="button"
                  onClick={() => patchQuery({ sort: "title" })}
                >
                  Finding{" "}
                  {activeSort === "title" && (
                    <ChevronDown
                      className="sort-indicator is-ascending"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </div>
              <div
                role="columnheader"
                aria-sort={activeSort === "priority" ? "ascending" : undefined}
              >
                <button
                  type="button"
                  onClick={() => patchQuery({ sort: "priority" })}
                >
                  Priority{" "}
                  {activeSort === "priority" && (
                    <ChevronDown
                      className="sort-indicator is-ascending"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </div>
              <div
                role="columnheader"
                aria-sort={activeSort === "status" ? "ascending" : undefined}
              >
                <button
                  type="button"
                  onClick={() => patchQuery({ sort: "status" })}
                >
                  Status{" "}
                  {activeSort === "status" && (
                    <ChevronDown
                      className="sort-indicator is-ascending"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </div>
              <div
                role="columnheader"
                aria-sort={activeSort === "effort" ? "ascending" : undefined}
              >
                <button
                  type="button"
                  onClick={() => patchQuery({ sort: "effort" })}
                >
                  Effort{" "}
                  {activeSort === "effort" && (
                    <ChevronDown
                      className="sort-indicator is-ascending"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </div>
              <div
                role="columnheader"
                aria-sort={
                  activeSort === "updated-asc"
                    ? "ascending"
                    : activeSort === "updated-desc"
                      ? "descending"
                      : undefined
                }
              >
                <button
                  type="button"
                  onClick={() =>
                    patchQuery({
                      sort:
                        activeSort === "updated-desc"
                          ? "updated-asc"
                          : "updated-desc",
                    })
                  }
                >
                  Updated{" "}
                  {(activeSort === "updated-desc" ||
                    activeSort === "updated-asc") && (
                    <ChevronDown
                      className={`sort-indicator ${activeSort === "updated-asc" ? "is-ascending" : ""}`}
                      aria-hidden="true"
                    />
                  )}
                </button>
              </div>
            </div>
            <div
              className="table-body"
              role="rowgroup"
              ref={tableBodyRef}
              onScroll={(event) => {
                sessionStorage.setItem(
                  "actionables-scroll-position",
                  String(event.currentTarget.scrollTop),
                );
              }}
            >
              {visibleRows.map((item) => {
                const selectedRow = item.id === selectedId;
                const isChild = Boolean(item.parentId);
                const expanded = expandedParents.has(item.id);
                return (
                  <div
                    className={`finding-row table-grid ${selectedRow ? "is-selected" : ""} ${isChild ? "is-child" : ""}`}
                    role="row"
                    aria-selected={selectedRow}
                    tabIndex={0}
                    data-actionable-id={item.id}
                    key={item.id}
                    onClick={() => selectRow(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") selectRow(item);
                    }}
                  >
                    <div className="finding-cell" role="cell">
                      {item.childIds && !discoveryActive ? (
                        <button
                          type="button"
                          className="row-expander"
                          aria-label={`${expanded ? "Collapse" : "Expand"} subtasks for ${item.title}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedParents((current) => {
                              const next = new Set(current);
                              if (next.has(item.id)) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            });
                          }}
                        >
                          {expanded ? <ChevronDown /> : <ChevronRight />}
                        </button>
                      ) : isChild ? (
                        <span className="child-guide" />
                      ) : (
                        <span className="row-spacer" />
                      )}
                      <span
                        className="finding-title truncate-reveal"
                        title={item.title}
                      >
                        {item.title}
                      </span>
                      {item.childCompletion && (
                        <span className="child-count">
                          {item.childCompletion.terminal}/
                          {item.childCompletion.total}
                        </span>
                      )}
                      {item.tags.length > 0 && (
                        <span className="row-tags">
                          {item.tags.slice(0, 2).map((tag, index) => (
                            <button
                              type="button"
                              className="row-tag"
                              key={`${tag}-${index}`}
                              title={`Filter by tag “${tag}”`}
                              aria-label={`Filter by tag ${tag}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                patchQuery({ tag });
                              }}
                              onKeyDown={(event) => event.stopPropagation()}
                            >
                              {tag}
                            </button>
                          ))}
                          {item.tags.length > 2 && (
                            <span
                              className="tag-overflow"
                              title={`More tags: ${item.tags.slice(2).join(", ")}`}
                              aria-label={`${item.tags.length - 2} more tags: ${item.tags.slice(2).join(", ")}`}
                            >
                              +{item.tags.length - 2}
                            </span>
                          )}
                        </span>
                      )}
                      {item.unresolvedDependencyCount > 0 && (
                        <span
                          className="blocked-indicator"
                          title={`Derived block: ${item.unresolvedDependencyCount} unresolved prerequisite${item.unresolvedDependencyCount === 1 ? "" : "s"}`}
                        >
                          Blocked by {item.unresolvedDependencyCount}
                        </span>
                      )}
                      {item.archiveState.isArchived && (
                        <span className="archived-indicator">Archived</span>
                      )}
                    </div>
                    <div role="cell">
                      <Badge tone={item.priority}>{item.priority}</Badge>
                    </div>
                    <div role="cell">
                      <Badge
                        tone={item.status}
                        title={item.statusProvenance.note}
                      >
                        {item.status}
                      </Badge>
                    </div>
                    <div role="cell" className="effort-cell">
                      {item.effort}
                    </div>
                    <div role="cell" className="updated-cell">
                      {new Date(item.updatedAt).toLocaleDateString()}
                    </div>
                  </div>
                );
              })}
              {visibleRows.length === 0 && (
                <div role="row">
                  <div
                    className="empty-state"
                    role="cell"
                    aria-live={listQuery.isError ? "assertive" : "polite"}
                  >
                    {listQuery.isPending ? (
                      <RefreshCw className="spin" />
                    ) : listQuery.isError ? (
                      <AlertTriangle />
                    ) : (
                      <Search />
                    )}
                    <strong>
                      {listQuery.isPending
                        ? "Loading actionables"
                        : listQuery.isError
                          ? "Could not load actionables"
                          : listQuery.data?.counts.total === 0
                            ? "No actionables yet"
                            : listQuery.data?.result.scopeTotal === 0
                              ? "This scope is empty"
                              : "No results match these filters"}
                    </strong>
                    <span>
                      {listQuery.isError
                        ? errorMessage(listQuery.error)
                        : listQuery.data?.result.scopeTotal === 0
                          ? "Choose another project, repository, or worktree."
                          : "Clear one or all filters to broaden the result."}
                    </span>
                    {listQuery.isError && (
                      <button
                        type="button"
                        onClick={() => void listQuery.refetch()}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <footer className="table-footer">
            <span>
              {visibleRows.length} visible rows ·{" "}
              {listQuery.data?.result.topLevel ?? 0} top-level ·{" "}
              {listQuery.data?.result.nested ?? 0} subtasks
            </span>
            <span>{listQuery.data?.counts.total ?? 0} total actionables</span>
          </footer>
        </main>
      )}

      {(view !== "dashboard" && view !== "settings") || selectedId !== null ? (
        <aside
          className="inspector"
          id="actionable-inspector"
          aria-label="Selected actionable"
        >
          {!inspectorHidden && (
            <InspectorResizeHandle
              width={effectiveInspectorWidth}
              maximumWidth={maximumInspectorWidth}
              onResize={resizeInspector}
              onResizingChange={setInspectorResizing}
            />
          )}
          {selected ? (
            <Inspector
              selected={selected}
              actionables={actionables}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              onCloseMobile={() => {
                setMobileDetailOpen(false);
                replaceLocation("actionables", null, query);
              }}
              validationChecks={validationChecks}
              toggleValidation={(key) =>
                setValidationChecks((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
              onEdit={() => setFormMode("edit")}
              onMutated={handleMutated}
              onNavigate={(id) => {
                const item = actionables.find(
                  (candidate) => candidate.id === id,
                );
                if (item) selectRow(item);
                else replaceLocation("actionables", id, query);
              }}
              onNotice={setNotice}
              onArchive={() =>
                openArchive(
                  "actionable",
                  selected.id,
                  selected.title,
                  selected.version,
                  selected.archiveState.directlyArchived,
                )
              }
              onReleaseClaim={() => openClaimRelease(selected)}
            />
          ) : (
            <div
              className="inspector-loading"
              role={detailQuery.isError ? "alert" : "status"}
            >
              {selectedId === null ? (
                <>
                  <strong>No actionable selected</strong>
                  <span>Choose a row to open its stable deep link.</span>
                </>
              ) : detailQuery.isError ? (
                <>
                  <strong>Actionable unavailable</strong>
                  <span>{errorMessage(detailQuery.error)}</span>
                  <button
                    type="button"
                    onClick={() => replaceLocation("actionables", null, query)}
                  >
                    Back to results
                  </button>
                </>
              ) : (
                "Loading actionable details…"
              )}
            </div>
          )}
        </aside>
      ) : null}

      <div className="sr-only" aria-live="polite">
        {notice}
        {listQuery.isFetching ? " Results updating." : ""}
      </div>
      {formMode && scopesQuery.data && (formMode === "create" || selected) && (
        <ActionableForm
          key={
            formMode === "edit" && selected
              ? `edit-${selected.id}-${selected.version}`
              : "create"
          }
          item={formMode === "edit" ? selected : undefined}
          scopes={scopesQuery.data}
          initialScope={{
            projectId: query.project,
            repositoryId: query.repository,
            worktreeId: query.worktree,
          }}
          onClose={() => setFormMode(null)}
          onSaved={handleSaved}
        />
      )}
      {repositoryFormOpen && scopesQuery.data && (
        <RepositoryDialog
          scopes={scopesQuery.data}
          initialProjectId={activeProject?.id}
          onClose={closeRepositoryForm}
          onCreated={handleRepositoryCreated}
        />
      )}
      {archiveTarget && (
        <ArchiveDialog
          target={archiveTarget}
          impact={impactQuery.data}
          pending={impactQuery.isPending}
          saving={archiveSaving}
          error={
            archiveError ||
            (impactQuery.isError ? errorMessage(impactQuery.error) : "")
          }
          onClose={closeArchive}
          onConfirm={() => void confirmArchive()}
        />
      )}
      {claimReleaseTarget && (
        <ClaimReleaseDialog
          target={claimReleaseTarget}
          saving={claimReleaseSaving}
          error={claimReleaseError}
          conflict={claimReleaseConflict}
          onClose={() => closeClaimRelease()}
          onConfirm={() => void confirmClaimRelease()}
        />
      )}
      {!agentSetupDismissed &&
        agentIntegrationQuery.data &&
        (!agentIntegrationQuery.data.mcpServer.installed ||
          !agentIntegrationQuery.data.agentInstructions.installed ||
          !agentIntegrationQuery.data.skill.installed) && (
          <AgentIntegrationSetupDialog
            settings={agentIntegrationQuery.data}
            onDismiss={dismissAgentSetup}
            onNotice={setNotice}
          />
        )}
    </div>
  );
}
