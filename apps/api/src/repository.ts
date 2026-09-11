import { randomUUID } from "node:crypto";
import {
  activeActionableExcludeFilterKeys,
  actionableQuerySchema,
  actionableDetailSchema,
  actionableSummarySchema,
  actionablesListResponseSchema,
  archiveImpactResponseSchema,
  createRepositoryResponseSchema,
  dashboardResponseSchema,
  scopeOptionsResponseSchema,
  type ActionableExcludeFilterKey,
  type ActionableQuery,
  type ActionableDetail,
  type ActionableSummary,
  type ActionablesListResponse,
  type ArchiveImpactResponse,
  type ArchiveTargetKind,
  type DashboardResponse,
  type CreateActionableRequest,
  type CreateRepositoryRequest,
  type CreateRepositoryResponse,
  type UpdateRepositoryProjectRequest,
  type CreateValidationRecordRequest,
  type ScopeOptionsResponse,
  type Status,
  type StatusTransitionRequest,
  type UpdateActionableRequest,
  type UserSourceReference,
  type UserSourceReferenceInput,
} from "@actionables/contracts";
import type { Prisma } from "./generated/prisma/client.js";
import type { AppPrismaClient } from "./database.js";
import { getAgentCoordinationSettings } from "./helper-agent-settings.js";
import {
  canTransition,
  lifecycleReadiness,
  parsePersistedStatus,
  permittedTransitions,
  transitionExplanation,
} from "./actionable-transitions.js";

const actionableInclude = {
  project: true,
  repository: true,
  worktree: true,
  statusHistory: {
    orderBy: { occurredAt: "desc" as const },
  },
  validationRecords: {
    orderBy: { recordedAt: "asc" as const },
  },
  activityEvents: {
    orderBy: [{ occurredAt: "asc" as const }, { id: "asc" as const }],
  },
  userSources: {
    where: { removedAt: null },
    orderBy: { createdAt: "asc" as const },
  },
  hierarchyAsParent: {
    where: { detachedAt: null },
    orderBy: { createdAt: "asc" as const },
    include: {
      child: { include: { project: true, repository: true, worktree: true } },
    },
  },
  hierarchyAsChild: {
    where: { detachedAt: null },
    include: {
      parent: { include: { project: true, repository: true, worktree: true } },
    },
  },
  dependenciesAsDependent: {
    where: { removedAt: null },
    orderBy: { createdAt: "asc" as const },
    include: {
      prerequisite: {
        include: { project: true, repository: true, worktree: true },
      },
    },
  },
  dependenciesAsPrerequisite: {
    where: { removedAt: null },
    orderBy: { createdAt: "asc" as const },
    include: {
      dependent: {
        include: { project: true, repository: true, worktree: true },
      },
    },
  },
  agentTaskClaim: true,
} satisfies Prisma.ActionableInclude;

type ActionableRow = Prisma.ActionableGetPayload<{
  include: typeof actionableInclude;
}>;
type TransactionClient = Prisma.TransactionClient;

export class DomainValidationError extends Error {
  constructor(
    public readonly code: string,
    public readonly fieldErrors: Record<string, string[]>,
    message: string,
  ) {
    super(message);
  }
}

export class VersionConflictError extends Error {
  constructor(public readonly current: ActionableDetail) {
    super("This actionable changed after editing began.");
  }
}

export class ScopeVersionConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super("This scope record has a newer saved version.");
  }
}

function stringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function sourceFiles(value: Prisma.JsonValue) {
  return Array.isArray(value) ? value : [];
}

function stringContext(value: Prisma.JsonValue): Record<string, string> {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, String(item ?? "")]),
  );
}

function latestInProgressAt(row: ActionableRow) {
  return (
    row.statusHistory.find((entry) => entry.newStatus === "In progress")
      ?.occurredAt ?? null
  );
}

function qualifyingValidationIds(row: ActionableRow) {
  const startedAt = latestInProgressAt(row);
  if (!startedAt) return new Set<string>();
  const superseded = new Set(
    row.validationRecords
      .map((record) => record.supersedesId)
      .filter((id): id is string => Boolean(id)),
  );
  return new Set(
    row.validationRecords
      .filter(
        (record) =>
          record.outcome === "Passed" &&
          record.recordedAt >= startedAt &&
          !superseded.has(record.id),
      )
      .map((record) => record.id),
  );
}

function latestQualifyingValidationId(row: ActionableRow) {
  const qualifying = qualifyingValidationIds(row);
  return (
    [...row.validationRecords]
      .reverse()
      .find((record) => qualifying.has(record.id))?.id ?? null
  );
}

function archiveState(
  row: Pick<
    ActionableRow,
    "archivedAt" | "project" | "repository" | "worktree"
  >,
) {
  const inheritedFrom: Array<"project" | "repository" | "worktree"> = [];
  if (row.project.archivedAt) inheritedFrom.push("project");
  if (row.repository.archivedAt) inheritedFrom.push("repository");
  if (row.worktree.archivedAt) inheritedFrom.push("worktree");
  return {
    isArchived: Boolean(row.archivedAt || inheritedFrom.length),
    directlyArchived: Boolean(row.archivedAt),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    inheritedFrom,
  };
}

type RelatedRow =
  | ActionableRow
  | ActionableRow["hierarchyAsParent"][number]["child"]
  | ActionableRow["hierarchyAsChild"][number]["parent"]
  | ActionableRow["dependenciesAsDependent"][number]["prerequisite"]
  | ActionableRow["dependenciesAsPrerequisite"][number]["dependent"];

function relatedActionable(row: RelatedRow) {
  return {
    id: row.sourceOrdinal,
    recordId: row.id,
    title: row.title,
    status: parsePersistedStatus(row.status),
    version: row.version,
    scope: {
      projectId: row.project.id,
      projectName: row.project.name,
      repositoryId: row.repository.id,
      repositoryName: row.repository.name,
      worktreeId: row.worktree.id,
      worktreeName: row.worktree.name,
    },
    archiveState: archiveState(row as ActionableRow),
  };
}

function dependencyState(
  relationship: ActionableRow["dependenciesAsDependent"][number],
) {
  const prerequisite = relationship.prerequisite;
  if (relationship.waivedAt) return "waived" as const;
  if (prerequisite.status === "Done") return "satisfied" as const;
  if (prerequisite.status === "Dismissed")
    return "dismissed-prerequisite" as const;
  return "unresolved" as const;
}

function dependencyDetail(
  relationship: ActionableRow["dependenciesAsDependent"][number],
  dependent: RelatedRow,
) {
  const state = dependencyState(relationship);
  return {
    id: relationship.id,
    dependent: relatedActionable(dependent),
    prerequisite: relatedActionable(relationship.prerequisite),
    state,
    isSatisfied: state === "satisfied" || state === "waived",
    waiverReason: relationship.waiverReason,
    createdAt: relationship.createdAt.toISOString(),
  };
}

function toSummary(row: ActionableRow): ActionableSummary {
  const imported = row.importProvider !== "MANUAL";
  const status = parsePersistedStatus(row.status);
  const unresolvedDependencies = row.dependenciesAsDependent.filter(
    (relationship) =>
      !relationship.waivedAt && relationship.prerequisite.status !== "Done",
  );
  const childIds = row.hierarchyAsParent.map(
    (relationship) => relationship.child.sourceOrdinal,
  );
  const terminalChildren = row.hierarchyAsParent.filter((relationship) =>
    ["Done", "Dismissed"].includes(relationship.child.status),
  ).length;
  return actionableSummarySchema.parse({
    id: row.sourceOrdinal,
    recordId: row.id,
    externalKey: row.externalKey,
    title: row.title,
    priority: row.priority,
    status,
    statusProvenance: imported
      ? {
          kind: "neutral-import",
          note: row.statusProvenance,
          suggestedStatus: row.sourceStatusSuggestion ?? undefined,
        }
      : {
          kind: "user-authored",
          note: row.statusProvenance,
        },
    scope: {
      projectId: row.project.id,
      projectName: row.project.name,
      repositoryId: row.repository.id,
      repositoryName: row.repository.name,
      worktreeId: row.worktree.id,
      worktreeName: row.worktree.name,
    },
    worktree: row.worktree.name,
    effort: row.effort,
    evidenceState: row.evidenceState,
    version: row.version,
    updated: row.updatedLabel,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finding: row.finding,
    tags: stringArray(row.tagsJson),
    manualBlocker: row.manualBlockerMd,
    isDependencyBlocked: unresolvedDependencies.length > 0,
    isEffectivelyBlocked:
      status === "Blocked" || unresolvedDependencies.length > 0,
    unresolvedDependencyCount: unresolvedDependencies.length,
    dependencyCount: row.dependenciesAsDependent.length,
    blocksCount: row.dependenciesAsPrerequisite.length,
    hasQualifyingValidation: latestQualifyingValidationId(row) !== null,
    wasReopened: row.activityEvents.some(
      (event) =>
        event.type === "reopened" || event.type === "parent-auto-reopened",
    ),
    archiveState: archiveState(row),
    blockedBy:
      row.dependenciesAsDependent.length > 0
        ? row.dependenciesAsDependent.map(
            (relationship) => relationship.prerequisite.sourceOrdinal,
          )
        : undefined,
    blocks:
      row.dependenciesAsPrerequisite.length > 0
        ? row.dependenciesAsPrerequisite.map(
            (relationship) => relationship.dependent.sourceOrdinal,
          )
        : undefined,
    parentId: row.hierarchyAsChild[0]?.parent.sourceOrdinal,
    childIds: childIds.length > 0 ? childIds : undefined,
    childCompletion:
      childIds.length > 0
        ? { terminal: terminalChildren, total: childIds.length }
        : undefined,
  });
}

