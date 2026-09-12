import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import {
  actionablesErrorPayload,
  agentTaskSummaryChildIdsLimit,
  agentTaskSummarySchema,
  bulkAgentTaskFailureSchema,
  bulkCreateAgentTaskSuccessSchema,
  bulkCreateAgentTasksRequestSchema,
  bulkCreateAgentTasksResponseSchema,
  bulkPreparedAgentTaskReceiptSchema,
  bulkPrepareAgentTaskSuccessSchema,
  bulkPrepareAgentTasksRequestSchema,
  bulkPrepareAgentTasksResponseSchema,
  claimAgentTaskRequestSchema,
  claimAgentTaskResponseSchema,
  createAgentTaskRequestSchema,
  dismissAgentTaskRequestSchema,
  handoffClaimedAgentTaskRequestSchema,
  listAgentTasksRequestSchema,
  listAgentTasksResponseSchema,
  recoverAgentTaskClaimRequestSchema,
  recoverAgentTaskClaimResponseSchema,
  recordClaimedAgentTaskValidationRequestSchema,
  releaseAgentTaskClaimRequestSchema,
  releaseAgentTaskClaimResponseSchema,
  forceReleaseAgentClaimRequestSchema,
  renewAgentTaskClaimRequestSchema,
  renewAgentTaskClaimResponseSchema,
  sourceFileSchema,
  transitionClaimedAgentTaskRequestSchema,
  updateActionableRequestSchema,
  updateClaimedAgentTaskRequestSchema,
  type ActionableDetail,
  type AgentTaskSummary,
  type BulkAgentTaskItemResult,
  type BulkCreateAgentTasksRequest,
  type BulkCreateAgentTasksResponse,
  type BulkPreparedAgentTaskReceipt,
  type BulkPrepareAgentTaskItem,
  type BulkPrepareAgentTasksRequest,
  type BulkPrepareAgentTasksResponse,
  type ClaimAgentTaskRequest,
  type ClaimAgentTaskResponse,
  type CreateAgentTaskRequest,
  type DismissAgentTaskRequest,
  type HandoffClaimedAgentTaskRequest,
  type ListAgentTasksRequest,
  type ListAgentTasksResponse,
  type RecoverAgentTaskClaimRequest,
  type RecoverAgentTaskClaimResponse,
  type RecordClaimedAgentTaskValidationRequest,
  type ReleaseAgentTaskClaimRequest,
  type ReleaseAgentTaskClaimResponse,
  type ForceReleaseAgentClaimRequest,
  type RenewAgentTaskClaimRequest,
  type RenewAgentTaskClaimResponse,
  type SourceFile,
  type TransitionClaimedAgentTaskRequest,
  type UpdateClaimedAgentTaskRequest,
} from "@actionables/contracts";
import type { AppPrismaClient } from "./database.js";
import type { Prisma } from "./generated/prisma/client.js";
import {
  lifecycleReadiness,
  parsePersistedStatus,
} from "./actionable-transitions.js";
import { getAgentCoordinationSettings } from "./helper-agent-settings.js";
import { isWithinCheckout, projectWorkspacePath } from "./project-workspace.js";
import {
  createActionable,
  DomainValidationError,
  getActionable,
  normalizedLocalPath,
  recordValidationWithRecord,
  transitionActionable,
  updateActionable,
  VersionConflictError,
} from "./repository.js";
import { createSubtask } from "./relationships.js";

const execFileAsync = promisify(execFile);
const terminalStatuses = ["Done", "Dismissed"];
const claimLocks = new Map<string, Promise<void>>();
const agentTaskInclude = {
  project: true,
  repository: true,
  worktree: true,
  agentTaskClaim: true,
  _count: {
    select: {
      hierarchyAsParent: { where: { detachedAt: null } },
    },
  },
  hierarchyAsParent: {
    where: { detachedAt: null },
    orderBy: { child: { sourceOrdinal: "asc" } },
    take: agentTaskSummaryChildIdsLimit,
    include: {
      child: {
        select: { sourceOrdinal: true },
      },
    },
  },
  hierarchyAsChild: {
    where: { detachedAt: null },
    include: {
      parent: {
        select: {
          sourceOrdinal: true,
          status: true,
          archivedAt: true,
        },
      },
    },
  },
  dependenciesAsDependent: {
    where: { removedAt: null },
    include: {
      prerequisite: {
        select: { status: true },
      },
    },
  },
} satisfies Prisma.ActionableInclude;