function toDetail(row: ActionableRow): ActionableDetail {
  const status = parsePersistedStatus(row.status);
  const imported = row.importProvider !== "MANUAL";
  const qualifying = qualifyingValidationIds(row);
  const research = stringArray(row.researchJson);
  const validation = stringArray(row.validationJson);
  const readiness = lifecycleReadiness(status, {
    finding: row.finding,
    description: row.description,
    research,
    plannedValidation: validation,
  });
  const now = new Date();
  return actionableDetailSchema.parse({
    ...toSummary(row),
    workspacePath: row.worktree.localPath ?? row.repository.localPath,
    agentClaim: row.agentTaskClaim
      ? {
          agentId: row.agentTaskClaim.agentId,
          claimedAt: row.agentTaskClaim.claimedAt.toISOString(),
          renewedAt: row.agentTaskClaim.renewedAt.toISOString(),
          leaseExpiresAt: row.agentTaskClaim.leaseExpiresAt.toISOString(),
          state:
            row.agentTaskClaim.leaseExpiresAt <= now ? "expired" : "active",
          isReleasable: row.agentTaskClaim.leaseExpiresAt <= now,
        }
      : null,
    description: row.description,
    resolution: row.resolution,
    research,
    validation,
    userSources: row.userSources.map((source) => ({
      id: source.id,
      type: source.type,
      locator: source.locator,
      label: source.label ?? undefined,
      provenance: source.provenance,
      createdAt: source.createdAt.toISOString(),
    })),
    immutableSourceEvidence: {
      imported,
      sourceThread: imported ? row.sourceThread : "",
      sourceFiles: imported ? sourceFiles(row.filesJson) : [],
      rawSource: imported ? row.rawFragmentJson : undefined,
      note: imported
        ? "Imported source evidence is read-only. Editing the actionable changes only user-authored fields."
        : "This actionable was created manually and has no imported source evidence.",
    },
    files: sourceFiles(row.filesJson),
    sourceThread: row.sourceThread,
    readiness,
    permittedTransitions: permittedTransitions(status, readiness),
    statusHistory: row.statusHistory.map((entry) => ({
      id: entry.id,
      previousStatus: entry.previousStatus,
      newStatus: entry.newStatus,
      origin: entry.origin,
      occurredAt: entry.occurredAt.toISOString(),
    })),
    validationRecords: row.validationRecords.map((record) => ({
      id: record.id,
      type: record.type,
      outcome: record.outcome,
      notes: record.notesMd,
      evidence: record.evidenceMd,
      origin: record.origin,
      recordedAt: record.recordedAt.toISOString(),
      supersedesId: record.supersedesId,
      supersededById:
        row.validationRecords.find(
          (candidate) => candidate.supersedesId === record.id,
        )?.id ?? null,
      qualifiesForCompletion: qualifying.has(record.id),
    })),
    activity: row.activityEvents.map((event) => ({
      id: event.id,
      type: event.type,
      summary: event.summary,
      context: stringContext(event.metadataJson),
      occurredAt: event.occurredAt.toISOString(),
    })),
    completionEligibility: {
      qualifyingValidationRecordId: latestQualifyingValidationId(row),
      policy:
        "A current Passed validation recorded after the latest move into In progress qualifies. Failed, Partial, and superseded records do not.",
    },
    relationships: {
      parent: row.hierarchyAsChild[0]
        ? {
            id: row.hierarchyAsChild[0].id,
            parent: relatedActionable(row.hierarchyAsChild[0].parent),
            child: relatedActionable(row),
            createdAt: row.hierarchyAsChild[0].createdAt.toISOString(),
          }
        : null,
      subtasks: row.hierarchyAsParent.map((relationship) => ({
        id: relationship.id,
        parent: relatedActionable(row),
        child: relatedActionable(relationship.child),
        createdAt: relationship.createdAt.toISOString(),
      })),
      blockedBy: row.dependenciesAsDependent.map((relationship) =>
        dependencyDetail(relationship, row),
      ),
      blocks: row.dependenciesAsPrerequisite.map((relationship) => {
        const state = relationship.waivedAt
          ? "waived"
          : row.status === "Done"
            ? "satisfied"
            : row.status === "Dismissed"
              ? "dismissed-prerequisite"
              : "unresolved";
        return {
          id: relationship.id,
          dependent: relatedActionable(relationship.dependent),
          prerequisite: relatedActionable(row),
          state,
          isSatisfied: state === "satisfied" || state === "waived",
          waiverReason: relationship.waiverReason,
          createdAt: relationship.createdAt.toISOString(),
        };
      }),
    },
  });
}

async function validateScope(
  client: AppPrismaClient | TransactionClient,
  input: Pick<
    CreateActionableRequest,
    "projectId" | "repositoryId" | "worktreeId"
  >,
) {
  const [project, repository, worktree] = await Promise.all([
    client.project.findUnique({ where: { id: input.projectId } }),
    client.repository.findUnique({ where: { id: input.repositoryId } }),
    client.worktree.findUnique({ where: { id: input.worktreeId } }),
  ]);

  const errors: Record<string, string[]> = {};
  if (!project) errors.projectId = ["Choose an existing project."];
  if (!repository || repository.projectId !== input.projectId) {
    errors.repositoryId = ["Choose a repository in the selected project."];
  }
  if (
    !worktree ||
    worktree.projectId !== input.projectId ||
    worktree.repositoryId !== input.repositoryId
  ) {
    errors.worktreeId = ["Choose a worktree in the selected repository."];
  }

  if (Object.keys(errors).length > 0) {
    throw new DomainValidationError(
      "INVALID_SCOPE",
      errors,
      "The selected scope is invalid.",
    );
  }
}

async function findActionableRow(
  client: AppPrismaClient | TransactionClient,
  sourceOrdinal: number,
) {
  return client.actionable.findUnique({
    where: { sourceOrdinal },
    include: actionableInclude,
  });
}

const priorityRank = new Map(
  ["Critical", "High", "Medium", "Low", "Backlog", "Unset"].map(
    (value, index) => [value, index],
  ),
);
const effortRank = new Map(
  ["XS", "S", "S–M", "M", "M–L", "L", "L–XL", "XL", "Unknown"].map(
    (value, index) => [value, index],
  ),
);
const statusRank = new Map(
  [
    "Inbox",
    "Researching",
    "Ready",
    "In progress",
    "Blocked",
    "Done",
    "Dismissed",
  ].map((value, index) => [value, index]),
);

function isTerminalStatus(status: string) {
  return status === "Done" || status === "Dismissed";
}

function boolMatch(filter: "all" | "yes" | "no", value: boolean) {
  return filter === "all" || (filter === "yes" ? value : !value);
}

function filterAllows(
  excluded: ReadonlySet<ActionableExcludeFilterKey>,
  key: ActionableExcludeFilterKey,
  active: boolean,
  matches: boolean,
) {
  return !active || (excluded.has(key) ? !matches : matches);
}

function searchText(row: ActionableRow) {
  return [
    row.title,
    row.finding,
    row.description,
    ...stringArray(row.researchJson),
    ...stringArray(row.tagsJson),
    row.worktree.name,
    row.worktree.localPath ?? "",
    row.repository.name,
    row.repository.localPath ?? "",
    row.project.name,
    row.sourceThread,
    ...sourceFiles(row.filesJson).flatMap((file) => {
      if (!file || typeof file !== "object" || Array.isArray(file)) return [];
      return Object.values(file).map((value) => String(value ?? ""));
    }),
    ...row.userSources.flatMap((source) => [
      source.locator,
      source.label ?? "",
    ]),
  ]
    .join("\n")
    .toLocaleLowerCase();
}

function matchesQuery(row: ActionableRow, query: ActionableQuery) {
  const summary = toSummary(row);
  const isTopLevel = row.hierarchyAsChild.length === 0;
  const excluded = new Set(activeActionableExcludeFilterKeys(query));
  if (query.project && row.project.id !== query.project) return false;
  if (query.repository && row.repository.id !== query.repository) return false;
  if (query.worktree && row.worktree.id !== query.worktree) return false;
  const statusMatches =
    query.status === "active"
      ? !isTerminalStatus(summary.status)
      : query.status === "all" || summary.status === query.status;
  if (!filterAllows(excluded, "status", query.status !== "all", statusMatches))
    return false;
  if (
    !filterAllows(
      excluded,
      "manualBlocked",
      query.manualBlocked !== "all",
      boolMatch(query.manualBlocked, summary.status === "Blocked"),
    )
  )
    return false;
  if (
    !filterAllows(
      excluded,
      "dependencyBlocked",
      query.dependencyBlocked !== "all",
      boolMatch(query.dependencyBlocked, summary.isDependencyBlocked),
    )
  )
    return false;
  if (
    !filterAllows(
      excluded,
      "priority",
      Boolean(query.priority),
      summary.priority === query.priority,
    )
  )
    return false;
  if (
    !filterAllows(
      excluded,
      "effort",
      Boolean(query.effort),
      summary.effort === query.effort,
    )
  )
    return false;
  if (
    !filterAllows(
      excluded,
      "evidence",
      Boolean(query.evidence),
      summary.evidenceState === query.evidence,
    )
  )
    return false;
  const tagMatches = summary.tags.some(
    (tag) => tag.toLocaleLowerCase() === query.tag.toLocaleLowerCase(),
  );
  if (!filterAllows(excluded, "tag", Boolean(query.tag), tagMatches))
    return false;
  if (
    query.archived !== "all" &&
    (query.archived === "archived") !== summary.archiveState.isArchived
  )
    return false;
  const parentMatches =
    query.parent === "all" ||
    (query.parent === "top-level" ? isTopLevel : !isTopLevel);
  if (!filterAllows(excluded, "parent", query.parent !== "all", parentMatches))
    return false;
  if (
    !filterAllows(
      excluded,
      "validation",
      query.validation !== "all",
      boolMatch(query.validation, summary.hasQualifyingValidation),
    )
  )
    return false;
  if (
    !filterAllows(
      excluded,
      "reopened",
      query.reopened !== "all",
      boolMatch(query.reopened, summary.wasReopened),
    )
  )
    return false;
  if (query.q && !searchText(row).includes(query.q.toLocaleLowerCase()))
    return false;
  return true;
}

function sortRows(rows: ActionableRow[], sort: ActionableQuery["sort"]) {
  return [...rows].sort((left, right) => {
    let result = 0;
    if (sort === "priority") {
      result =
        (priorityRank.get(left.priority) ?? 99) -
        (priorityRank.get(right.priority) ?? 99);
    } else if (sort === "updated-desc") {
      result = right.updatedAt.getTime() - left.updatedAt.getTime();
    } else if (sort === "updated-asc") {
      result = left.updatedAt.getTime() - right.updatedAt.getTime();
    } else if (sort === "created-desc") {
      result = right.createdAt.getTime() - left.createdAt.getTime();
    } else if (sort === "title") {
      result = left.title.localeCompare(right.title);
    } else if (sort === "status") {
      result =
        (statusRank.get(left.status) ?? 99) -
        (statusRank.get(right.status) ?? 99);
    } else if (sort === "effort") {
      result =
        (effortRank.get(left.effort) ?? 99) -
        (effortRank.get(right.effort) ?? 99);
    }
    return result || left.sourceOrdinal - right.sourceOrdinal;
  });
}

export function actionableQueryRecord(query: ActionableQuery) {
  const values: Record<string, string> = {};
  if (query.project) values.project = query.project;
  if (query.repository) values.repository = query.repository;
  if (query.worktree) values.worktree = query.worktree;
  if (query.status !== "active") values.status = query.status;
  if (query.manualBlocked !== "all") values.manualBlocked = query.manualBlocked;
  if (query.dependencyBlocked !== "all")
    values.dependencyBlocked = query.dependencyBlocked;
  if (query.priority) values.priority = query.priority;
  if (query.effort) values.effort = query.effort;
  if (query.evidence) values.evidence = query.evidence;
  if (query.tag) values.tag = query.tag;
  if (query.archived !== "active") values.archived = query.archived;
  if (query.parent !== "all") values.parent = query.parent;
  if (query.validation !== "all") values.validation = query.validation;
  if (query.reopened !== "all") values.reopened = query.reopened;
  const excluded = activeActionableExcludeFilterKeys(query);
  if (excluded.length > 0) values.exclude = excluded.join(",");
  if (query.q) values.q = query.q;
  if (query.sort !== "priority") values.sort = query.sort;
  return values;
}

async function allActionableRows(prisma: AppPrismaClient) {
  return prisma.actionable.findMany({
    include: actionableInclude,
    orderBy: { sourceOrdinal: "asc" },
  });
}

export async function listActionablesWithQuery(
  prisma: AppPrismaClient,
  query: ActionableQuery,
): Promise<ActionablesListResponse> {
  const rows = await allActionableRows(prisma);
  const matchedRows = sortRows(
    rows.filter((row) => matchesQuery(row, query)),
    query.sort,
  );
  const first = rows[0];
  if (!first) {
    return actionablesListResponseSchema.parse({
      project: { name: "Actionables" },
      repository: { name: "Repository" },
      worktree: { name: "Worktree" },
      counts: { total: 0, topLevel: 0 },
      result: {
        matched: 0,
        scopeTotal: 0,
        openScopeTotal: 0,
        topLevel: 0,
        nested: 0,
        normalizedQuery: actionableQueryRecord(query),
      },
      items: [],
    });
  }

  const resultTopLevel = matchedRows.filter(
    (row) => row.hierarchyAsChild.length === 0,
  ).length;
  const scopeQuery = actionableQuerySchema.parse({
    project: query.project,
    repository: query.repository,
    worktree: query.worktree,
    archived: query.archived,
    status: "all",
  });
  const scopeTotal = rows.filter((row) => matchesQuery(row, scopeQuery)).length;
  const openScopeQuery = actionableQuerySchema.parse({
    project: query.project,
    repository: query.repository,
    worktree: query.worktree,
    archived: "active",
    status: "active",
  });
  const openScopeTotal = rows.filter((row) =>
    matchesQuery(row, openScopeQuery),
  ).length;
  return actionablesListResponseSchema.parse({
    project: { name: first.project.name },
    repository: { name: first.repository.name },
    worktree: { name: first.worktree.name },
    counts: {
      total: rows.length,
      topLevel: rows.filter((row) => row.hierarchyAsChild.length === 0).length,
    },
    result: {
      matched: matchedRows.length,
      scopeTotal,
      openScopeTotal,
      topLevel: resultTopLevel,
      nested: matchedRows.length - resultTopLevel,
      normalizedQuery: actionableQueryRecord(query),
    },
    items: matchedRows.map(toSummary),
  });
}

export async function listScopeOptions(
  prisma: AppPrismaClient | TransactionClient,
): Promise<ScopeOptionsResponse> {
  const projects = await prisma.project.findMany({
    orderBy: { name: "asc" },
    include: {
      repositories: {
        orderBy: { name: "asc" },
        include: { worktrees: { orderBy: { name: "asc" } } },
      },
    },
  });

  return scopeOptionsResponseSchema.parse({
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      isUnassigned: project.externalKey === unassignedProjectKey,
      version: project.version,
      archivedAt: project.archivedAt?.toISOString() ?? null,
      archiveState: {
        isArchived: Boolean(project.archivedAt),
        directlyArchived: Boolean(project.archivedAt),
        archivedAt: project.archivedAt?.toISOString() ?? null,
        inheritedFrom: [],
      },
      repositories: project.repositories.map((repository) => ({
        id: repository.id,
        name: repository.name,
        version: repository.version,
        archivedAt: repository.archivedAt?.toISOString() ?? null,
        archiveState: {
          isArchived: Boolean(project.archivedAt || repository.archivedAt),
          directlyArchived: Boolean(repository.archivedAt),
          archivedAt: repository.archivedAt?.toISOString() ?? null,
          inheritedFrom: project.archivedAt ? ["project"] : [],
        },
        worktrees: repository.worktrees.map((worktree) => ({
          id: worktree.id,
          name: worktree.name,
          version: worktree.version,
          archivedAt: worktree.archivedAt?.toISOString() ?? null,
          archiveState: {
            isArchived: Boolean(
              project.archivedAt ||
              repository.archivedAt ||
              worktree.archivedAt,
            ),
            directlyArchived: Boolean(worktree.archivedAt),
            archivedAt: worktree.archivedAt?.toISOString() ?? null,
            inheritedFrom: [
              ...(project.archivedAt ? ["project" as const] : []),
              ...(repository.archivedAt ? ["repository" as const] : []),
            ],
          },
        })),
      })),
    })),
  });
}