type AgentTaskRow = Prisma.ActionableGetPayload<{
  include: typeof agentTaskInclude;
}>;
const agentTaskMutationInclude = {
  ...agentTaskInclude,
  userSources: {
    where: { removedAt: null },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.ActionableInclude;
type AgentTaskMutationRow = Prisma.ActionableGetPayload<{
  include: typeof agentTaskMutationInclude;
}>;
type TransactionClient = Prisma.TransactionClient;
export type UpdateClaimedAgentTaskResult = {
  task: ActionableDetail;
  changedFields: string[];
  counts: AgentTaskMutationCount[];
};
export type AgentTaskMutationCount = {
  field: string;
  persisted: number;
  duplicatesIgnored: number;
};
export type HandoffClaimedAgentTaskResult = UpdateClaimedAgentTaskResult & {
  validation?: {
    id: string;
    qualifiesForCompletion: boolean;
  };
};
export type RecordClaimedAgentTaskValidationResult = {
  task: ActionableDetail;
  validation: {
    id: string;
    qualifiesForCompletion: boolean;
  };
  counts: [
    {
      field: "validationRecords";
      persisted: 1;
      duplicatesIgnored: number;
    },
  ];
};

export class AgentTaskClaimError extends Error {
  constructor(
    public readonly code:
      | "INVALID_REQUEST"
      | "NOT_FOUND"
      | "ARCHIVED"
      | "TERMINAL"
      | "TERMINAL_READ_INVALIDATED"
      | "VERSION_CONFLICT"
      | "ALREADY_CLAIMED"
      | "OWN_CLAIM_ACTIVE"
      | "CLAIM_OWNER_MISMATCH"
      | "CLAIM_NOT_FOUND"
      | "INVALID_CLAIM_TOKEN"
      | "CLAIM_EXPIRED"
      | "IDEMPOTENCY_CONFLICT"
      | "THREAD_ID_REQUIRED"
      | "CREATOR_THREAD_MISMATCH",
    message: string,
    public readonly fieldErrors?: Record<string, string[]>,
    public readonly currentVersion?: number,
    public readonly retryAt?: string,
  ) {
    super(message);
  }
}

export class AgentClaimReleaseConflictError extends Error {
  constructor(
    public readonly code: "CLAIM_CHANGED" | "CLAIM_NOT_FOUND",
    public readonly current: ActionableDetail,
  ) {
    super(
      code === "CLAIM_CHANGED"
        ? "This agent claim changed after it was displayed."
        : "This agent claim no longer exists.",
    );
  }
}

function parseInput<T>(
  schema: {
    safeParse: (value: unknown) =>
      | { success: true; data: T }
      | {
          success: false;
          error: {
            flatten: () => {
              fieldErrors: Record<string, string[] | undefined>;
            };
          };
        };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fieldErrors = Object.fromEntries(
    Object.entries(result.error.flatten().fieldErrors)
      .filter((entry): entry is [string, string[]] => Boolean(entry[1]?.length))
      .map(([field, messages]) => [field, messages]),
  );
  throw new AgentTaskClaimError(
    "INVALID_REQUEST",
    "The agent task request is invalid.",
    fieldErrors,
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(token: string, expectedHash: string) {
  const candidate = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

function leaseExpiry(now: Date, leaseMinutes: number) {
  return new Date(now.getTime() + leaseMinutes * 60_000);
}

async function withClaimLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = claimLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  claimLocks.set(key, current);
  await prior;
  try {
    return await operation();
  } finally {
    release();
    if (claimLocks.get(key) === current) claimLocks.delete(key);
  }
}

function isArchived(row: AgentTaskRow) {
  return Boolean(
    row.archivedAt ||
    row.project.archivedAt ||
    row.repository.archivedAt ||
    row.worktree.archivedAt,
  );
}

function toAgentTaskSummary(row: AgentTaskRow): AgentTaskSummary {
  const parentId = row.hierarchyAsChild[0]?.parent.sourceOrdinal ?? null;
  const unresolvedDependencyCount = row.dependenciesAsDependent.filter(
    (relationship) =>
      relationship.waivedAt === null &&
      relationship.prerequisite.status !== "Done",
  ).length;
  const readiness = lifecycleReadiness(parsePersistedStatus(row.status), {
    finding: row.finding,
    description: row.description,
    research: persistedStringArray(row.researchJson),
    plannedValidation: persistedStringArray(row.validationJson),
  });
  return agentTaskSummarySchema.parse({
    id: row.sourceOrdinal,
    recordId: row.id,
    workItemId: parentId ?? row.sourceOrdinal,
    parentId,
    childIds: row.hierarchyAsParent.map(
      (relationship) => relationship.child.sourceOrdinal,
    ),
    childCount: row._count.hierarchyAsParent,
    title: row.title,
    findingExcerpt: truncateExcerpt(row.finding, 300),
    tags: persistedStringArray(row.tagsJson).slice(0, 10),
    priority: row.priority,
    status: row.status,
    effort: row.effort,
    evidenceState: row.evidenceState,
    isEffectivelyBlocked:
      row.status === "Blocked" || unresolvedDependencyCount > 0,
    unresolvedDependencyCount,
    version: row.version,
    scope: {
      projectId: row.project.id,
      projectName: row.project.name,
      repositoryId: row.repository.id,
      repositoryName: row.repository.name,
      worktreeId: row.worktree.id,
      worktreeName: row.worktree.name,
    },
    updatedAt: row.updatedAt.toISOString(),
    readiness,
    claim: row.agentTaskClaim
      ? {
          agentId: row.agentTaskClaim.agentId,
          claimedAt: row.agentTaskClaim.claimedAt.toISOString(),
          renewedAt: row.agentTaskClaim.renewedAt.toISOString(),
          leaseExpiresAt: row.agentTaskClaim.leaseExpiresAt.toISOString(),
        }
      : null,
  });
}

function truncateExcerpt(value: string, max: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max - 1)}…`;
}

async function findTask(
  prisma: AppPrismaClient | TransactionClient,
  sourceOrdinal: number,
) {
  return prisma.actionable.findUnique({
    where: { sourceOrdinal },
    include: agentTaskInclude,
  });
}

async function findMutationTask(
  prisma: AppPrismaClient | TransactionClient,
  sourceOrdinal: number,
) {
  return prisma.actionable.findUnique({
    where: { sourceOrdinal },
    include: agentTaskMutationInclude,
  });
}

async function requireWorkItem(
  prisma: AppPrismaClient | TransactionClient,
  sourceOrdinal: number,
  options: { allowTerminal?: boolean } = {},
) {
  const row = await findTask(prisma, sourceOrdinal);
  if (!row) {
    throw new AgentTaskClaimError(
      "NOT_FOUND",
      "The feature or bug work item was not found.",
    );
  }
  if (row.hierarchyAsChild.length > 0) {
    throw new AgentTaskClaimError(
      "INVALID_REQUEST",
      "workItemId must identify a top-level Actionable, not one of its subtasks.",
      {
        workItemId: [
          `Use top-level Actionable ${row.hierarchyAsChild[0]!.parent.sourceOrdinal}.`,
        ],
      },
    );
  }
  if (isArchived(row)) {
    throw new AgentTaskClaimError(
      "ARCHIVED",
      "The feature or bug work item is archived.",
    );
  }
  if (!options.allowTerminal && terminalStatuses.includes(row.status)) {
    throw new AgentTaskClaimError(
      "TERMINAL",
      "The feature or bug work item is terminal.",
    );
  }
  return row;
}

function requireTaskInWorkItem(row: AgentTaskRow, workItem: AgentTaskRow) {
  const belongsToWorkItem =
    row.id === workItem.id ||
    row.hierarchyAsChild.some(
      (relationship) => relationship.parentId === workItem.id,
    );
  if (!belongsToWorkItem) {
    throw new AgentTaskClaimError(
      "INVALID_REQUEST",
      "The Actionable does not belong to the requested feature or bug work item.",
      {
        id: [
          `Choose the root or a direct subtask of Actionable ${workItem.sourceOrdinal}.`,
        ],
      },
    );
  }
}

function requireClaimable(
  row: AgentTaskRow | null,
): asserts row is AgentTaskRow {
  if (!row) {
    throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
  }
  if (isArchived(row)) {
    throw new AgentTaskClaimError(
      "ARCHIVED",
      "Archived Actionables cannot be claimed.",
    );
  }
  if (terminalStatuses.includes(row.status)) {
    throw new AgentTaskClaimError(
      "TERMINAL",
      "Terminal Actionables cannot be claimed.",
    );
  }
}

function requireValidClaim(
  row: AgentTaskRow | null,
  claimToken: string,
  now: Date,
) {
  if (!row) {
    throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
  }
  const claim = row.agentTaskClaim;
  if (!claim) {
    throw new AgentTaskClaimError(
      "INVALID_CLAIM_TOKEN",
      "No active claim exists for this Actionable.",
    );
  }
  if (!tokenMatches(claimToken, claim.claimTokenHash)) {
    throw new AgentTaskClaimError(
      "INVALID_CLAIM_TOKEN",
      "The claim token is invalid.",
    );
  }
  if (claim.leaseExpiresAt <= now) return "expired" as const;
  return claim;
}

async function recordObservedExpiry(
  tx: TransactionClient,
  row: AgentTaskRow,
  now: Date,
) {
  const claim = row.agentTaskClaim;
  if (!claim || claim.leaseExpiresAt > now) return;
  await tx.agentTaskClaim.delete({ where: { actionableId: row.id } });
  await tx.activityEvent.create({
    data: {
      actionableId: row.id,
      type: "agent-claim-expired",
      summary: `Agent claim expired for ${claim.agentId}`,
      metadataJson: {
        agentId: claim.agentId,
        leaseExpiredAt: claim.leaseExpiresAt.toISOString(),
      },
      occurredAt: now,
    },
  });
}

type ClaimedMutationCredentials = {
  claimToken: string;
  version: number;
};

async function runClaimedMutation<T, U = T>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  credentials: ClaimedMutationCredentials,
  now: Date,
  operation: (
    tx: TransactionClient,
    row: AgentTaskMutationRow,
    claim: NonNullable<AgentTaskMutationRow["agentTaskClaim"]>,
  ) => Promise<T>,
  projectResponse?: (value: T) => U,
): Promise<T | U> {
  return withClaimLock(String(sourceOrdinal), async () => {
    const result = await prisma.$transaction(async (tx) => {
      const row = await findMutationTask(tx, sourceOrdinal);
      const claim = requireValidClaim(row, credentials.claimToken, now);
      if (claim === "expired") {
        await recordObservedExpiry(tx, row!, now);
        await tx.actionable.update({
          where: { id: row!.id },
          data: {
            version: { increment: 1 },
            updatedLabel: "agent claim expired",
          },
        });
        return { expired: true as const };
      }
      if (isArchived(row!)) {
        throw new AgentTaskClaimError(
          "ARCHIVED",
          "Archived Actionables cannot be changed by an agent.",
        );
      }
      if (terminalStatuses.includes(row!.status)) {
        throw new AgentTaskClaimError(
          "TERMINAL",
          "Terminal Actionables cannot be changed by an agent.",
        );
      }
      if (row!.version !== credentials.version) {
        throw new AgentTaskClaimError(
          "VERSION_CONFLICT",
          "This Actionable changed after it was fetched.",
          undefined,
          row!.version,
        );
      }
      const value = await operation(tx, row!, claim);
      return {
        expired: false as const,
        value: projectResponse ? projectResponse(value) : value,
      };
    });
    if (result.expired) {
      throw new AgentTaskClaimError(
        "CLAIM_EXPIRED",
        "The claim lease expired and must be reacquired.",
      );
    }
    return result.value;
  });
}

function agentOrigin(agentId: string) {
  return `agent:${agentId}`;
}

function persistedStringArray(value: Prisma.JsonValue) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function creatorThreadId(value: Prisma.JsonValue) {
  return value &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    "creatorThreadId" in value &&
    typeof value.creatorThreadId === "string"
    ? value.creatorThreadId
    : null;
}

function appendUniqueUserSources<
  T extends { type: string; locator: string; label?: string },
>(current: T[], additions: T[]) {
  const key = (source: T) =>
    JSON.stringify([source.type, source.locator, source.label ?? ""]);
  const seen = new Set(current.map(key));
  const appended = additions.filter((source) => {
    const sourceKey = key(source);
    if (seen.has(sourceKey)) return false;
    seen.add(sourceKey);
    return true;
  });
  return {
    values: [...current, ...appended],
    appended: appended.length,
    duplicatesIgnored: additions.length - appended.length,
  };
}

function appendUniqueStrings(current: string[], additions: string[]) {
  const seen = new Set(current);
  const appended = additions.filter((addition) => {
    if (seen.has(addition)) return false;
    seen.add(addition);
    return true;
  });
  return {
    values: [...current, ...appended],
    appended: appended.length,
    duplicatesIgnored: additions.length - appended.length,
  };
}

function persistedSourceFiles(value: Prisma.JsonValue): SourceFile[] {
  const parsed = sourceFileSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

function appendUniqueFiles(current: SourceFile[], additions: SourceFile[]) {
  const key = (file: SourceFile) =>
    JSON.stringify([file.path, file.lines ?? "", file.symbol ?? ""]);
  const seen = new Set(current.map(key));
  const appended = additions.filter((file) => {
    const fileKey = key(file);
    if (seen.has(fileKey)) return false;
    seen.add(fileKey);
    return true;
  });
  return {
    values: [...current, ...appended],
    appended: appended.length,
    duplicatesIgnored: additions.length - appended.length,
  };
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function renewClaimAfterMutation(
  tx: TransactionClient,
  row: AgentTaskMutationRow,
  now: Date,
) {
  const { agentClaimLeaseMinutes } = await getAgentCoordinationSettings(tx);
  await tx.agentTaskClaim.update({
    where: { actionableId: row.id },
    data: {
      leaseExpiresAt: leaseExpiry(now, agentClaimLeaseMinutes),
    },
  });
}

async function releaseClaimAfterTerminalTransition(
  tx: TransactionClient,
  row: AgentTaskMutationRow,
  agentId: string,
  status: "Done" | "Dismissed",
  now: Date,
) {
  await tx.agentTaskClaim.delete({ where: { actionableId: row.id } });
  await tx.activityEvent.create({
    data: {
      actionableId: row.id,
      type: "agent-released",
      summary: `Released agent claim after transition to ${status}`,
      metadataJson: {
        agentId,
        origin: agentOrigin(agentId),
        terminalStatus: status,
      },
      occurredAt: now,
    },
  });
}

export async function listAgentTasks(
  prisma: AppPrismaClient,
  input: ListAgentTasksRequest,
  now = new Date(),
): Promise<ListAgentTasksResponse> {
  const request = parseInput(listAgentTasksRequestSchema, input);
  const workItem =
    request.workItemId === undefined
      ? null
      : await requireWorkItem(prisma, request.workItemId, {
          allowTerminal: true,
        });
  const workItemState = workItem
    ? {
        id: workItem.sourceOrdinal,
        status: workItem.status,
        terminal: terminalStatuses.includes(workItem.status),
      }
    : null;
  if (workItemState?.terminal) {
    return listAgentTasksResponseSchema.parse({
      items: [],
      hasMore: false,
      workItem: workItemState,
    });
  }
  const baseWhere = {
    archivedAt: null,
    status: { notIn: terminalStatuses },
    project: { archivedAt: null },
    repository: { archivedAt: null },
    worktree: { archivedAt: null },
    ...(workItem
      ? {
          AND: [
            {
              OR: [
                { id: workItem.id },
                {
                  hierarchyAsChild: {
                    some: {
                      parentId: workItem.id,
                      detachedAt: null,
                    },
                  },
                },
              ],
            },
          ],
        }
      : {}),
  } satisfies Prisma.ActionableWhereInput;
  const where: Prisma.ActionableWhereInput =
    request.view === "mine"
      ? {
          ...baseWhere,
          agentTaskClaim: {
            is: {
              agentId: request.agentId,
              leaseExpiresAt: { gt: now },
            },
          },
        }
      : {
          ...baseWhere,
          status: { notIn: [...terminalStatuses, "Blocked"] },
          dependenciesAsDependent: {
            none: {
              removedAt: null,
              waivedAt: null,
              prerequisite: { status: { not: "Done" } },
            },
          },
          OR: [
            { agentTaskClaim: { is: null } },
            {
              agentTaskClaim: {
                is: { leaseExpiresAt: { lte: now } },
              },
            },
          ],
        };
  const rows = await prisma.actionable.findMany({
    where,
    include: agentTaskInclude,
    orderBy: [
      { priority: "asc" },
      { updatedAt: "desc" },
      { sourceOrdinal: "asc" },
    ],
    take: request.limit + 1,
  });
  const hasMore = rows.length > request.limit;
  return listAgentTasksResponseSchema.parse({
    items: rows.slice(0, request.limit).map((row) => {
      const summary = toAgentTaskSummary(row);
      if (
        request.view === "available" &&
        summary.claim &&
        new Date(summary.claim.leaseExpiresAt) <= now
      ) {
        return { ...summary, claim: null };
      }
      return summary;
    }),
    hasMore,
    workItem: workItemState,
  });
}

function agentTaskCreateFingerprint(request: CreateAgentTaskRequest) {
  return hashToken(
    JSON.stringify({
      parentId: request.parentId ?? null,
      workItemId: request.workItemId ?? null,
      projectId: request.projectId ?? null,
      repositoryId: request.repositoryId ?? null,
      worktreeId: request.worktreeId ?? null,
      repositoryPath: request.repositoryPath ?? null,
      ensureScope: request.ensureScope ?? null,
      title: request.title,
      priority: request.priority,
      description: request.description,
      effort: request.effort,
      plannedValidation: request.plannedValidation,
      ...(request.tags.length ? { tags: request.tags } : {}),
    }),
  );
}

export type AgentTaskScopeProvisioning = {
  ensured: true;
  repositoryPath: string;
  worktreePath: string;
  projectCreated: boolean;
  repositoryCreated: boolean;
  worktreeCreated: boolean;
};

export type CreateAgentTaskResult = {
  task: ActionableDetail;
  idempotentReplay: boolean;
  scopeProvisioning?: AgentTaskScopeProvisioning;
};

export type AgentTaskCaller = {
  threadId: string;
};

export type BulkAgentTaskFailureContext = {
  correlationId: string;
  onInternalError: (error: unknown) => void;
};

type ResolvedRepositoryPlacement = {
  requestedPath: string;
  repositoryPath: string;
  worktreePath: string;
  projectName: string;
  repositoryName: string;
  worktreeName: string;
};

function sameLocalPath(left: string | null, right: string) {
  return (
    left !== null &&
    normalizedLocalPath(left).toLowerCase() ===
      normalizedLocalPath(right).toLowerCase()
  );
}

async function sameResolvedLocalPath(left: string | null, right: string) {
  if (sameLocalPath(left, right)) return true;
  if (!left) return false;
  try {
    return sameLocalPath(await realpath(left), right);
  } catch {
    return false;
  }
}

function invalidRepositoryPath(message: string) {
  return new AgentTaskClaimError("INVALID_REQUEST", message, {
    repositoryPath: [
      "Provide an existing local path inside the Git repository or worktree.",
    ],
  });
}

async function gitPath(path: string, argument: string) {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", path, "rev-parse", "--path-format=absolute", argument],
      { encoding: "utf8", windowsHide: true },
    );
    return String(result.stdout).trim();
  } catch {
    throw invalidRepositoryPath(
      "repositoryPath is not inside an accessible Git repository.",
    );
  }
}

async function resolveRepositoryPlacement(
  requestedPath: string,
): Promise<ResolvedRepositoryPlacement> {
  let localPath: string;
  try {
    const details = await stat(requestedPath);
    if (!details.isDirectory()) {
      throw invalidRepositoryPath("repositoryPath must be a directory.");
    }
    localPath = await realpath(requestedPath);
  } catch (error) {
    if (error instanceof AgentTaskClaimError) throw error;
    throw invalidRepositoryPath("repositoryPath does not exist.");
  }

  const worktreePath = normalizedLocalPath(
    await realpath(await gitPath(localPath, "--show-toplevel")),
  );
  const commonGitDirectory = normalizedLocalPath(
    await realpath(await gitPath(localPath, "--git-common-dir")),
  );
  const repositoryPath = normalizedLocalPath(
    await realpath(
      basename(commonGitDirectory).toLowerCase() === ".git"
        ? dirname(commonGitDirectory)
        : worktreePath,
    ),
  );
  const repositoryName = basename(repositoryPath);
  return {
    requestedPath: normalizedLocalPath(localPath),
    repositoryPath,
    worktreePath,
    projectName: repositoryName,
    repositoryName,
    worktreeName: sameLocalPath(worktreePath, repositoryPath)
      ? "Default"
      : basename(worktreePath),
  };
}

async function findResolvedAgentTaskScope(
  client: AppPrismaClient | TransactionClient,
  placement: ResolvedRepositoryPlacement,
) {
  const repositories = await client.repository.findMany({
    include: { project: true, worktrees: true },
  });
  const candidates = (
    await Promise.all(
      repositories.map(async (candidate) => {
        const repositoryMatches = await sameResolvedLocalPath(
          candidate.localPath,
          placement.repositoryPath,
        );
        const worktreeMatches =
          repositoryMatches ||
          (
            await Promise.all(
              candidate.worktrees.map((worktree) =>
                sameResolvedLocalPath(
                  worktree.localPath,
                  placement.worktreePath,
                ),
              ),
            )
          ).some(Boolean);
        return worktreeMatches ? candidate : null;
      }),
    )
  ).filter((candidate) => candidate !== null);
  const matching = candidates
    .map((repository) => ({
      repository,
      directory: projectWorkspacePath(
        placement.worktreePath,
        repository.projectRoot,
      ),
    }))
    .filter(
      (candidate) =>
        candidate.directory &&
        isWithinCheckout(candidate.directory, placement.requestedPath),
    )
    .sort((left, right) => right.directory!.length - left.directory!.length);
  if (
    candidates.length &&
    (!matching.length ||
      (matching[1] &&
        matching[0]!.directory!.length === matching[1].directory!.length))
  )
    throw invalidRepositoryPath(
      "The repository path does not identify one registered project. Use a path inside the intended project directory or explicit project/repository/worktree IDs.",
    );
  const repository = matching[0]?.repository;
  const worktreeMatches = repository
    ? await Promise.all(
        repository.worktrees.map((candidate) =>
          sameResolvedLocalPath(candidate.localPath, placement.worktreePath),
        ),
      )
    : [];
  const worktree = repository?.worktrees.find(
    (_, index) => worktreeMatches[index],
  );
  return { repository, worktree };
}

function requireUsableResolvedAgentTaskScope(
  scope: Awaited<ReturnType<typeof findResolvedAgentTaskScope>>,
) {
  if (scope.repository?.archivedAt || scope.repository?.project.archivedAt) {
    throw new AgentTaskClaimError(
      "ARCHIVED",
      "The repository scope resolved from repositoryPath is archived.",
      {
        repositoryPath: [
          "Restore the existing project and repository scope before creating a task.",
        ],
      },
    );
  }
  if (scope.worktree?.archivedAt) {
    throw new AgentTaskClaimError(
      "ARCHIVED",
      "The worktree scope resolved from repositoryPath is archived.",
      {
        repositoryPath: [
          "Restore the existing worktree scope before creating a task.",
        ],
      },
    );
  }
}

async function ensureAgentTaskScope(
  transaction: TransactionClient,
  placement: ResolvedRepositoryPlacement,
) {
  const scope = await findResolvedAgentTaskScope(transaction, placement);
  requireUsableResolvedAgentTaskScope(scope);
  const { repository, worktree } = scope;

  if (repository) {
    if (worktree) {
      return {
        scope: {
          projectId: repository.projectId,
          repositoryId: repository.id,
          worktreeId: worktree.id,
        },
        provisioning: {
          ensured: true as const,
          repositoryPath: placement.repositoryPath,
          worktreePath: placement.worktreePath,
          projectCreated: false,
          repositoryCreated: false,
          worktreeCreated: false,
        },
      };
    }
    const createdWorktree = await transaction.worktree.create({
      data: {
        externalKey: `agent-scope-worktree-${hashToken(
          `${repository.id}:${placement.worktreePath.toLowerCase()}`,
        )}`,
        name: placement.worktreeName,
        localPath: placement.worktreePath,
        projectId: repository.projectId,
        repositoryId: repository.id,
      },
    });
    return {
      scope: {
        projectId: repository.projectId,
        repositoryId: repository.id,
        worktreeId: createdWorktree.id,
      },
      provisioning: {
        ensured: true as const,
        repositoryPath: placement.repositoryPath,
        worktreePath: placement.worktreePath,
        projectCreated: false,
        repositoryCreated: false,
        worktreeCreated: true,
      },
    };
  }

  const scopeHash = hashToken(placement.repositoryPath.toLowerCase());
  const project = await transaction.project.create({
    data: {
      externalKey: `agent-scope-project-${scopeHash}`,
      name: placement.projectName,
    },
  });
  const createdRepository = await transaction.repository.create({
    data: {
      externalKey: `agent-scope-repository-${scopeHash}`,
      name: placement.repositoryName,
      localPath: placement.repositoryPath,
      projectId: project.id,
    },
  });
  const createdWorktree = await transaction.worktree.create({
    data: {
      externalKey: `agent-scope-worktree-${hashToken(
        placement.worktreePath.toLowerCase(),
      )}`,
      name: placement.worktreeName,
      localPath: placement.worktreePath,
      projectId: project.id,
      repositoryId: createdRepository.id,
    },
  });
  return {
    scope: {
      projectId: project.id,
      repositoryId: createdRepository.id,
      worktreeId: createdWorktree.id,
    },
    provisioning: {
      ensured: true as const,
      repositoryPath: placement.repositoryPath,
      worktreePath: placement.worktreePath,
      projectCreated: true,
      repositoryCreated: true,
      worktreeCreated: true,
    },
  };
}

async function existingCreatedAgentTask(
  prisma: AppPrismaClient,
  externalKey: string,
  parentId: number | undefined,
  fingerprint: string,
  caller: AgentTaskCaller,
) {
  const existing = await prisma.actionable.findUnique({
    where: { externalKey },
    select: {
      sourceOrdinal: true,
      rawFragmentJson: true,
      hierarchyAsChild: {
        where: { detachedAt: null },
        select: { parent: { select: { sourceOrdinal: true } } },
      },
    },
  });
  if (!existing) return null;
  const fragment = existing.rawFragmentJson;
  const savedFingerprint =
    fragment &&
    !Array.isArray(fragment) &&
    typeof fragment === "object" &&
    "idempotencyFingerprint" in fragment
      ? String(fragment.idempotencyFingerprint)
      : "";
  const savedParentId =
    existing.hierarchyAsChild[0]?.parent.sourceOrdinal ?? undefined;
  if (
    savedFingerprint !== fingerprint ||
    savedParentId !== parentId ||
    creatorThreadId(fragment) !== caller.threadId
  ) {
    throw new AgentTaskClaimError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used for a different create request.",
      {
        idempotencyKey: [
          "Reuse a key only for an identical retry; use a new UUID for a new task.",
        ],
      },
    );
  }
  const detail = await getActionable(prisma, existing.sourceOrdinal);
  if (!detail) throw new Error("Created agent task could not be read.");
  return detail;
}

export async function createAgentTask(
  prisma: AppPrismaClient,
  input: CreateAgentTaskRequest,
  caller: AgentTaskCaller,
): Promise<CreateAgentTaskResult> {
  const request = parseInput(createAgentTaskRequestSchema, input);
  const externalKey = `agent-task-${hashToken(request.idempotencyKey)}`;
  const fingerprint = agentTaskCreateFingerprint(request);
  // ponytail: one local create lock; move ordinal allocation into the database before supporting multi-process writers.
  return withClaimLock("create", async () => {
    const existing = await existingCreatedAgentTask(
      prisma,
      externalKey,
      request.parentId,
      fingerprint,
      caller,
    );
    if (existing) return { task: existing, idempotentReplay: true };

    let scopeProvisioning: AgentTaskScopeProvisioning | undefined;
    if (request.parentId === undefined) {
      const actionableInput = {
        title: request.title,
        priority: request.priority,
        effort: request.effort,
        evidenceState: "Unclassified" as const,
        finding: "",
        description: request.description,
        research: [],
        validation: request.plannedValidation,
        tags: request.tags,
        userSources: [],
      };
      const options = {
        externalKey,
        origin: "agent-task-create",
        rawFragment: {
          kind: "agent-task",
          idempotencyFingerprint: fingerprint,
          creatorThreadId: caller.threadId,
        },
        statusProvenance: "Created by an agent with neutral Inbox status.",
      };
      if (request.ensureScope) {
        const placement = await resolveRepositoryPlacement(
          request.repositoryPath!,
        );
        await prisma.$transaction(async (transaction) => {
          const ensured = await ensureAgentTaskScope(transaction, placement);
          scopeProvisioning = ensured.provisioning;
          await createActionable(
            prisma,
            { ...actionableInput, ...ensured.scope },
            options,
            transaction,
          );
        });
      } else {
        await createActionable(
          prisma,
          {
            ...actionableInput,
            projectId: request.projectId!,
            repositoryId: request.repositoryId!,
            worktreeId: request.worktreeId!,
          },
          options,
        );
      }
    } else {
      const parent = await getActionable(prisma, request.parentId);
      if (!parent) {
        throw new AgentTaskClaimError(
          "NOT_FOUND",
          "The requested parent Actionable was not found.",
          { parentId: ["Choose an existing Actionable."] },
        );
      }
      const workItem = await requireWorkItem(prisma, request.workItemId!);
      if (parent.recordId !== workItem.id) {
        throw new AgentTaskClaimError(
          "INVALID_REQUEST",
          "The requested parent is not the authorized feature or bug work item.",
          {
            parentId: [
              `Choose top-level Actionable ${workItem.sourceOrdinal} as the parent.`,
            ],
          },
        );
      }
      await createSubtask(
        prisma,
        request.parentId,
        {
          version: parent.version,
          title: request.title,
        },
        {
          externalKey,
          origin: "agent-task-create",
          priority: request.priority,
          description: request.description,
          effort: request.effort,
          validation: request.plannedValidation,
          tags: request.tags,
          statusProvenance:
            "Created by an agent as a subtask with neutral Inbox status.",
          rawFragment: {
            kind: "agent-task",
            idempotencyFingerprint: fingerprint,
            creatorThreadId: caller.threadId,
          },
        },
      );
    }

    const created = await existingCreatedAgentTask(
      prisma,
      externalKey,
      request.parentId,
      fingerprint,
      caller,
    );
    if (!created) throw new Error("Created agent task could not be read.");
    return {
      task: created,
      idempotentReplay: false,
      scopeProvisioning,
    };
  });
}

function compactBulkFieldErrors(errors: Record<string, string[]>) {
  return Object.fromEntries(
    Object.entries(errors)
      .slice(0, 20)
      .map(([field, messages]) => [
        field,
        messages.slice(0, 5).map((message) => message.slice(0, 600)),
      ]),
  );
}

function bulkFailure(
  index: number,
  error: unknown,
  context: BulkAgentTaskFailureContext,
): BulkAgentTaskItemResult {
  let payload:
    | {
        code: string;
        detail: string;
        errors?: Record<string, string[]>;
        currentVersion?: number;
        retryAt?: string;
      }
    | undefined;
  if (error instanceof AgentTaskClaimError) {
    payload = {
      code: error.code,
      detail: error.message,
      ...(error.fieldErrors
        ? { errors: compactBulkFieldErrors(error.fieldErrors) }
        : {}),
      ...(error.currentVersion ? { currentVersion: error.currentVersion } : {}),
      ...(error.retryAt ? { retryAt: error.retryAt } : {}),
    };
  } else if (error instanceof DomainValidationError) {
    payload = {
      code: error.code,
      detail: error.message,
      errors: compactBulkFieldErrors(error.fieldErrors),
    };
  } else if (error instanceof VersionConflictError) {
    payload = {
      code: "VERSION_CONFLICT",
      detail: error.message,
      currentVersion: error.current.version,
    };
  }
  if (!payload) {
    context.onInternalError(error);
    payload = {
      code: "INTERNAL_ERROR",
      detail: "The batch item could not be completed.",
    };
  }
  return bulkAgentTaskFailureSchema.parse({
    index,
    outcome: "failed",
    error: actionablesErrorPayload({
      ...payload,
      detail: payload.detail.slice(0, 600),
      correlationId: context.correlationId,
      internalRetryMode: "never",
    }),
  });
}

function bulkSummary(items: BulkAgentTaskItemResult[]) {
  const succeeded = items.filter((item) => item.outcome !== "failed").length;
  return {
    requested: items.length,
    succeeded,
    replayed: items.filter((item) => item.outcome === "replayed").length,
    failed: items.length - succeeded,
  };
}

async function validateExistingAgentTaskScope(
  prisma: AppPrismaClient,
  request: CreateAgentTaskRequest,
) {
  const [project, repository, worktree] = await Promise.all([
    prisma.project.findUnique({ where: { id: request.projectId! } }),
    prisma.repository.findUnique({ where: { id: request.repositoryId! } }),
    prisma.worktree.findUnique({ where: { id: request.worktreeId! } }),
  ]);
  const errors: Record<string, string[]> = {};
  if (!project) errors.projectId = ["Choose an existing project."];
  if (!repository || repository.projectId !== request.projectId) {
    errors.repositoryId = ["Choose a repository in the selected project."];
  }
  if (
    !worktree ||
    worktree.projectId !== request.projectId ||
    worktree.repositoryId !== request.repositoryId
  ) {
    errors.worktreeId = ["Choose a worktree in the selected repository."];
  }
  if (Object.keys(errors).length) {
    throw new DomainValidationError(
      "INVALID_SCOPE",
      errors,
      "The selected scope is invalid.",
    );
  }
}

async function preflightAgentTaskCreate(
  prisma: AppPrismaClient,
  request: CreateAgentTaskRequest,
  caller: AgentTaskCaller,
) {
  const externalKey = `agent-task-${hashToken(request.idempotencyKey)}`;
  const fingerprint = agentTaskCreateFingerprint(request);
  const existing = await existingCreatedAgentTask(
    prisma,
    externalKey,
    request.parentId,
    fingerprint,
    caller,
  );
  if (existing) return existing;

  if (request.parentId === undefined) {
    if (request.ensureScope) {
      const placement = await resolveRepositoryPlacement(
        request.repositoryPath!,
      );
      requireUsableResolvedAgentTaskScope(
        await findResolvedAgentTaskScope(prisma, placement),
      );
    } else {
      await validateExistingAgentTaskScope(prisma, request);
    }
    return null;
  }

  const parent = await getActionable(prisma, request.parentId);
  if (!parent) {
    throw new AgentTaskClaimError(
      "NOT_FOUND",
      "The requested parent Actionable was not found.",
      { parentId: ["Choose an existing Actionable."] },
    );
  }
  const workItem = await requireWorkItem(prisma, request.workItemId!);
  if (parent.recordId !== workItem.id) {
    throw new AgentTaskClaimError(
      "INVALID_REQUEST",
      "The requested parent is not the authorized feature or bug work item.",
      {
        parentId: [
          `Choose top-level Actionable ${workItem.sourceOrdinal} as the parent.`,
        ],
      },
    );
  }
  return null;
}

export async function bulkCreateAgentTasks(
  prisma: AppPrismaClient,
  input: BulkCreateAgentTasksRequest,
  caller: AgentTaskCaller,
  failureContext: BulkAgentTaskFailureContext,
): Promise<BulkCreateAgentTasksResponse> {
  const request = parseInput(bulkCreateAgentTasksRequestSchema, input);
  const preflight: Array<ActionableDetail | BulkAgentTaskItemResult | null> =
    [];
  for (const [index, item] of request.items.entries()) {
    try {
      preflight.push(await preflightAgentTaskCreate(prisma, item, caller));
    } catch (error) {
      preflight.push(bulkFailure(index, error, failureContext));
    }
  }

  const items: BulkAgentTaskItemResult[] = [];
  for (const [index, item] of request.items.entries()) {
    const planned = preflight[index]!;
    if (planned && "outcome" in planned) {
      items.push(planned);
      continue;
    }
    if (planned) {
      items.push(
        bulkCreateAgentTaskSuccessSchema.parse({
          index,
          outcome: "replayed",
          id: planned.id,
          version: planned.version,
          status: planned.status,
        }),
      );
      continue;
    }
    if (request.mode === "preview") {
      items.push(
        bulkCreateAgentTaskSuccessSchema.parse({ index, outcome: "valid" }),
      );
      continue;
    }
    try {
      const created = await createAgentTask(prisma, item, caller);
      items.push(
        bulkCreateAgentTaskSuccessSchema.parse({
          index,
          outcome: created.idempotentReplay ? "replayed" : "created",
          id: created.task.id,
          version: created.task.version,
          status: created.task.status,
        }),
      );
    } catch (error) {
      items.push(bulkFailure(index, error, failureContext));
    }
  }

  return bulkCreateAgentTasksResponseSchema.parse({
    mode: request.mode,
    summary: bulkSummary(items),
    items,
  });
}

const preparationActivityPrefix = "agent-bulk-prepare-";

function agentTaskPreparationFingerprint(request: BulkPrepareAgentTaskItem) {
  return hashToken(
    JSON.stringify({
      id: request.id,
      workItemId: request.workItemId,
      version: request.version,
      finding: request.finding ?? null,
      description: request.description ?? null,
      appendResearch: request.appendResearch ?? null,
      appendPlannedValidation: request.appendPlannedValidation ?? null,
      addUserSources: request.addUserSources ?? null,
    }),
  );
}

function preparationActivityId(idempotencyKey: string) {
  return `${preparationActivityPrefix}${hashToken(idempotencyKey)}`;
}

function jsonRecord(value: Prisma.JsonValue) {
  return value && !Array.isArray(value) && typeof value === "object"
    ? value
    : null;
}

function preparedReceiptFromActivity(
  activity: { type: string; metadataJson: Prisma.JsonValue },
  fingerprint: string,
  caller: AgentTaskCaller,
) {
  const metadata = jsonRecord(activity.metadataJson);
  const receipt = bulkPreparedAgentTaskReceiptSchema.safeParse(
    metadata?.receipt,
  );
  if (
    activity.type !== "agent-bulk-prepared" ||
    metadata?.fingerprint !== fingerprint ||
    metadata?.creatorThreadId !== caller.threadId ||
    !receipt.success
  ) {
    throw new AgentTaskClaimError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used for a different preparation request.",
      {
        idempotencyKey: [
          "Reuse a key only for an identical retry; use a new UUID for a new preparation.",
        ],
      },
    );
  }
  return receipt.data;
}

type AgentTaskPreparationPlan =
  | { kind: "replay"; receipt: BulkPreparedAgentTaskReceipt }
  | {
      kind: "prepare";
      row: AgentTaskMutationRow;
      finding: string;
      description: string;
      research: string[];
      plannedValidation: string[];
      userSources: Array<{
        type: string;
        locator: string;
        label?: string;
      }>;
      changedFields: BulkPreparedAgentTaskReceipt["changedFields"];
      counts: BulkPreparedAgentTaskReceipt["counts"];
    };

async function planAgentTaskPreparation(
  tx: TransactionClient,
  request: BulkPrepareAgentTaskItem,
  caller: AgentTaskCaller,
  now: Date,
): Promise<AgentTaskPreparationPlan> {
  const fingerprint = agentTaskPreparationFingerprint(request);
  const existingActivity = await tx.activityEvent.findUnique({
    where: { id: preparationActivityId(request.idempotencyKey) },
  });
  if (existingActivity) {
    return {
      kind: "replay",
      receipt: preparedReceiptFromActivity(
        existingActivity,
        fingerprint,
        caller,
      ),
    };
  }

  const row = await findMutationTask(tx, request.id);
  requireClaimable(row);
  const workItem = await requireWorkItem(tx, request.workItemId);
  requireTaskInWorkItem(row, workItem);
  if (creatorThreadId(row.rawFragmentJson) !== caller.threadId) {
    throw new AgentTaskClaimError(
      "CREATOR_THREAD_MISMATCH",
      "Bulk preparation accepts only Actionables created by the current Codex thread.",
      {
        id: [
          "Use the normal list, claim, reconcile, research, and lifecycle workflow for an existing task.",
        ],
      },
    );
  }
  if (row.status !== "Inbox") {
    throw new AgentTaskClaimError(
      "INVALID_REQUEST",
      "Bulk preparation accepts only Inbox Actionables.",
      {
        id: ["Use the normal claimed-task workflow for work already started."],
      },
    );
  }
  if (
    row.dependenciesAsDependent.some(
      (relationship) =>
        relationship.waivedAt === null &&
        relationship.prerequisite.status !== "Done",
    )
  ) {
    throw new AgentTaskClaimError(
      "INVALID_REQUEST",
      "An Actionable with unresolved dependencies cannot be bulk prepared.",
      { id: ["Resolve or waive every prerequisite before preparation."] },
    );
  }
  const agentId = `codex:${caller.threadId}`;
  if (row.agentTaskClaim && row.agentTaskClaim.leaseExpiresAt > now) {
    throw new AgentTaskClaimError(
      row.agentTaskClaim.agentId === agentId
        ? "OWN_CLAIM_ACTIVE"
        : "ALREADY_CLAIMED",
      row.agentTaskClaim.agentId === agentId
        ? "This Actionable already has an active claim owned by the current Codex thread."
        : "This Actionable already has an active claim.",
      undefined,
      row.version,
      row.agentTaskClaim.agentId === agentId
        ? undefined
        : row.agentTaskClaim.leaseExpiresAt.toISOString(),
    );
  }
  if (row.version !== request.version) {
    throw new AgentTaskClaimError(
      "VERSION_CONFLICT",
      "This Actionable changed after it was listed.",
      undefined,
      row.version,
    );
  }

  const currentResearch = persistedStringArray(row.researchJson);
  const currentPlannedValidation = persistedStringArray(row.validationJson);
  const currentSources = row.userSources.map((source) => ({
    type: source.type,
    locator: source.locator,
    ...(source.label ? { label: source.label } : {}),
  }));
  const research = request.appendResearch
    ? appendUniqueStrings(currentResearch, request.appendResearch)
    : undefined;
  const plannedValidation = request.appendPlannedValidation
    ? appendUniqueStrings(
        currentPlannedValidation,
        request.appendPlannedValidation,
      )
    : undefined;
  const sources = request.addUserSources
    ? appendUniqueUserSources(currentSources, request.addUserSources)
    : undefined;
  const finding = request.finding ?? row.finding;
  const description = request.description ?? row.description;
  const nextResearch = research?.values ?? currentResearch;
  const nextPlannedValidation =
    plannedValidation?.values ?? currentPlannedValidation;
  const nextSources = sources?.values ?? currentSources;
  const readiness = lifecycleReadiness("Researching", {
    finding,
    description,
    research: nextResearch,
    plannedValidation: nextPlannedValidation,
  });
  if (readiness.requiredForReady.length) {
    const errors = Object.fromEntries(
      readiness.blockers.map((blocker) => [
        blocker.field === "research"
          ? "appendResearch"
          : blocker.field === "plannedValidation"
            ? "appendPlannedValidation"
            : blocker.field,
        [blocker.message],
      ]),
    );
    throw new DomainValidationError(
      "READY_REQUIREMENTS_NOT_MET",
      errors,
      `Ready requires: ${readiness.requiredForReady.join(", ")}.`,
    );
  }

  const changedFields: BulkPreparedAgentTaskReceipt["changedFields"] = [
    request.finding !== undefined && request.finding !== row.finding
      ? "finding"
      : null,
    request.description !== undefined && request.description !== row.description
      ? "description"
      : null,
    !sameJson(nextResearch, currentResearch) ? "research" : null,
    !sameJson(nextPlannedValidation, currentPlannedValidation)
      ? "plannedValidation"
      : null,
    !sameJson(nextSources, currentSources) ? "userSources" : null,
    "status",
  ].filter(
    (field): field is BulkPreparedAgentTaskReceipt["changedFields"][number] =>
      field !== null,
  );
  const counts: BulkPreparedAgentTaskReceipt["counts"] = [
    ...(research
      ? [
          {
            field: "research" as const,
            persisted: research.appended,
            duplicatesIgnored: research.duplicatesIgnored,
          },
        ]
      : []),
    ...(plannedValidation
      ? [
          {
            field: "plannedValidation" as const,
            persisted: plannedValidation.appended,
            duplicatesIgnored: plannedValidation.duplicatesIgnored,
          },
        ]
      : []),
    ...(sources
      ? [
          {
            field: "userSources" as const,
            persisted: sources.appended,
            duplicatesIgnored: sources.duplicatesIgnored,
          },
        ]
      : []),
  ];
  return {
    kind: "prepare",
    row,
    finding,
    description,
    research: nextResearch,
    plannedValidation: nextPlannedValidation,
    userSources: nextSources,
    changedFields,
    counts,
  };
}

async function applyAgentTaskPreparation(
  prisma: AppPrismaClient,
  request: BulkPrepareAgentTaskItem,
  caller: AgentTaskCaller,
  now: Date,
) {
  return withClaimLock(String(request.id), () =>
    prisma.$transaction(async (tx) => {
      const plan = await planAgentTaskPreparation(tx, request, caller, now);
      if (plan.kind === "replay") {
        return { replayed: true as const, receipt: plan.receipt };
      }

      const { row } = plan;
      const agentId = `codex:${caller.threadId}`;
      let version = row.version;
      if (row.agentTaskClaim) {
        await recordObservedExpiry(tx, row, now);
        await tx.actionable.update({
          where: { id: row.id },
          data: {
            version: { increment: 1 },
            updatedLabel: "agent claim expired",
          },
        });
        version += 1;
      }

      const leaseMinutes = (await getAgentCoordinationSettings(tx))
        .agentClaimLeaseMinutes;
      await tx.agentTaskClaim.create({
        data: {
          actionableId: row.id,
          agentId,
          claimTokenHash: hashToken(randomBytes(32).toString("base64url")),
          claimedAt: now,
          leaseExpiresAt: leaseExpiry(now, leaseMinutes),
        },
      });
      await tx.actionable.update({
        where: { id: row.id },
        data: { version: { increment: 1 }, updatedLabel: "agent claim" },
      });
      version += 1;
      await tx.activityEvent.create({
        data: {
          actionableId: row.id,
          type: "agent-claimed",
          summary: `Claimed by agent ${agentId}`,
          metadataJson: { agentId },
          occurredAt: now,
        },
      });

      const researching = await transitionActionable(
        prisma,
        request.id,
        {
          version,
          status: "Researching",
          origin: agentOrigin(agentId),
        },
        tx,
      );
      if (!researching) {
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      }
      version = researching.version;

      const updated = await updateActionable(
        prisma,
        request.id,
        parseInput(updateActionableRequestSchema, {
          version,
          title: row.title,
          priority: row.priority,
          effort: row.effort,
          evidenceState: row.evidenceState,
          projectId: row.projectId,
          repositoryId: row.repositoryId,
          worktreeId: row.worktreeId,
          status: "Researching",
          finding: plan.finding,
          description: plan.description,
          resolution: row.resolution,
          research: plan.research,
          validation: plan.plannedValidation,
          tags: persistedStringArray(row.tagsJson),
          userSources: plan.userSources,
        }),
        tx,
        "agent-added",
      );
      if (!updated) {
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      }
      version = updated.version;
      await tx.activityEvent.create({
        data: {
          actionableId: row.id,
          type: "agent-updated",
          summary: `Updated by agent ${agentId}`,
          metadataJson: {
            origin: agentOrigin(agentId),
            fields: plan.changedFields
              .filter((field) => field !== "status")
              .join(","),
            operation: "bulk-prepare",
          },
          occurredAt: now,
        },
      });

      const ready = await transitionActionable(
        prisma,
        request.id,
        {
          version,
          status: "Ready",
          origin: agentOrigin(agentId),
        },
        tx,
      );
      if (!ready) {
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      }

      await tx.agentTaskClaim.delete({ where: { actionableId: row.id } });
      await tx.actionable.update({
        where: { id: row.id },
        data: { version: { increment: 1 }, updatedLabel: "agent release" },
      });
      await tx.activityEvent.create({
        data: {
          actionableId: row.id,
          type: "agent-released",
          summary: `Released by agent ${agentId}`,
          metadataJson: { agentId, operation: "bulk-prepare" },
          occurredAt: now,
        },
      });
      const saved = await getActionable(tx, request.id);
      if (!saved) {
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      }
      const receipt = bulkPreparedAgentTaskReceiptSchema.parse({
        id: saved.id,
        version: saved.version,
        status: saved.status,
        claimReleased: true,
        changedFields: plan.changedFields,
        counts: plan.counts,
      });
      await tx.activityEvent.create({
        data: {
          id: preparationActivityId(request.idempotencyKey),
          actionableId: row.id,
          type: "agent-bulk-prepared",
          summary: `Bulk prepared by agent ${agentId}`,
          metadataJson: {
            fingerprint: agentTaskPreparationFingerprint(request),
            creatorThreadId: caller.threadId,
            receipt,
          },
          occurredAt: now,
        },
      });
      return { replayed: false as const, receipt };
    }),
  );
}

export async function bulkPrepareAgentTasks(
  prisma: AppPrismaClient,
  input: BulkPrepareAgentTasksRequest,
  caller: AgentTaskCaller,
  failureContext: BulkAgentTaskFailureContext,
  now = new Date(),
): Promise<BulkPrepareAgentTasksResponse> {
  const request = parseInput(bulkPrepareAgentTasksRequestSchema, input);
  const preflight: Array<AgentTaskPreparationPlan | BulkAgentTaskItemResult> =
    [];
  for (const [index, item] of request.items.entries()) {
    try {
      preflight.push(
        await prisma.$transaction((tx) =>
          planAgentTaskPreparation(tx, item, caller, now),
        ),
      );
    } catch (error) {
      preflight.push(bulkFailure(index, error, failureContext));
    }
  }

  const items: BulkAgentTaskItemResult[] = [];
  for (const [index, item] of request.items.entries()) {
    const planned = preflight[index]!;
    if ("outcome" in planned) {
      items.push(planned);
      continue;
    }
    if (planned.kind === "replay") {
      items.push(
        bulkPrepareAgentTaskSuccessSchema.parse({
          index,
          outcome: "replayed",
          ...planned.receipt,
        }),
      );
      continue;
    }
    if (request.mode === "preview") {
      items.push(
        bulkPrepareAgentTaskSuccessSchema.parse({
          index,
          outcome: "valid",
          id: planned.row.sourceOrdinal,
          version: planned.row.version,
          status: planned.row.status,
        }),
      );
      continue;
    }
    try {
      const applied = await applyAgentTaskPreparation(
        prisma,
        item,
        caller,
        now,
      );
      items.push(
        bulkPrepareAgentTaskSuccessSchema.parse({
          index,
          outcome: applied.replayed ? "replayed" : "prepared",
          ...applied.receipt,
        }),
      );
    } catch (error) {
      items.push(bulkFailure(index, error, failureContext));
    }
  }

  return bulkPrepareAgentTasksResponseSchema.parse({
    mode: request.mode,
    summary: bulkSummary(items),
    items,
  });
}

export async function getClaimedAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ReleaseAgentTaskClaimRequest,
  now = new Date(),
): Promise<ActionableDetail> {
  const request = parseInput(releaseAgentTaskClaimRequestSchema, input);
  const result = await withClaimLock(String(sourceOrdinal), () =>
    prisma.$transaction(async (tx) => {
      const row = await findTask(tx, sourceOrdinal);
      const claim = requireValidClaim(row, request.claimToken, now);
      if (claim === "expired") {
        await recordObservedExpiry(tx, row!, now);
        await tx.actionable.update({
          where: { id: row!.id },
          data: {
            version: { increment: 1 },
            updatedLabel: "agent claim expired",
          },
        });
        return { expired: true as const };
      }
      if (isArchived(row!)) {
        throw new AgentTaskClaimError(
          "ARCHIVED",
          "Archived Actionables cannot be inspected by an agent.",
        );
      }
      if (terminalStatuses.includes(row!.status)) {
        throw new AgentTaskClaimError(
          "TERMINAL",
          "Terminal Actionables cannot be inspected by an agent.",
        );
      }
      return {
        expired: false as const,
        task: await getActionable(tx, sourceOrdinal),
      };
    }),
  );
  if (result.expired) {
    throw new AgentTaskClaimError(
      "CLAIM_EXPIRED",
      "The claim lease expired and must be reacquired.",
    );
  }
  if (!result.task)
    throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
  return result.task;
}

export async function getScopedTerminalAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  workItemSourceOrdinal: number,
  expectedVersion?: number,
): Promise<ActionableDetail> {
  return prisma.$transaction(async (tx) => {
    const workItem = await requireWorkItem(tx, workItemSourceOrdinal, {
      allowTerminal: true,
    });
    const row = await findTask(tx, sourceOrdinal);
    if (!row) {
      throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
    }
    requireTaskInWorkItem(row, workItem);
    if (isArchived(row)) {
      throw new AgentTaskClaimError(
        "ARCHIVED",
        "Archived Actionables cannot be inspected by an agent.",
      );
    }
    if (!terminalStatuses.includes(row.status)) {
      if (expectedVersion !== undefined) {
        throw new AgentTaskClaimError(
          "TERMINAL_READ_INVALIDATED",
          "This Actionable is no longer terminal, so scoped terminal inspection has ended.",
          undefined,
          row.version,
        );
      }
      throw new AgentTaskClaimError(
        "INVALID_REQUEST",
        "Active Actionables require a valid claim token for exact inspection.",
        {
          claimToken: [
            "Use claimToken for active claimed work; workItemId is only for terminal inspection.",
          ],
        },
      );
    }
    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      throw new AgentTaskClaimError(
        "VERSION_CONFLICT",
        "This Actionable changed after it was fetched.",
        undefined,
        row.version,
      );
    }
    const task = await getActionable(tx, sourceOrdinal);
    if (!task) {
      throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
    }
    return task;
  });
}

async function updateClaimedAgentTaskResult<T = never>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: UpdateClaimedAgentTaskRequest,
  now = new Date(),
  projectResponse?: (result: UpdateClaimedAgentTaskResult) => T,
): Promise<UpdateClaimedAgentTaskResult | T> {
  const request = parseInput(updateClaimedAgentTaskRequestSchema, input);
  return runClaimedMutation(
    prisma,
    sourceOrdinal,
    request,
    now,
    async (tx, row, claim) => {
      const currentSources = row.userSources.map((source) => ({
        type: source.type,
        locator: source.locator,
        ...(source.label ? { label: source.label } : {}),
      }));
      const currentResearch = persistedStringArray(row.researchJson);
      const currentPlannedValidation = persistedStringArray(row.validationJson);
      const researchAppend = request.appendResearch
        ? appendUniqueStrings(currentResearch, request.appendResearch)
        : undefined;
      const plannedValidationAppend = request.appendPlannedValidation
        ? {
            values: [
              ...currentPlannedValidation,
              ...request.appendPlannedValidation,
            ],
            appended: request.appendPlannedValidation.length,
            duplicatesIgnored: 0,
          }
        : undefined;
      const sourceAppend = request.addUserSources
        ? appendUniqueUserSources(currentSources, request.addUserSources)
        : undefined;
      const nextResearch =
        request.research ?? researchAppend?.values ?? currentResearch;
      const nextPlannedValidation =
        request.plannedValidation ??
        plannedValidationAppend?.values ??
        currentPlannedValidation;
      const nextSources =
        request.userSources ?? sourceAppend?.values ?? currentSources;
      const update = parseInput(updateActionableRequestSchema, {
        version: request.version,
        title: request.title ?? row.title,
        priority: request.priority ?? row.priority,
        effort: request.effort ?? row.effort,
        evidenceState: request.evidenceState ?? row.evidenceState,
        projectId: row.projectId,
        repositoryId: row.repositoryId,
        worktreeId: row.worktreeId,
        status: row.status,
        finding: request.finding ?? row.finding,
        description: request.description ?? row.description,
        resolution: request.resolution ?? row.resolution,
        research: nextResearch,
        validation: nextPlannedValidation,
        tags: request.tags ?? persistedStringArray(row.tagsJson),
        userSources: nextSources,
      });
      const saved = await updateActionable(
        prisma,
        sourceOrdinal,
        update,
        tx,
        "agent-added",
      );
      if (!saved)
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");

      const changedFields = [
        request.title !== undefined && request.title !== row.title
          ? "title"
          : null,
        request.priority !== undefined && request.priority !== row.priority
          ? "priority"
          : null,
        request.effort !== undefined && request.effort !== row.effort
          ? "effort"
          : null,
        request.evidenceState !== undefined &&
        request.evidenceState !== row.evidenceState
          ? "evidenceState"
          : null,
        request.finding !== undefined && request.finding !== row.finding
          ? "finding"
          : null,
        request.description !== undefined &&
        request.description !== row.description
          ? "description"
          : null,
        request.resolution !== undefined &&
        request.resolution !== row.resolution
          ? "resolution"
          : null,
        !sameJson(nextResearch, currentResearch) ? "research" : null,
        !sameJson(nextPlannedValidation, currentPlannedValidation)
          ? "plannedValidation"
          : null,
        request.tags !== undefined &&
        !sameJson(request.tags, persistedStringArray(row.tagsJson))
          ? "tags"
          : null,
        !sameJson(nextSources, currentSources) ? "userSources" : null,
      ].filter((field): field is string => field !== null);
      const counts: AgentTaskMutationCount[] = [
        ...(researchAppend
          ? [
              {
                field: "research",
                persisted: researchAppend.appended,
                duplicatesIgnored: researchAppend.duplicatesIgnored,
              },
            ]
          : []),
        ...(plannedValidationAppend
          ? [
              {
                field: "plannedValidation",
                persisted: plannedValidationAppend.appended,
                duplicatesIgnored: plannedValidationAppend.duplicatesIgnored,
              },
            ]
          : []),
        ...(sourceAppend
          ? [
              {
                field: "userSources",
                persisted: sourceAppend.appended,
                duplicatesIgnored: sourceAppend.duplicatesIgnored,
              },
            ]
          : []),
      ];
      await tx.activityEvent.create({
        data: {
          actionableId: row.id,
          type: "agent-updated",
          summary: `Updated by agent ${claim.agentId}`,
          metadataJson: {
            origin: agentOrigin(claim.agentId),
            fields: changedFields.join(","),
          },
          occurredAt: now,
        },
      });
      await renewClaimAfterMutation(tx, row, now);
      return {
        task: saved,
        changedFields,
        counts,
      };
    },
    projectResponse,
  );
}

export async function updateClaimedAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: UpdateClaimedAgentTaskRequest,
  now = new Date(),
): Promise<ActionableDetail> {
  const result = await updateClaimedAgentTaskResult(
    prisma,
    sourceOrdinal,
    input,
    now,
  );
  return (result as UpdateClaimedAgentTaskResult).task;
}

export function updateClaimedAgentTaskWithProjection<T>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: UpdateClaimedAgentTaskRequest,
  projectResponse: (result: UpdateClaimedAgentTaskResult) => T,
  now = new Date(),
): Promise<T> {
  return updateClaimedAgentTaskResult(
    prisma,
    sourceOrdinal,
    input,
    now,
    projectResponse,
  ) as Promise<T>;
}

async function transitionClaimedAgentTaskResult<T = never>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: TransitionClaimedAgentTaskRequest,
  now = new Date(),
  projectResponse?: (task: ActionableDetail) => T,
): Promise<ActionableDetail | T> {
  const request = parseInput(transitionClaimedAgentTaskRequestSchema, input);
  return runClaimedMutation(
    prisma,
    sourceOrdinal,
    request,
    now,
    async (tx, row, claim) => {
      const saved = await transitionActionable(
        prisma,
        sourceOrdinal,
        {
          version: request.version,
          status: request.status,
          reason: request.reason,
          origin: agentOrigin(claim.agentId),
        },
        tx,
      );
      if (!saved)
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");

      if (request.status === "Done" || request.status === "Dismissed") {
        await releaseClaimAfterTerminalTransition(
          tx,
          row,
          claim.agentId,
          request.status,
          now,
        );
      } else {
        await renewClaimAfterMutation(tx, row, now);
      }
      return saved;
    },
    projectResponse,
  );
}

export function transitionClaimedAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: TransitionClaimedAgentTaskRequest,
  now = new Date(),
): Promise<ActionableDetail> {
  return transitionClaimedAgentTaskResult(
    prisma,
    sourceOrdinal,
    input,
    now,
  ) as Promise<ActionableDetail>;
}

export function transitionClaimedAgentTaskWithProjection<T>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: TransitionClaimedAgentTaskRequest,
  projectResponse: (task: ActionableDetail) => T,
  now = new Date(),
): Promise<T> {
  return transitionClaimedAgentTaskResult(
    prisma,
    sourceOrdinal,
    input,
    now,
    projectResponse,
  ) as Promise<T>;
}

async function dismissAgentTaskResult<T = never>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: DismissAgentTaskRequest,
  caller: AgentTaskCaller,
  now = new Date(),
  projectResponse?: (task: ActionableDetail) => T,
): Promise<ActionableDetail | T> {
  const request = parseInput(dismissAgentTaskRequestSchema, input);
  return withClaimLock(String(sourceOrdinal), () =>
    prisma.$transaction(async (tx) => {
      const row = await findTask(tx, sourceOrdinal);
      requireClaimable(row);
      if (creatorThreadId(row.rawFragmentJson) !== caller.threadId) {
        throw new AgentTaskClaimError(
          "CREATOR_THREAD_MISMATCH",
          "Only the Codex thread that created this Actionable can dismiss it without a claim.",
        );
      }
      if (row.agentTaskClaim && row.agentTaskClaim.leaseExpiresAt > now) {
        throw new AgentTaskClaimError(
          "ALREADY_CLAIMED",
          "This Actionable has an active claim.",
          undefined,
          row.version,
          row.agentTaskClaim.leaseExpiresAt.toISOString(),
        );
      }

      let version = row.version;
      if (row.agentTaskClaim) {
        await recordObservedExpiry(tx, row, now);
        await tx.actionable.update({
          where: { id: row.id },
          data: {
            version: { increment: 1 },
            updatedLabel: "agent claim expired",
          },
        });
        version += 1;
      }

      const saved = await transitionActionable(
        prisma,
        sourceOrdinal,
        {
          version,
          status: "Dismissed",
          reason: request.reason,
          origin: agentOrigin(`codex:${caller.threadId}`),
        },
        tx,
      );
      if (!saved)
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      return projectResponse ? projectResponse(saved) : saved;
    }),
  );
}

export function dismissAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: DismissAgentTaskRequest,
  caller: AgentTaskCaller,
  now = new Date(),
): Promise<ActionableDetail> {
  return dismissAgentTaskResult(
    prisma,
    sourceOrdinal,
    input,
    caller,
    now,
  ) as Promise<ActionableDetail>;
}

export function dismissAgentTaskWithProjection<T>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: DismissAgentTaskRequest,
  caller: AgentTaskCaller,
  projectResponse: (task: ActionableDetail) => T,
  now = new Date(),
): Promise<T> {
  return dismissAgentTaskResult(
    prisma,
    sourceOrdinal,
    input,
    caller,
    now,
    projectResponse,
  ) as Promise<T>;
}

async function recordClaimedAgentTaskValidationResult<T = never>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: RecordClaimedAgentTaskValidationRequest,
  now = new Date(),
  projectResponse?: (result: RecordClaimedAgentTaskValidationResult) => T,
): Promise<RecordClaimedAgentTaskValidationResult | T> {
  const request = parseInput(
    recordClaimedAgentTaskValidationRequestSchema,
    input,
  );
  return runClaimedMutation(
    prisma,
    sourceOrdinal,
    request,
    now,
    async (tx, row, claim) => {
      const recorded = await recordValidationWithRecord(
        prisma,
        sourceOrdinal,
        {
          version: request.version,
          type: request.type,
          outcome: request.outcome,
          notes: request.notes,
          evidence: request.evidence,
          origin: agentOrigin(claim.agentId),
          supersedesId: request.supersedesId,
        },
        tx,
      );
      const saved = recorded.task;
      if (!saved)
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      await renewClaimAfterMutation(tx, row, now);
      const validation = saved.validationRecords.find(
        (candidate) => candidate.id === recorded.validationRecordId,
      );
      if (!validation) {
        throw new Error("Recorded validation could not be read.");
      }
      return {
        task: saved,
        validation: {
          id: validation.id,
          qualifiesForCompletion: validation.qualifiesForCompletion,
        },
        counts: [
          {
            field: "validationRecords" as const,
            persisted: 1 as const,
            duplicatesIgnored: 0,
          },
        ],
      };
    },
    projectResponse,
  );
}

export async function recordClaimedAgentTaskValidation(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: RecordClaimedAgentTaskValidationRequest,
  now = new Date(),
): Promise<ActionableDetail> {
  const result = await recordClaimedAgentTaskValidationResult(
    prisma,
    sourceOrdinal,
    input,
    now,
  );
  return (result as RecordClaimedAgentTaskValidationResult).task;
}

export function recordClaimedAgentTaskValidationWithProjection<T>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: RecordClaimedAgentTaskValidationRequest,
  projectResponse: (result: RecordClaimedAgentTaskValidationResult) => T,
  now = new Date(),
): Promise<T> {
  return recordClaimedAgentTaskValidationResult(
    prisma,
    sourceOrdinal,
    input,
    now,
    projectResponse,
  ) as Promise<T>;
}

async function handoffClaimedAgentTaskResult<T = never>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: HandoffClaimedAgentTaskRequest,
  now = new Date(),
  projectResponse?: (result: HandoffClaimedAgentTaskResult) => T,
): Promise<HandoffClaimedAgentTaskResult | T> {
  const request = parseInput(handoffClaimedAgentTaskRequestSchema, input);
  return runClaimedMutation(
    prisma,
    sourceOrdinal,
    request,
    now,
    async (tx, row, claim) => {
      const currentResearch = persistedStringArray(row.researchJson);
      const currentPlannedValidation = persistedStringArray(row.validationJson);
      const currentFiles = persistedSourceFiles(row.filesJson);
      const researchAppend = request.appendResearch
        ? appendUniqueStrings(currentResearch, request.appendResearch)
        : undefined;
      const plannedValidationAppend = request.appendPlannedValidation
        ? appendUniqueStrings(
            currentPlannedValidation,
            request.appendPlannedValidation,
          )
        : undefined;
      const fileAppend = request.addFiles
        ? appendUniqueFiles(currentFiles, request.addFiles)
        : undefined;
      const research = researchAppend?.values ?? currentResearch;
      const plannedValidation =
        plannedValidationAppend?.values ?? currentPlannedValidation;
      const files = fileAppend?.values ?? currentFiles;
      const contentFields = [
        request.finding !== undefined && request.finding !== row.finding
          ? "finding"
          : null,
        fileAppend?.appended ? "files" : null,
        researchAppend?.appended ? "research" : null,
        plannedValidationAppend?.appended ? "plannedValidation" : null,
      ].filter((field): field is string => field !== null);
      const requestedContentFields = [
        "finding",
        "addFiles",
        "appendResearch",
        "appendPlannedValidation",
      ].filter((field) => request[field as keyof typeof request] !== undefined);
      const counts: AgentTaskMutationCount[] = [
        ...(researchAppend
          ? [
              {
                field: "research",
                persisted: researchAppend.appended,
                duplicatesIgnored: researchAppend.duplicatesIgnored,
              },
            ]
          : []),
        ...(plannedValidationAppend
          ? [
              {
                field: "plannedValidation",
                persisted: plannedValidationAppend.appended,
                duplicatesIgnored: plannedValidationAppend.duplicatesIgnored,
              },
            ]
          : []),
        ...(fileAppend
          ? [
              {
                field: "files",
                persisted: fileAppend.appended,
                duplicatesIgnored: fileAppend.duplicatesIgnored,
              },
            ]
          : []),
      ];
      let version = request.version;
      let recordedValidation:
        HandoffClaimedAgentTaskResult["validation"] | undefined;

      if (requestedContentFields.length > 0) {
        const update = parseInput(updateActionableRequestSchema, {
          version,
          title: row.title,
          priority: row.priority,
          effort: row.effort,
          evidenceState: row.evidenceState,
          projectId: row.projectId,
          repositoryId: row.repositoryId,
          worktreeId: row.worktreeId,
          status: row.status,
          finding: request.finding ?? row.finding,
          description: row.description,
          resolution: row.resolution,
          research,
          validation: plannedValidation,
          tags: persistedStringArray(row.tagsJson),
          userSources: row.userSources.map((source) => ({
            type: source.type,
            locator: source.locator,
            ...(source.label ? { label: source.label } : {}),
          })),
        });
        const saved = await updateActionable(prisma, sourceOrdinal, update, tx);
        if (!saved)
          throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
        version = saved.version;

        if (request.addFiles) {
          await tx.actionable.update({
            where: { id: row.id },
            data: { filesJson: files as Prisma.InputJsonValue },
          });
        }
        await tx.activityEvent.create({
          data: {
            actionableId: row.id,
            type: "agent-updated",
            summary: `Updated by agent ${claim.agentId} during handoff`,
            metadataJson: {
              origin: agentOrigin(claim.agentId),
              fields: requestedContentFields.join(","),
              operation: "handoff",
            },
            occurredAt: now,
          },
        });
      }

      if (request.validation) {
        const recorded = await recordValidationWithRecord(
          prisma,
          sourceOrdinal,
          {
            version,
            ...request.validation,
            origin: agentOrigin(claim.agentId),
          },
          tx,
        );
        const saved = recorded.task;
        if (!saved)
          throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
        version = saved.version;
        const validation = saved.validationRecords.find(
          (candidate) => candidate.id === recorded.validationRecordId,
        );
        if (!validation) {
          throw new Error("Handoff validation could not be read.");
        }
        recordedValidation = {
          id: validation.id,
          qualifiesForCompletion: validation.qualifiesForCompletion,
        };
        counts.push({
          field: "validationRecords",
          persisted: 1,
          duplicatesIgnored: 0,
        });
      }

      await tx.agentTaskClaim.delete({ where: { actionableId: row.id } });
      await tx.activityEvent.create({
        data: {
          actionableId: row.id,
          type: "agent-released",
          summary: `Released by agent ${claim.agentId} after atomic handoff`,
          metadataJson: {
            agentId: claim.agentId,
            origin: agentOrigin(claim.agentId),
            operation: "handoff",
            version: String(version),
          },
          occurredAt: now,
        },
      });
      const handedOff = await getActionable(tx, sourceOrdinal);
      if (!handedOff)
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      return {
        task: handedOff,
        changedFields: [
          ...contentFields,
          ...(recordedValidation ? ["validationRecords"] : []),
        ],
        counts,
        ...(recordedValidation ? { validation: recordedValidation } : {}),
      };
    },
    projectResponse,
  );
}

export async function handoffClaimedAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: HandoffClaimedAgentTaskRequest,
  now = new Date(),
): Promise<ActionableDetail> {
  const result = await handoffClaimedAgentTaskResult(
    prisma,
    sourceOrdinal,
    input,
    now,
  );
  return (result as HandoffClaimedAgentTaskResult).task;
}

export function handoffClaimedAgentTaskWithProjection<T>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: HandoffClaimedAgentTaskRequest,
  projectResponse: (result: HandoffClaimedAgentTaskResult) => T,
  now = new Date(),
): Promise<T> {
  return handoffClaimedAgentTaskResult(
    prisma,
    sourceOrdinal,
    input,
    now,
    projectResponse,
  ) as Promise<T>;
}

export function claimAgentTask(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ClaimAgentTaskRequest,
  now = new Date(),
): Promise<ClaimAgentTaskResponse> {
  return withClaimLock(String(sourceOrdinal), () =>
    claimAgentTaskUnlocked(prisma, sourceOrdinal, input, now),
  );
}

export function claimAgentTaskWithProjection<T>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ClaimAgentTaskRequest,
  projectResponse: (
    task: ActionableDetail,
    claim: ClaimAgentTaskResponse["claim"],
  ) => T,
  now = new Date(),
): Promise<T> {
  return withClaimLock(String(sourceOrdinal), () =>
    claimAgentTaskUnlocked(prisma, sourceOrdinal, input, now, projectResponse),
  ) as Promise<T>;
}

async function claimAgentTaskUnlocked<T = never>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ClaimAgentTaskRequest,
  now: Date,
  projectResponse?: (
    task: ActionableDetail,
    claim: ClaimAgentTaskResponse["claim"],
  ) => T,
): Promise<ClaimAgentTaskResponse | T> {
  const request = parseInput(claimAgentTaskRequestSchema, input);
  const claimToken = randomBytes(32).toString("base64url");
  const claimTokenHash = hashToken(claimToken);

  try {
    const response = await prisma.$transaction(async (tx) => {
      const row = await findTask(tx, sourceOrdinal);
      requireClaimable(row);
      const workItem = await requireWorkItem(tx, request.workItemId);
      requireTaskInWorkItem(row, workItem);
      if (
        row.agentTaskClaim?.leaseExpiresAt &&
        row.agentTaskClaim.leaseExpiresAt > now
      ) {
        throw new AgentTaskClaimError(
          row.agentTaskClaim.agentId === request.agentId
            ? "OWN_CLAIM_ACTIVE"
            : "ALREADY_CLAIMED",
          row.agentTaskClaim.agentId === request.agentId
            ? "This Actionable already has an active claim owned by the current Codex thread."
            : "This Actionable already has an active claim.",
          undefined,
          row.version,
          row.agentTaskClaim.agentId === request.agentId
            ? undefined
            : row.agentTaskClaim.leaseExpiresAt.toISOString(),
        );
      }
      if (row.version !== request.version) {
        throw new AgentTaskClaimError(
          "VERSION_CONFLICT",
          "This Actionable changed after it was listed.",
          undefined,
          row.version,
        );
      }
      await recordObservedExpiry(tx, row, now);
      const leaseMinutes =
        request.leaseMinutes ??
        (await getAgentCoordinationSettings(tx)).agentClaimLeaseMinutes;
      await tx.agentTaskClaim.create({
        data: {
          actionableId: row.id,
          agentId: request.agentId,
          claimTokenHash,
          claimedAt: now,
          leaseExpiresAt: leaseExpiry(now, leaseMinutes),
        },
      });
      await tx.actionable.update({
        where: { id: row.id },
        data: {
          version: { increment: 1 },
          updatedLabel: "agent claim",
        },
      });
      await tx.activityEvent.create({
        data: {
          actionableId: row.id,
          type: "agent-claimed",
          summary: `Claimed by agent ${request.agentId}`,
          metadataJson: { agentId: request.agentId },
          occurredAt: now,
        },
      });
      const task = await findTask(tx, sourceOrdinal);
      if (!task?.agentTaskClaim) {
        throw new Error("Claim transaction did not return the created claim.");
      }
      const response = claimAgentTaskResponseSchema.parse({
        task: toAgentTaskSummary(task),
        claim: {
          agentId: request.agentId,
          claimToken,
          claimedAt: task.agentTaskClaim.claimedAt.toISOString(),
          renewedAt: task.agentTaskClaim.renewedAt.toISOString(),
          leaseExpiresAt: task.agentTaskClaim.leaseExpiresAt.toISOString(),
        },
      });
      if (!projectResponse) return response;
      const detail = await getActionable(tx, sourceOrdinal);
      if (!detail) {
        throw new Error("Claim transaction did not return the claimed task.");
      }
      return projectResponse(detail, response.claim);
    });
    return response;
  } catch (error) {
    if (error instanceof AgentTaskClaimError) throw error;
    const current = await findTask(prisma, sourceOrdinal);
    if (
      current?.agentTaskClaim &&
      current.agentTaskClaim.leaseExpiresAt > now
    ) {
      throw new AgentTaskClaimError(
        current.agentTaskClaim.agentId === request.agentId
          ? "OWN_CLAIM_ACTIVE"
          : "ALREADY_CLAIMED",
        current.agentTaskClaim.agentId === request.agentId
          ? "This Actionable already has an active claim owned by the current Codex thread."
          : "This Actionable already has an active claim.",
        undefined,
        current.version,
        current.agentTaskClaim.agentId === request.agentId
          ? undefined
          : current.agentTaskClaim.leaseExpiresAt.toISOString(),
      );
    }
    throw error;
  }
}

export async function recoverAgentTaskClaim(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: RecoverAgentTaskClaimRequest,
  caller: AgentTaskCaller,
  now = new Date(),
): Promise<RecoverAgentTaskClaimResponse> {
  return recoverAgentTaskClaimResult(prisma, sourceOrdinal, input, caller, now);
}

export async function recoverAgentTaskClaimWithProjection<T>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: RecoverAgentTaskClaimRequest,
  caller: AgentTaskCaller,
  projectResponse: (
    task: ActionableDetail,
    claim: RecoverAgentTaskClaimResponse["claim"],
  ) => T,
  now = new Date(),
): Promise<T> {
  return recoverAgentTaskClaimResult(
    prisma,
    sourceOrdinal,
    input,
    caller,
    now,
    projectResponse,
  ) as Promise<T>;
}

async function recoverAgentTaskClaimResult<T = never>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: RecoverAgentTaskClaimRequest,
  caller: AgentTaskCaller,
  now: Date,
  projectResponse?: (
    task: ActionableDetail,
    claim: RecoverAgentTaskClaimResponse["claim"],
  ) => T,
): Promise<RecoverAgentTaskClaimResponse | T> {
  const request = parseInput(recoverAgentTaskClaimRequestSchema, input);
  const agentId = `codex:${caller.threadId}`;
  const claimToken = randomBytes(32).toString("base64url");
  const claimTokenHash = hashToken(claimToken);

  const result = await withClaimLock(String(sourceOrdinal), () =>
    prisma.$transaction(async (tx) => {
      const row = await findTask(tx, sourceOrdinal);
      requireClaimable(row);
      const claim = row.agentTaskClaim;
      if (!claim) {
        throw new AgentTaskClaimError(
          "CLAIM_NOT_FOUND",
          "This Actionable does not have an active claim to recover.",
          undefined,
          row.version,
        );
      }
      if (claim.leaseExpiresAt <= now) {
        await recordObservedExpiry(tx, row, now);
        await tx.actionable.update({
          where: { id: row.id },
          data: {
            version: { increment: 1 },
            updatedLabel: "agent claim expired",
          },
        });
        return { expired: true as const };
      }
      if (claim.agentId !== agentId) {
        throw new AgentTaskClaimError(
          "CLAIM_OWNER_MISMATCH",
          "Only the Codex thread that owns this active claim can recover it.",
          undefined,
          row.version,
          claim.leaseExpiresAt.toISOString(),
        );
      }
      if (row.version !== request.version) {
        throw new AgentTaskClaimError(
          "VERSION_CONFLICT",
          "This Actionable changed after it was listed.",
          undefined,
          row.version,
        );
      }

      const leaseMinutes =
        request.leaseMinutes ??
        (await getAgentCoordinationSettings(tx)).agentClaimLeaseMinutes;
      await tx.agentTaskClaim.update({
        where: { actionableId: row.id },
        data: {
          claimTokenHash,
          leaseExpiresAt: leaseExpiry(now, leaseMinutes),
          renewedAt: now,
        },
      });
      await tx.actionable.update({
        where: { id: row.id },
        data: {
          version: { increment: 1 },
          updatedLabel: "agent claim recovered",
        },
      });
      await tx.activityEvent.create({
        data: {
          actionableId: row.id,
          type: "agent-updated",
          summary: `Recovered claim credential for agent ${agentId}`,
          metadataJson: {
            agentId,
            origin: agentOrigin(agentId),
            operation: "claim-recovery",
          },
          occurredAt: now,
        },
      });
      const task = await findTask(tx, sourceOrdinal);
      if (!task?.agentTaskClaim) {
        throw new Error("Claim recovery did not return the active claim.");
      }
      const response = recoverAgentTaskClaimResponseSchema.parse({
        task: toAgentTaskSummary(task),
        claim: {
          agentId,
          claimToken,
          claimedAt: task.agentTaskClaim.claimedAt.toISOString(),
          renewedAt: task.agentTaskClaim.renewedAt.toISOString(),
          leaseExpiresAt: task.agentTaskClaim.leaseExpiresAt.toISOString(),
        },
      });
      if (projectResponse) {
        const detail = await getActionable(tx, sourceOrdinal);
        if (!detail) {
          throw new Error("Claim recovery did not return the claimed task.");
        }
        return {
          expired: false as const,
          response: projectResponse(detail, response.claim),
        };
      }
      return {
        expired: false as const,
        response,
      };
    }),
  );

  if (result.expired) {
    throw new AgentTaskClaimError(
      "CLAIM_EXPIRED",
      "The claim lease expired and must be reacquired.",
    );
  }
  return result.response;
}

async function renewAgentTaskClaimResult<T = never>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: RenewAgentTaskClaimRequest,
  now = new Date(),
  projectResponse?: (response: RenewAgentTaskClaimResponse) => T,
): Promise<RenewAgentTaskClaimResponse | T> {
  const request = parseInput(renewAgentTaskClaimRequestSchema, input);
  const result = await prisma.$transaction(async (tx) => {
    const row = await findTask(tx, sourceOrdinal);
    const claim = requireValidClaim(row, request.claimToken, now);
    if (claim === "expired") {
      await recordObservedExpiry(tx, row!, now);
      await tx.actionable.update({
        where: { id: row!.id },
        data: {
          version: { increment: 1 },
          updatedLabel: "agent claim expired",
        },
      });
      return { expired: true as const };
    }
    const leaseMinutes =
      request.leaseMinutes ??
      (await getAgentCoordinationSettings(tx)).agentClaimLeaseMinutes;
    await tx.agentTaskClaim.update({
      where: { actionableId: row!.id },
      data: { leaseExpiresAt: leaseExpiry(now, leaseMinutes) },
    });
    const task = await findTask(tx, sourceOrdinal);
    if (!task) throw new Error("Renewed agent task could not be read.");
    const response = renewAgentTaskClaimResponseSchema.parse({
      task: toAgentTaskSummary(task),
    });
    return {
      expired: false as const,
      response: projectResponse ? projectResponse(response) : response,
    };
  });
  if (result.expired) {
    throw new AgentTaskClaimError(
      "CLAIM_EXPIRED",
      "The claim lease expired and must be reacquired.",
    );
  }
  return result.response;
}

export function renewAgentTaskClaim(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: RenewAgentTaskClaimRequest,
  now = new Date(),
): Promise<RenewAgentTaskClaimResponse> {
  return renewAgentTaskClaimResult(
    prisma,
    sourceOrdinal,
    input,
    now,
  ) as Promise<RenewAgentTaskClaimResponse>;
}

export function renewAgentTaskClaimWithProjection<T>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: RenewAgentTaskClaimRequest,
  projectResponse: (response: RenewAgentTaskClaimResponse) => T,
  now = new Date(),
): Promise<T> {
  return renewAgentTaskClaimResult(
    prisma,
    sourceOrdinal,
    input,
    now,
    projectResponse,
  ) as Promise<T>;
}

async function releaseAgentTaskClaimResult<T = never>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ReleaseAgentTaskClaimRequest,
  now = new Date(),
  projectResponse?: (response: ReleaseAgentTaskClaimResponse) => T,
): Promise<ReleaseAgentTaskClaimResponse | T> {
  const request = parseInput(releaseAgentTaskClaimRequestSchema, input);
  const result = await prisma.$transaction(async (tx) => {
    const row = await findTask(tx, sourceOrdinal);
    const claim = requireValidClaim(row, request.claimToken, now);
    if (claim === "expired") {
      await recordObservedExpiry(tx, row!, now);
      await tx.actionable.update({
        where: { id: row!.id },
        data: {
          version: { increment: 1 },
          updatedLabel: "agent claim expired",
        },
      });
      return { expired: true as const };
    }
    await tx.agentTaskClaim.delete({ where: { actionableId: row!.id } });
    await tx.actionable.update({
      where: { id: row!.id },
      data: { version: { increment: 1 }, updatedLabel: "agent release" },
    });
    await tx.activityEvent.create({
      data: {
        actionableId: row!.id,
        type: "agent-released",
        summary: `Released by agent ${claim.agentId}`,
        metadataJson: { agentId: claim.agentId },
        occurredAt: now,
      },
    });
    const task = await findTask(tx, sourceOrdinal);
    if (!task) throw new Error("Released agent task could not be read.");
    const response = releaseAgentTaskClaimResponseSchema.parse({
      task: toAgentTaskSummary(task),
    });
    return {
      expired: false as const,
      response: projectResponse ? projectResponse(response) : response,
    };
  });
  if (result.expired) {
    throw new AgentTaskClaimError(
      "CLAIM_EXPIRED",
      "The claim lease expired and must be reacquired.",
    );
  }
  return result.response;
}

export function releaseAgentTaskClaim(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ReleaseAgentTaskClaimRequest,
  now = new Date(),
): Promise<ReleaseAgentTaskClaimResponse> {
  return releaseAgentTaskClaimResult(
    prisma,
    sourceOrdinal,
    input,
    now,
  ) as Promise<ReleaseAgentTaskClaimResponse>;
}

export function releaseAgentTaskClaimWithProjection<T>(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ReleaseAgentTaskClaimRequest,
  projectResponse: (response: ReleaseAgentTaskClaimResponse) => T,
  now = new Date(),
): Promise<T> {
  return releaseAgentTaskClaimResult(
    prisma,
    sourceOrdinal,
    input,
    now,
    projectResponse,
  ) as Promise<T>;
}

export async function forceReleaseAgentTaskClaim(
  prisma: AppPrismaClient,
  sourceOrdinal: number,
  input: ForceReleaseAgentClaimRequest,
  now = new Date(),
): Promise<ActionableDetail> {
  const request = parseInput(forceReleaseAgentClaimRequestSchema, input);
  return withClaimLock(String(sourceOrdinal), () =>
    prisma.$transaction(async (tx) => {
      const row = await findTask(tx, sourceOrdinal);
      if (!row) {
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      }
      const current = await getActionable(tx, sourceOrdinal);
      if (!current) {
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      }
      if (row.version !== request.version) {
        throw new VersionConflictError(current);
      }
      if (!row.agentTaskClaim) {
        throw new AgentClaimReleaseConflictError("CLAIM_NOT_FOUND", current);
      }
      if (
        row.agentTaskClaim.agentId !== request.agentId ||
        row.agentTaskClaim.claimedAt.toISOString() !== request.claimedAt
      ) {
        throw new AgentClaimReleaseConflictError("CLAIM_CHANGED", current);
      }
      const deleted = await tx.agentTaskClaim.deleteMany({
        where: {
          actionableId: row.id,
          agentId: request.agentId,
          claimedAt: new Date(request.claimedAt),
        },
      });
      if (deleted.count !== 1) {
        const latest = await getActionable(tx, sourceOrdinal);
        if (!latest) {
          throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
        }
        throw new AgentClaimReleaseConflictError("CLAIM_CHANGED", latest);
      }
      await tx.actionable.update({
        where: { id: row.id },
        data: {
          version: { increment: 1 },
          updatedLabel: "agent claim force released",
        },
      });
      await tx.activityEvent.create({
        data: {
          actionableId: row.id,
          type: "agent-released",
          summary: `Force-released by user from agent ${row.agentTaskClaim.agentId}`,
          metadataJson: {
            agentId: row.agentTaskClaim.agentId,
            claimedAt: row.agentTaskClaim.claimedAt.toISOString(),
            origin: "user",
            operation: "force-release",
          },
          occurredAt: now,
        },
      });
      const released = await getActionable(tx, sourceOrdinal);
      if (!released) {
        throw new AgentTaskClaimError("NOT_FOUND", "Actionable not found.");
      }
      return released;
    }),
  );
}