export function normalizedLocalPath(value: string) {
  const normalized = value.trim().replace(/\//g, "\\");
  const rootLength = /^[a-zA-Z]:\\/.test(normalized)
    ? 3
    : normalized.startsWith("\\\\")
      ? 2
      : 0;
  return normalized.length > rootLength
    ? normalized.replace(/\\+$/, "")
    : normalized;
}

const unassignedProjectKey = "system-unassigned-project";
const unassignedProjectName = "No project";

/** Move the complete repository scope without changing identity or workflow. */
export async function updateRepositoryProject(
  prisma: AppPrismaClient,
  id: string,
  input: UpdateRepositoryProjectRequest,
): Promise<ScopeOptionsResponse | null> {
  return prisma.$transaction(async (transaction) => {
    const repository = await transaction.repository.findUnique({
      where: { id },
      include: { project: true },
    });
    if (!repository) return null;
    if (repository.version !== input.version)
      throw new ScopeVersionConflictError(repository.version);
    if (repository.archivedAt || repository.project.archivedAt)
      throw new DomainValidationError(
        "ARCHIVED_SCOPE",
        {
          projectId: [
            "Restore the repository and its project before changing the assignment.",
          ],
        },
        "This repository is archived.",
      );

    const project =
      input.projectId === null
        ? await transaction.project.upsert({
            where: { externalKey: unassignedProjectKey },
            create: {
              externalKey: unassignedProjectKey,
              name: unassignedProjectName,
            },
            update: {},
          })
        : await transaction.project.findUnique({
            where: { id: input.projectId },
          });
    if (!project || project.archivedAt)
      throw new DomainValidationError(
        "INVALID_PROJECT",
        { projectId: ["Choose an active project."] },
        "The selected project is unavailable.",
      );
    if (project.id === repository.projectId)
      return listScopeOptions(transaction);

    const claim = await transaction.agentTaskClaim.findFirst({
      where: { actionable: { repositoryId: id } },
      select: { actionable: { select: { sourceOrdinal: true } } },
    });
    if (claim)
      throw new DomainValidationError(
        "REPOSITORY_CLAIMED",
        {
          projectId: [
            `Release the agent claim on #${claim.actionable.sourceOrdinal} before changing the repository assignment, including expired claims.`,
          ],
        },
        "This repository has an unreleased agent claim.",
      );
    const siblings = await transaction.repository.findMany({
      where: { projectId: project.id, id: { not: id } },
      select: { name: true },
    });
    if (
      siblings.some(
        (sibling) =>
          sibling.name.localeCompare(repository.name, undefined, {
            sensitivity: "accent",
          }) === 0,
      )
    )
      throw new DomainValidationError(
        "DUPLICATE_REPOSITORY",
        {
          projectId: [
            "A repository with this name is already tracked in that project.",
          ],
        },
        "This project already contains a repository with that name.",
      );

    const updated = await transaction.repository.updateMany({
      where: { id, version: input.version },
      data: { projectId: project.id, version: { increment: 1 } },
    });
    if (updated.count !== 1)
      throw new ScopeVersionConflictError(repository.version);
    await transaction.worktree.updateMany({
      where: { repositoryId: id },
      data: { projectId: project.id, version: { increment: 1 } },
    });
    const actionables = await transaction.actionable.findMany({
      where: { repositoryId: id },
      select: { id: true },
    });
    await transaction.actionable.updateMany({
      where: { repositoryId: id },
      data: {
        projectId: project.id,
        version: { increment: 1 },
        updatedLabel: "just now",
      },
    });
    await transaction.activityEvent.createMany({
      data: actionables.map((actionable) => ({
        actionableId: actionable.id,
        type: "scope-changed",
        summary: `Moved repository from ${repository.project.name} to ${project.name}`,
        metadataJson: inputJson({
          origin: "user",
          previousProjectId: repository.projectId,
          projectId: project.id,
          repositoryId: id,
        }),
      })),
    });
    return listScopeOptions(transaction);
  });
}

export async function createRepository(
  prisma: AppPrismaClient,
  input: CreateRepositoryRequest,
): Promise<CreateRepositoryResponse> {
  const name = input.name.trim();
  const localPath = normalizedLocalPath(input.localPath);

  return prisma.$transaction(async (transaction) => {
    let projectId: string;
    if (input.projectMode === "existing") {
      const project = await transaction.project.findUnique({
        where: { id: input.projectId },
      });
      if (!project || project.archivedAt) {
        throw new DomainValidationError(
          "INVALID_PROJECT",
          { projectId: ["Choose an active project."] },
          "The selected project is unavailable.",
        );
      }
      projectId = project.id;
    } else {
      const projectName = input.projectName.trim();
      if (projectName.toLowerCase() === unassignedProjectName.toLowerCase())
        throw new DomainValidationError(
          "INVALID_PROJECT",
          {
            projectName: [
              "No project is reserved for repositories without an assignment.",
            ],
          },
          "Choose a different project name.",
        );
      const projects = await transaction.project.findMany({
        where: { archivedAt: null },
        select: { name: true },
      });
      if (
        projects.some(
          (existing) =>
            existing.name.localeCompare(projectName, undefined, {
              sensitivity: "accent",
            }) === 0,
        )
      ) {
        throw new DomainValidationError(
          "DUPLICATE_PROJECT",
          {
            projectName: [
              "A project with this name already exists. Select the existing project instead.",
            ],
          },
          "This project already exists.",
        );
      }
      const project = await transaction.project.create({
        data: {
          externalKey: `manual-project-${randomUUID()}`,
          name: projectName,
        },
      });
      projectId = project.id;
    }

    const repositories = await transaction.repository.findMany({
      select: { projectId: true, name: true, localPath: true },
    });
    const errors: Record<string, string[]> = {};
    if (
      repositories.some(
        (repository) =>
          repository.projectId === projectId &&
          repository.name.localeCompare(name, undefined, {
            sensitivity: "accent",
          }) === 0,
      )
    ) {
      errors.name = [
        "A repository with this name is already tracked in the project.",
      ];
    }
    if (
      repositories.some(
        (repository) =>
          repository.localPath &&
          normalizedLocalPath(repository.localPath).toLowerCase() ===
            localPath.toLowerCase(),
      )
    ) {
      errors.localPath = ["This local repository path is already tracked."];
    }
    if (Object.keys(errors).length > 0) {
      throw new DomainValidationError(
        "DUPLICATE_REPOSITORY",
        errors,
        "This repository is already tracked.",
      );
    }

    const repository = await transaction.repository.create({
      data: {
        externalKey: `manual-repository-${randomUUID()}`,
        name,
        localPath,
        projectId,
      },
    });
    const worktree = await transaction.worktree.create({
      data: {
        externalKey: `manual-worktree-${randomUUID()}`,
        name: "Default",
        localPath,
        projectId,
        repositoryId: repository.id,
      },
    });

    return createRepositoryResponseSchema.parse({
      projectId,
      repositoryId: repository.id,
      worktreeId: worktree.id,
      scopes: await listScopeOptions(transaction),
    });
  });
}

export async function getActionable(
  prisma: AppPrismaClient | TransactionClient,
  sourceOrdinal: number,
): Promise<ActionableDetail | null> {
  const row = await findActionableRow(prisma, sourceOrdinal);
  return row ? toDetail(row) : null;
}

export async function listInboxTriageCandidates(
  prisma: AppPrismaClient,
  scope: Partial<Pick<ActionableQuery, "project" | "repository" | "worktree">>,
  limit: number,
): Promise<ActionableDetail[]> {
  return (await allActionableRows(prisma))
    .filter(
      (row) =>
        (!scope.project || row.projectId === scope.project) &&
        (!scope.repository || row.repositoryId === scope.repository) &&
        (!scope.worktree || row.worktreeId === scope.worktree) &&
        !archiveState(row).isArchived &&
        row.status === "Inbox",
    )
    .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal)
    .slice(0, limit)
    .map(toDetail);
}

export async function getDashboard(
  prisma: AppPrismaClient,
  scope: Pick<ActionableQuery, "project" | "repository" | "worktree">,
): Promise<DashboardResponse> {
  const now = new Date();
  const { agentClaimExpiryWarningMinutes } =
    await getAgentCoordinationSettings(prisma);
  const expiringClaimCutoff = new Date(
    now.getTime() + agentClaimExpiryWarningMinutes * 60_000,
  );
  const rows = (await allActionableRows(prisma)).filter(
    (row) =>
      (!scope.project || row.projectId === scope.project) &&
      (!scope.repository || row.repositoryId === scope.repository) &&
      (!scope.worktree || row.worktreeId === scope.worktree) &&
      !archiveState(row).isArchived,
  );
  const summaries = new Map(rows.map((row) => [row.id, toSummary(row)]));
  const recent = (predicate: (row: ActionableRow) => boolean) =>
    [...rows]
      .filter(predicate)
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() ||
          left.sourceOrdinal - right.sourceOrdinal,
      );
  const queue = (
    key: DashboardResponse["queues"][number]["key"],
    label: string,
    description: string,
    query: Record<string, string>,
    matching: ActionableRow[],
  ) => ({
    key,
    label,
    description,
    count: matching.length,
    query: {
      ...actionableQueryRecord(actionableQuerySchema.parse(scope)),
      ...query,
    },
    items: matching.slice(0, 6).map((row) => summaries.get(row.id)!),
  });

  const byOrdinal = (items: ActionableRow[]) =>
    [...items].sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  const byClaimExpiry = (items: ActionableRow[]) =>
    [...items].sort(
      (left, right) =>
        left.agentTaskClaim!.leaseExpiresAt.getTime() -
          right.agentTaskClaim!.leaseExpiresAt.getTime() ||
        left.sourceOrdinal - right.sourceOrdinal,
    );
  const alert = (
    key: DashboardResponse["alerts"][number]["key"],
    label: string,
    description: string,
    tone: DashboardResponse["alerts"][number]["tone"],
    matching: ActionableRow[],
    detail: (row: ActionableRow) => string,
  ): DashboardResponse["alerts"][number] => ({
    key,
    label,
    description,
    tone,
    count: matching.length,
    items: matching.slice(0, 6).map((row) => ({
      actionable: summaries.get(row.id)!,
      detail: detail(row),
      dueAt: row.agentTaskClaim?.leaseExpiresAt.toISOString() ?? null,
    })),
  });
  const blockedRows = byOrdinal(
    rows.filter((row) => summaries.get(row.id)!.isEffectivelyBlocked),
  );
  const missingValidationRows = byOrdinal(
    rows.filter(
      (row) =>
        row.status === "In progress" && !latestQualifyingValidationId(row),
    ),
  );
  const alerts: DashboardResponse["alerts"] = [
    alert(
      "expiring-claims",
      "Claims expiring soon",
      `Active agent leases with ${agentClaimExpiryWarningMinutes} ${
        agentClaimExpiryWarningMinutes === 1 ? "minute" : "minutes"
      } or less remaining.`,
      "warning",
      byClaimExpiry(
        rows.filter(
          (row) =>
            row.agentTaskClaim &&
            row.agentTaskClaim.leaseExpiresAt > now &&
            row.agentTaskClaim.leaseExpiresAt <= expiringClaimCutoff,
        ),
      ),
      (row) =>
        `${row.agentTaskClaim!.agentId} · expires ${row.agentTaskClaim!.leaseExpiresAt.toLocaleTimeString()}`,
    ),
    alert(
      "blocked-work",
      "Blocked work",
      "Tasks stopped by a manual blocker or unresolved prerequisite.",
      "critical",
      blockedRows,
      (row) => {
        const summary = summaries.get(row.id)!;
        if (row.status === "Blocked" && summary.unresolvedDependencyCount > 0) {
          return `Manual blocker · ${summary.unresolvedDependencyCount} unresolved prerequisite${summary.unresolvedDependencyCount === 1 ? "" : "s"}`;
        }
        if (row.status === "Blocked") return "Manual blocker";
        return `${summary.unresolvedDependencyCount} unresolved prerequisite${summary.unresolvedDependencyCount === 1 ? "" : "s"}`;
      },
    ),
    alert(
      "missing-validation",
      "Missing validation",
      "In-progress work without a qualifying Passed result.",
      "warning",
      missingValidationRows,
      () => "No qualifying Passed result since work started",
    ),
    alert(
      "abandoned-sessions",
      "Abandoned sessions",
      "Expired agent leases that still need reconciliation.",
      "critical",
      byClaimExpiry(
        rows.filter(
          (row) =>
            row.agentTaskClaim && row.agentTaskClaim.leaseExpiresAt <= now,
        ),
      ),
      (row) =>
        `${row.agentTaskClaim!.agentId} · expired ${row.agentTaskClaim!.leaseExpiresAt.toLocaleString()}`,
    ),
  ];
  const queues: DashboardResponse["queues"] = [
    queue(
      "inbox",
      "Inbox requiring triage",
      "Captured items that still need triage.",
      { status: "Inbox" },
      byOrdinal(rows.filter((row) => row.status === "Inbox")),
    ),
    queue(
      "researching",
      "Researching",
      "Items where evidence is still being developed.",
      { status: "Researching" },
      byOrdinal(rows.filter((row) => row.status === "Researching")),
    ),
    queue(
      "ready",
      "Ready to start",
      "Ready items without manual or dependency blockers.",
      { status: "Ready", dependencyBlocked: "no", manualBlocked: "no" },
      byOrdinal(
        rows.filter(
          (row) =>
            row.status === "Ready" && !toSummary(row).isDependencyBlocked,
        ),
      ),
    ),
    queue(
      "in-progress",
      "In progress",
      "Work currently being executed.",
      { status: "In progress" },
      byOrdinal(rows.filter((row) => row.status === "In progress")),
    ),
    queue(
      "manual-blocked",
      "Manually blocked",
      "Items explicitly blocked by the user.",
      { manualBlocked: "yes" },
      byOrdinal(rows.filter((row) => row.status === "Blocked")),
    ),
    queue(
      "dependency-blocked",
      "Dependency-blocked",
      "Items with at least one unresolved active prerequisite.",
      { dependencyBlocked: "yes" },
      byOrdinal(rows.filter((row) => toSummary(row).isDependencyBlocked)),
    ),
    queue(
      "awaiting-validation",
      "Awaiting qualifying validation",
      "In-progress items without a current qualifying Passed validation.",
      { status: "In progress", validation: "no" },
      byOrdinal(
        rows.filter(
          (row) =>
            row.status === "In progress" && !latestQualifyingValidationId(row),
        ),
      ),
    ),
    queue(
      "recently-updated",
      "Recently updated",
      "Most recently changed active items.",
      { sort: "updated-desc" },
      recent((row) => !isTerminalStatus(row.status)),
    ),
    queue(
      "recently-completed",
      "Recently completed",
      "Most recently changed Done items.",
      { status: "Done", sort: "updated-desc" },
      recent((row) => row.status === "Done"),
    ),
    queue(
      "reopened",
      "Reopened",
      "Items reopened directly or because a subtask reopened.",
      { reopened: "yes", sort: "updated-desc" },
      recent((row) =>
        row.activityEvents.some(
          (event) =>
            event.type === "reopened" || event.type === "parent-auto-reopened",
        ),
      ),
    ),
  ];
  const topLevel = rows.filter(
    (row) => row.hierarchyAsChild.length === 0,
  ).length;
  return dashboardResponseSchema.parse({
    counts: { total: rows.length, topLevel, nested: rows.length - topLevel },
    alerts,
    queues,
  });
}

type ScopeArchiveRow = {
  id: string;
  name: string;
  version: number;
  archivedAt: Date | null;
};

async function scopeTarget(
  client: AppPrismaClient | TransactionClient,
  kind: Exclude<ArchiveTargetKind, "actionable">,
  id: string,
): Promise<ScopeArchiveRow | null> {
  if (kind === "project") return client.project.findUnique({ where: { id } });
  if (kind === "repository")
    return client.repository.findUnique({ where: { id } });
  return client.worktree.findUnique({ where: { id } });
}

function scopeWhere(
  kind: Exclude<ArchiveTargetKind, "actionable">,
  id: string,
) {
  if (kind === "project") return { projectId: id };
  if (kind === "repository") return { repositoryId: id };
  return { worktreeId: id };
}

export async function archiveImpact(
  prisma: AppPrismaClient,
  kind: ArchiveTargetKind,
  id: string,
): Promise<ArchiveImpactResponse | null> {
  let target: ScopeArchiveRow | null;
  let rows: ActionableRow[];
  if (kind === "actionable") {
    const ordinal = Number(id);
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) return null;
    const row = await findActionableRow(prisma, ordinal);
    if (!row) return null;
    target = {
      id: String(row.sourceOrdinal),
      name: row.title,
      version: row.version,
      archivedAt: row.archivedAt,
    };
    rows = [row];
  } else {
    target = await scopeTarget(prisma, kind, id);
    if (!target) return null;
    rows = await prisma.actionable.findMany({
      where: scopeWhere(kind, id),
      include: actionableInclude,
      orderBy: { sourceOrdinal: "asc" },
    });
  }
  const activeSubtasks = rows.reduce(
    (total, row) =>
      total +
      row.hierarchyAsParent.filter(
        (relationship) =>
          !["Done", "Dismissed"].includes(relationship.child.status),
      ).length,
    0,
  );
  const blocks = rows.reduce(
    (total, row) => total + row.dependenciesAsPrerequisite.length,
    0,
  );
  const unresolvedPrerequisites = rows.reduce(
    (total, row) =>
      total +
      row.dependenciesAsDependent.filter(
        (relationship) =>
          !relationship.waivedAt && relationship.prerequisite.status !== "Done",
      ).length,
    0,
  );
  const descendants = kind === "actionable" ? activeSubtasks : rows.length;
  const warnings: string[] = [];
  if (activeSubtasks)
    warnings.push(
      `${activeSubtasks} active subtask${activeSubtasks === 1 ? "" : "s"} will be hidden.`,
    );
  if (kind === "actionable" && rows[0]!.hierarchyAsChild.length)
    warnings.push(
      "This actionable is a subtask; its parent relationship will be preserved.",
    );
  if (blocks)
    warnings.push(
      `${blocks} dependent actionable${blocks === 1 ? "" : "s"} will keep this prerequisite relationship.`,
    );
  if (unresolvedPrerequisites)
    warnings.push(
      `${unresolvedPrerequisites} unresolved prerequisite${unresolvedPrerequisites === 1 ? "" : "s"} will continue to block.`,
    );
  if (kind !== "actionable" && descendants)
    warnings.push(
      `${descendants} actionable${descendants === 1 ? "" : "s"} will be effectively hidden without changing workflow status.`,
    );
  return archiveImpactResponseSchema.parse({
    target: {
      kind,
      id: target.id,
      name: target.name,
      version: target.version,
      directlyArchived: Boolean(target.archivedAt),
    },
    counts: { activeSubtasks, descendants, blocks, unresolvedPrerequisites },
    warnings,
  });
}

export async function setActionableArchived(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  version: number,
  archived: boolean,
): Promise<ActionableDetail | null> {
  return prisma.$transaction(async (transaction) => {
    const current = await findActionableRow(transaction, sourceOrdinal);
    if (!current) return null;
    if (current.version !== version)
      throw new VersionConflictError(toDetail(current));
    if (!archived && archiveState(current).inheritedFrom.length) {
      throw new DomainValidationError(
        "ARCHIVED_ANCESTOR",
        {
          archive: [
            `Restore the archived ${archiveState(current).inheritedFrom[0]} first.`,
          ],
        },
        "This actionable remains hidden by an archived scope.",
      );
    }
    const updated = await transaction.actionable.updateMany({
      where: { id: current.id, version },
      data: {
        archivedAt: archived ? new Date() : null,
        updatedLabel: "just now",
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new VersionConflictError(toDetail(current));
    await transaction.activityEvent.create({
      data: {
        actionableId: current.id,
        type: archived ? "archived" : "restored",
        summary: archived ? "Archived actionable" : "Restored actionable",
        metadataJson: inputJson({
          origin: "user",
          workflowStatus: current.status,
        }),
      },
    });
    const saved = await findActionableRow(transaction, sourceOrdinal);
    return saved ? toDetail(saved) : null;
  });
}

export async function setScopeArchived(
  prisma: AppPrismaClient,
  kind: Exclude<ArchiveTargetKind, "actionable">,
  id: string,
  version: number,
  archived: boolean,
): Promise<ScopeOptionsResponse | null> {
  return prisma.$transaction(async (transaction) => {
    const current = await scopeTarget(transaction, kind, id);
    if (!current) return null;
    if (current.version !== version)
      throw new ScopeVersionConflictError(current.version);
    if (!archived) {
      if (kind === "repository") {
        const repository = await transaction.repository.findUnique({
          where: { id },
          include: { project: true },
        });
        if (repository?.project.archivedAt) {
          throw new DomainValidationError(
            "ARCHIVED_ANCESTOR",
            { archive: ["Restore the project first."] },
            "This repository remains hidden by an archived project.",
          );
        }
      }
      if (kind === "worktree") {
        const worktree = await transaction.worktree.findUnique({
          where: { id },
          include: { project: true, repository: true },
        });
        if (worktree?.project.archivedAt || worktree?.repository.archivedAt) {
          throw new DomainValidationError(
            "ARCHIVED_ANCESTOR",
            { archive: ["Restore the archived project or repository first."] },
            "This worktree remains hidden by an archived ancestor.",
          );
        }
      }
    }
    const data = {
      archivedAt: archived ? new Date() : null,
      version: { increment: 1 },
    };
    const result =
      kind === "project"
        ? await transaction.project.updateMany({ where: { id, version }, data })
        : kind === "repository"
          ? await transaction.repository.updateMany({
              where: { id, version },
              data,
            })
          : await transaction.worktree.updateMany({
              where: { id, version },
              data,
            });
    if (result.count !== 1)
      throw new ScopeVersionConflictError(current.version);
    const affected = await transaction.actionable.findMany({
      where: scopeWhere(kind, id),
      select: { id: true, status: true },
    });
    if (affected.length) {
      await transaction.activityEvent.createMany({
        data: affected.map((item) => ({
          actionableId: item.id,
          type: archived ? "scope-archived" : "scope-restored",
          summary: archived
            ? `Hidden by archived ${kind}: ${current.name}`
            : `Visible after ${kind} restore: ${current.name}`,
          metadataJson: inputJson({
            scopeKind: kind,
            scopeId: id,
            workflowStatus: item.status,
          }),
        })),
      });
    }
    return listScopeOptions(transaction as unknown as AppPrismaClient);
  });
}

function sourceSignature(source: UserSourceReferenceInput) {
  return JSON.stringify([
    source.type,
    source.locator.trim(),
    source.label?.trim() ?? "",
  ]);
}

async function syncUserSources(
  transaction: TransactionClient,
  current: ActionableRow,
  requested: UserSourceReferenceInput[],
  provenance: UserSourceReference["provenance"],
) {
  const remaining = [...current.userSources];
  const added: UserSourceReferenceInput[] = [];

  for (const source of requested) {
    const match = remaining.findIndex(
      (candidate) =>
        sourceSignature(candidate as UserSourceReferenceInput) ===
        sourceSignature(source),
    );
    if (match >= 0) remaining.splice(match, 1);
    else added.push(source);
  }

  for (const source of remaining) {
    await transaction.userSourceReference.update({
      where: { id: source.id },
      data: { removedAt: new Date() },
    });
    await transaction.activityEvent.create({
      data: {
        actionableId: current.id,
        type: "source-removed",
        summary: "Removed a user-added source reference",
        metadataJson: inputJson({
          sourceType: source.type,
          label: source.label ?? source.locator,
        }),
      },
    });
  }

  for (const source of added) {
    await transaction.userSourceReference.create({
      data: {
        actionableId: current.id,
        type: source.type,
        locator: source.locator,
        label: source.label || null,
        provenance,
      },
    });
    await transaction.activityEvent.create({
      data: {
        actionableId: current.id,
        type: "source-added",
        summary: "Added a user source reference",
        metadataJson: inputJson({
          sourceType: source.type,
          label: source.label || source.locator,
        }),
      },
    });
  }
}

export async function createActionable(
  prisma: AppPrismaClient,
  input: CreateActionableRequest,
  options: {
    externalKey?: string;
    origin?: string;
    rawFragment?: Prisma.InputJsonValue;
    statusProvenance?: string;
  } = {},
  existingTransaction?: TransactionClient,
): Promise<ActionableDetail> {
  const operation = async (transaction: TransactionClient) => {
    await validateScope(transaction, input);
    const highest = await transaction.actionable.aggregate({
      _max: { sourceOrdinal: true },
    });
    const sourceOrdinal = (highest._max.sourceOrdinal ?? 0) + 1;
    const created = await transaction.actionable.create({
      data: {
        externalKey: options.externalKey ?? `manual-${randomUUID()}`,
        sourceOrdinal,
        title: input.title,
        priority: input.priority,
        status: "Inbox",
        statusProvenance:
          options.statusProvenance ??
          "Created manually with neutral Inbox status.",
        sourceStatusSuggestion: null,
        effort: input.effort,
        evidenceState: input.evidenceState,
        updatedLabel: "just now",
        finding: input.finding,
        description: input.description,
        resolution: input.resolution ?? "",
        researchJson: inputJson(input.research),
        validationJson: inputJson(input.validation),
        filesJson: inputJson([]),
        tagsJson: inputJson(input.tags),
        userSourcesJson: inputJson(input.userSources),
        blockedByOrdinalsJson: inputJson([]),
        blocksOrdinalsJson: inputJson([]),
        childOrdinalsJson: inputJson([]),
        importProvider: "MANUAL",
        sourceContainerId: "",
        sourceThread: "",
        contentHash: "",
        rawFragmentJson: options.rawFragment ?? inputJson({ kind: "manual" }),
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        worktreeId: input.worktreeId,
        statusHistory: {
          create: {
            previousStatus: null,
            newStatus: "Inbox",
            origin: options.origin ?? "manual-create",
          },
        },
        activityEvents: {
          create: {
            type: "status-transition",
            summary: "Created as Inbox",
            metadataJson: inputJson({
              previousStatus: "",
              newStatus: "Inbox",
              origin: options.origin ?? "manual-create",
            }),
          },
        },
        userSources: {
          create: input.userSources.map((source) => ({
            type: source.type,
            locator: source.locator,
            label: source.label || null,
            provenance: "user-added",
          })),
        },
      },
    });

    for (const source of input.userSources) {
      await transaction.activityEvent.create({
        data: {
          actionableId: created.id,
          type: "source-added",
          summary: "Added a user source reference",
          metadataJson: inputJson({
            sourceType: source.type,
            label: source.label || source.locator,
          }),
        },
      });
    }

    const row = await findActionableRow(transaction, sourceOrdinal);
    if (!row) throw new Error("Created actionable could not be read.");
    return toDetail(row);
  };
  return existingTransaction
    ? operation(existingTransaction)
    : prisma.$transaction(operation);
}

type TransitionDecision = {
  reason: string;
  completionMode: "none" | "validated" | "override";
  validationRecordId: string | null;
};

function requiredReason(
  value: string | undefined,
  field: "reason" | "completionOverrideReason",
  message: string,
  meaningful = false,
) {
  const reason = value?.trim() ?? "";
  const isMeaningful = reason.length >= 3 && /[\p{L}\p{N}]/u.test(reason);
  if (!reason || (meaningful && !isMeaningful)) {
    throw new DomainValidationError(
      "REASON_REQUIRED",
      { [field]: [message] },
      message,
    );
  }
  return reason;
}

function validateTransition(
  current: ActionableRow,
  nextStatus: Status,
  readiness: {
    finding: string;
    description: string;
    resolution: string;
    research: string[];
    validation: string[];
  },
  request: Pick<StatusTransitionRequest, "reason" | "completionOverrideReason">,
): TransitionDecision {
  const previousStatus = parsePersistedStatus(current.status);
  const readyState = lifecycleReadiness(previousStatus, {
    finding: readiness.finding,
    description: readiness.description,
    research: readiness.research,
    plannedValidation: readiness.validation,
  });
  if (
    nextStatus === "Ready" &&
    readyState.requiredForReady.includes("researchPhase")
  ) {
    throw new DomainValidationError(
      "RESEARCH_PHASE_REQUIRED",
      {
        status: [
          "Move this actionable to Researching before attempting Ready.",
        ],
      },
      "The research phase must begin before this actionable can be ready.",
    );
  }
  if (!canTransition(previousStatus, nextStatus)) {
    throw new DomainValidationError(
      "INVALID_STATUS_TRANSITION",
      {
        status: [
          `${previousStatus} cannot move to ${nextStatus}. ${transitionExplanation(previousStatus)}`,
        ],
      },
      "The requested status transition is not permitted.",
    );
  }

  const requiresReadyContent =
    (nextStatus === "Ready" &&
      previousStatus !== "Done" &&
      previousStatus !== "Dismissed") ||
    (previousStatus === "Ready" && nextStatus === "In progress");
  if (requiresReadyContent && readyState.requiredForReady.length > 0) {
    const errors: Record<string, string[]> = {};
    for (const blocker of readyState.blockers) {
      if (blocker.field === "researchPhase") continue;
      const field =
        blocker.field === "plannedValidation" ? "validation" : blocker.field;
      errors[field] = [blocker.message];
    }
    errors.status = [
      `${nextStatus} requires Ready prerequisites: ${readyState.requiredForReady.join(", ")}.`,
    ];
    throw new DomainValidationError(
      "READY_REQUIREMENTS_NOT_MET",
      errors,
      "This actionable is not ready for implementation yet.",
    );
  }

  let reason = "";
  if (nextStatus === "Blocked") {
    reason = requiredReason(
      request.reason,
      "reason",
      "Enter a meaningful blocker note before marking this actionable Blocked.",
      true,
    );
  } else if (nextStatus === "Dismissed") {
    reason = requiredReason(
      request.reason,
      "reason",
      "Enter a dismissal reason. Dismissal is not completion.",
    );
  } else if (
    nextStatus === "Ready" &&
    (previousStatus === "Done" || previousStatus === "Dismissed")
  ) {
    reason = requiredReason(
      request.reason,
      "reason",
      `Enter a reason for reopening this ${previousStatus} actionable.`,
    );
  } else if (previousStatus === "In progress" && nextStatus === "Researching") {
    reason = requiredReason(
      request.reason,
      "reason",
      "Explain why implementation is returning to Researching.",
      true,
    );
  }

  if (nextStatus !== "Done") {
    return { reason, completionMode: "none", validationRecordId: null };
  }

  const incompleteChildren = current.hierarchyAsParent
    .map((relationship) => relationship.child)
    .filter((child) => child.status !== "Done" && child.status !== "Dismissed");
  if (incompleteChildren.length > 0) {
    throw new DomainValidationError(
      "INCOMPLETE_SUBTASKS",
      {
        status: ["A parent cannot be Done while it has nonterminal subtasks."],
        children: incompleteChildren.map(
          (child) => `${child.sourceOrdinal}: ${child.title} (${child.status})`,
        ),
      },
      "Complete or dismiss every direct subtask before completing this parent.",
    );
  }

  if (!readiness.resolution.trim()) {
    throw new DomainValidationError(
      "RESOLUTION_REQUIRED",
      {
        resolution: [
          "Describe the completed changes and important implementation decisions before marking this actionable Done.",
        ],
        status: ["Done requires Resolution content."],
      },
      "Add a Resolution before completing this actionable.",
    );
  }

  const override = request.completionOverrideReason?.trim() ?? "";
  if (override) {
    return {
      reason: requiredReason(
        override,
        "completionOverrideReason",
        "Enter a completion override reason.",
      ),
      completionMode: "override",
      validationRecordId: null,
    };
  }

  const validationRecordId = latestQualifyingValidationId(current);
  if (!validationRecordId) {
    throw new DomainValidationError(
      "VALIDATION_REQUIRED",
      {
        status: [
          "Done requires a current Passed validation or a completion override.",
        ],
        completionOverrideReason: [
          "Record a Passed validation or provide a nonempty override reason.",
        ],
      },
      "Qualifying validation is required before completion.",
    );
  }
  return { reason: "", completionMode: "validated", validationRecordId };
}

async function writeTransitionHistory(
  transaction: TransactionClient,
  current: ActionableRow,
  nextStatus: Status,
  origin: string,
  decision: TransitionDecision,
  extraContext: Record<string, string> = {},
) {
  const previousStatus = parsePersistedStatus(current.status);
  await transaction.actionableStatusHistory.create({
    data: {
      actionableId: current.id,
      previousStatus,
      newStatus: nextStatus,
      origin,
    },
  });

  let type = "status-transition";
  let summary = `${previousStatus} → ${nextStatus}`;
  const context: Record<string, string> = {
    previousStatus,
    newStatus: nextStatus,
    origin,
    ...extraContext,
  };

  if (nextStatus === "Blocked") {
    type = "manual-blocked";
    summary = "Marked Blocked — manual";
    context.reason = decision.reason;
  } else if (nextStatus === "Dismissed") {
    type = "dismissed";
    summary = "Dismissed — not completed";
    context.reason = decision.reason;
  } else if (
    nextStatus === "Ready" &&
    (previousStatus === "Done" || previousStatus === "Dismissed")
  ) {
    type = "reopened";
    summary = `Reopened ${previousStatus} to Ready`;
    context.reason = decision.reason;
  } else if (previousStatus === "In progress" && nextStatus === "Researching") {
    type = "research-reopened";
    summary = "Returned implementation to Researching";
    context.reason = decision.reason;
  } else if (decision.completionMode === "validated") {
    type = "completion-validated";
    summary = "Completed with qualifying validation";
    context.validationRecordId = decision.validationRecordId ?? "";
  } else if (decision.completionMode === "override") {
    type = "completion-overridden";
    summary = "Completion override used — not validated";
    context.reason = decision.reason;
  } else if (previousStatus === "Blocked") {
    context.clearedManualBlocker = "true";
  }

  await transaction.activityEvent.create({
    data: {
      actionableId: current.id,
      type,
      summary,
      metadataJson: inputJson(context),
    },
  });
}

async function currentOrNotFound(
  transaction: TransactionClient,
  sourceOrdinal: number,
) {
  return findActionableRow(transaction, sourceOrdinal);
}

export async function updateActionable(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: UpdateActionableRequest,
  existingTransaction?: TransactionClient,
  sourceProvenance: UserSourceReference["provenance"] = "user-added",
): Promise<ActionableDetail | null> {
  const operation = async (transaction: TransactionClient) => {
    const current = await currentOrNotFound(transaction, sourceOrdinal);
    if (!current) return null;
    if (current.version !== input.version)
      throw new VersionConflictError(toDetail(current));

    await validateScope(transaction, input);
    const previousStatus = parsePersistedStatus(current.status);
    const decision =
      input.status === previousStatus
        ? null
        : validateTransition(
            current,
            input.status,
            {
              finding: input.finding,
              description: input.description,
              resolution: input.resolution ?? current.resolution,
              research: input.research,
              validation: input.validation,
            },
            {},
          );

    const updated = await transaction.actionable.updateMany({
      where: { id: current.id, version: input.version },
      data: {
        title: input.title,
        priority: input.priority,
        status: input.status,
        effort: input.effort,
        evidenceState: input.evidenceState,
        updatedLabel: "just now",
        finding: input.finding,
        description: input.description,
        resolution: input.resolution ?? current.resolution,
        researchJson: inputJson(input.research),
        validationJson: inputJson(input.validation),
        tagsJson: inputJson(input.tags),
        userSourcesJson: inputJson(input.userSources),
        projectId: input.projectId,
        repositoryId: input.repositoryId,
        worktreeId: input.worktreeId,
        manualBlockerMd:
          previousStatus === "Blocked" && input.status !== "Blocked"
            ? null
            : current.manualBlockerMd,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      const latest = await currentOrNotFound(transaction, sourceOrdinal);
      if (!latest) return null;
      throw new VersionConflictError(toDetail(latest));
    }

    await syncUserSources(
      transaction,
      current,
      input.userSources,
      sourceProvenance,
    );
    if (decision) {
      await writeTransitionHistory(
        transaction,
        current,
        input.status,
        "user-edit",
        decision,
      );
    }

    const saved = await currentOrNotFound(transaction, sourceOrdinal);
    return saved ? toDetail(saved) : null;
  };
  return existingTransaction
    ? operation(existingTransaction)
    : prisma.$transaction(operation);
}

export async function transitionActionable(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: Omit<StatusTransitionRequest, "origin"> & { origin: string },
  existingTransaction?: TransactionClient,
): Promise<ActionableDetail | null> {
  const operation = async (transaction: TransactionClient) => {
    const current = await currentOrNotFound(transaction, sourceOrdinal);
    if (!current) return null;
    if (current.version !== input.version)
      throw new VersionConflictError(toDetail(current));

    const previousStatus = parsePersistedStatus(current.status);
    const parentRelationship =
      input.status === "Ready" &&
      (previousStatus === "Done" || previousStatus === "Dismissed") &&
      current.hierarchyAsChild[0]?.parent.status === "Done"
        ? current.hierarchyAsChild[0]
        : null;
    const decision = validateTransition(
      current,
      input.status,
      {
        finding: current.finding,
        description: current.description,
        resolution: current.resolution,
        research: stringArray(current.researchJson),
        validation: stringArray(current.validationJson),
      },
      input,
    );
    const updated = await transaction.actionable.updateMany({
      where: { id: current.id, version: input.version },
      data: {
        status: input.status,
        updatedLabel: "just now",
        manualBlockerMd:
          input.status === "Blocked"
            ? decision.reason
            : previousStatus === "Blocked"
              ? null
              : current.manualBlockerMd,
        dismissalReasonMd:
          input.status === "Dismissed"
            ? decision.reason
            : current.dismissalReasonMd,
        completionOverrideMd:
          input.status === "Done"
            ? decision.completionMode === "override"
              ? decision.reason
              : null
            : current.completionOverrideMd,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      const latest = await currentOrNotFound(transaction, sourceOrdinal);
      if (!latest) return null;
      throw new VersionConflictError(toDetail(latest));
    }

    await writeTransitionHistory(
      transaction,
      current,
      input.status,
      input.origin,
      decision,
      parentRelationship
        ? {
            hierarchyRelationshipId: parentRelationship.id,
            autoReopenedParentId: parentRelationship.parent.id,
          }
        : {},
    );

    if (parentRelationship) {
      const parent = parentRelationship.parent;
      const parentUpdated = await transaction.actionable.updateMany({
        where: { id: parent.id, version: parent.version, status: "Done" },
        data: {
          status: "Ready",
          updatedLabel: "just now",
          version: { increment: 1 },
        },
      });
      if (parentUpdated.count !== 1) {
        const latestParent = await currentOrNotFound(
          transaction,
          parent.sourceOrdinal,
        );
        if (!latestParent) {
          throw new DomainValidationError(
            "PARENT_NOT_FOUND",
            { parent: ["The parent actionable no longer exists."] },
            "The parent actionable could not be reopened.",
          );
        }
        throw new VersionConflictError(toDetail(latestParent));
      }
      await transaction.actionableStatusHistory.create({
        data: {
          actionableId: parent.id,
          previousStatus: "Done",
          newStatus: "Ready",
          origin: "child-reopen",
        },
      });
      await transaction.activityEvent.create({
        data: {
          actionableId: parent.id,
          type: "parent-auto-reopened",
          summary: "Automatically reopened because a subtask reopened",
          metadataJson: inputJson({
            hierarchyRelationshipId: parentRelationship.id,
            childActionableId: current.id,
            childOrdinal: String(current.sourceOrdinal),
            reason: decision.reason,
            origin: "child-reopen",
          }),
        },
      });
    }
    const saved = await currentOrNotFound(transaction, sourceOrdinal);
    return saved ? toDetail(saved) : null;
  };
  return existingTransaction
    ? operation(existingTransaction)
    : prisma.$transaction(operation);
}

type RecordValidationResult = {
  task: ActionableDetail | null;
  validationRecordId: string | null;
};

async function recordValidationResult(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: Omit<CreateValidationRecordRequest, "origin"> & { origin: string },
  existingTransaction?: TransactionClient,
): Promise<RecordValidationResult> {
  const operation = async (transaction: TransactionClient) => {
    const current = await currentOrNotFound(transaction, sourceOrdinal);
    if (!current) return { task: null, validationRecordId: null };
    if (current.version !== input.version)
      throw new VersionConflictError(toDetail(current));
    if (!input.notes.trim() && !input.evidence.trim()) {
      throw new DomainValidationError(
        "VALIDATION_EVIDENCE_REQUIRED",
        {
          notes: ["Add validation notes or evidence."],
          evidence: ["Add validation notes or evidence."],
        },
        "Validation evidence is required.",
      );
    }

    let superseded = null;
    if (input.supersedesId) {
      superseded = current.validationRecords.find(
        (record) => record.id === input.supersedesId,
      );
      if (!superseded) {
        throw new DomainValidationError(
          "INVALID_SUPERSESSION",
          {
            supersedesId: ["Choose a validation record from this actionable."],
          },
          "The validation correction target is invalid.",
        );
      }
      if (
        current.validationRecords.some(
          (record) => record.supersedesId === input.supersedesId,
        )
      ) {
        throw new DomainValidationError(
          "ALREADY_SUPERSEDED",
          {
            supersedesId: [
              "Correct the latest record in the supersession chain.",
            ],
          },
          "That validation record has already been superseded.",
        );
      }
    }

    const updated = await transaction.actionable.updateMany({
      where: { id: current.id, version: input.version },
      data: { updatedLabel: "just now", version: { increment: 1 } },
    });
    if (updated.count !== 1) {
      const latest = await currentOrNotFound(transaction, sourceOrdinal);
      if (!latest) return { task: null, validationRecordId: null };
      throw new VersionConflictError(toDetail(latest));
    }

    const record = await transaction.validationRecord.create({
      data: {
        actionableId: current.id,
        type: input.type,
        outcome: input.outcome,
        notesMd: input.notes,
        evidenceMd: input.evidence,
        origin: input.origin,
        supersedesId: input.supersedesId ?? null,
      },
    });
    await transaction.activityEvent.create({
      data: {
        actionableId: current.id,
        type: superseded ? "validation-corrected" : "validation-recorded",
        summary: superseded
          ? `Corrected validation result: ${input.outcome}`
          : `Recorded validation result: ${input.outcome}`,
        metadataJson: inputJson({
          validationRecordId: record.id,
          supersedesId: input.supersedesId ?? "",
          validationType: input.type,
          outcome: input.outcome,
          origin: input.origin,
        }),
      },
    });

    const saved = await currentOrNotFound(transaction, sourceOrdinal);
    return {
      task: saved ? toDetail(saved) : null,
      validationRecordId: record.id,
    };
  };
  return existingTransaction
    ? operation(existingTransaction)
    : prisma.$transaction(operation);
}

export async function recordValidation(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: Omit<CreateValidationRecordRequest, "origin"> & { origin: string },
  existingTransaction?: TransactionClient,
): Promise<ActionableDetail | null> {
  return (
    await recordValidationResult(
      prisma,
      sourceOrdinal,
      input,
      existingTransaction,
    )
  ).task;
}

export function recordValidationWithRecord(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: Omit<CreateValidationRecordRequest, "origin"> & { origin: string },
  existingTransaction?: TransactionClient,
): Promise<RecordValidationResult> {
  return recordValidationResult(
    prisma,
    sourceOrdinal,
    input,
    existingTransaction,
  );
}
