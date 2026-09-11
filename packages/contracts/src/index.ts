import { z } from "zod";
import {
  codexPromptTemplateSchema,
  defaultCodexResearchPrompt,
  defaultCodexImplementationPrompt,
} from "./codex-prompts.js";

export * from "./codex-prompts.js";

export const defaultWebPort = 4173;
export const defaultApiPort = 4174;
export const loopbackApiHost = "127.0.0.1";

export type ApiRuntimeConfig = {
  apiHost: typeof loopbackApiHost;
  apiPort: number;
  apiOrigin: string;
  mcpEndpoint: string;
};

export type RuntimeConfig = ApiRuntimeConfig & {
  webHost: typeof loopbackApiHost;
  webPort: number;
  webOrigin: string;
  healthEndpoint: string;
};

type RuntimeConfigInput = {
  webPort?: string;
  apiPort?: string;
};

function resolvePort(
  configuredPort: string | undefined,
  environmentVariable: "WEB_PORT" | "API_PORT",
  defaultPort: number,
) {
  const normalizedPort = configuredPort?.trim();
  if (
    configuredPort !== undefined &&
    (!normalizedPort || !/^\d+$/.test(normalizedPort))
  ) {
    throw new Error(
      `${environmentVariable} must be a whole number from 1 through 65535.`,
    );
  }

  const port =
    normalizedPort === undefined ? defaultPort : Number(normalizedPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `${environmentVariable} must be a whole number from 1 through 65535.`,
    );
  }

  return port;
}

export function resolveApiRuntimeConfig(
  configuredPort: string | undefined,
): ApiRuntimeConfig {
  const apiPort = resolvePort(configuredPort, "API_PORT", defaultApiPort);
  const apiOrigin = `http://${loopbackApiHost}:${apiPort}`;
  return {
    apiHost: loopbackApiHost,
    apiPort,
    apiOrigin,
    mcpEndpoint: `${apiOrigin}/mcp`,
  };
}

export function resolveRuntimeConfig({
  webPort: configuredWebPort,
  apiPort: configuredApiPort,
}: RuntimeConfigInput = {}): RuntimeConfig {
  const apiRuntimeConfig = resolveApiRuntimeConfig(configuredApiPort);
  const webPort = resolvePort(configuredWebPort, "WEB_PORT", defaultWebPort);
  const webOrigin = `http://${loopbackApiHost}:${webPort}`;
  return {
    webHost: loopbackApiHost,
    webPort,
    webOrigin,
    healthEndpoint: `${webOrigin}/api/health`,
    ...apiRuntimeConfig,
  };
}

export const prioritySchema = z.enum([
  "Unset",
  "Critical",
  "High",
  "Medium",
  "Low",
  "Backlog",
]);
export const statusSchema = z.enum([
  "Inbox",
  "Researching",
  "Ready",
  "In progress",
  "Blocked",
  "Done",
  "Dismissed",
]);
export const sourceStatusSuggestionSchema = z.enum([
  "Ready",
  "Researching",
  "Blocked",
]);
export const effortSchema = z.enum([
  "Unknown",
  "XS",
  "S",
  "S–M",
  "M",
  "M–L",
  "L",
  "L–XL",
  "XL",
]);
export const evidenceStateSchema = z.enum([
  "Unclassified",
  "Confirmed",
  "Suspected",
  "Proposed",
  "Investigation",
]);

export const sourceFileSchema = z.object({
  path: z.string().min(1).describe("Repository-relative file path."),
  lines: z
    .string()
    .min(1)
    .optional()
    .describe("Optional relevant line or line range."),
  symbol: z
    .string()
    .min(1)
    .optional()
    .describe("Optional relevant symbol name."),
});

export const userSourceReferenceInputSchema = z.object({
  type: z
    .enum(["File", "URL", "Command", "Commit", "Codex thread", "Text"])
    .describe("Kind of source reference."),
  locator: z
    .string()
    .trim()
    .min(1, "Enter a source locator.")
    .describe("Path, URL, command, commit, thread, or text locator."),
  label: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Optional human-readable source label."),
});

export const userSourceReferenceSchema = userSourceReferenceInputSchema.extend({
  id: z.string().min(1),
  provenance: z.enum(["user-added", "agent-added"]),
  createdAt: z.string().datetime(),
});

export const validationTypeSchema = z.enum([
  "Automated test",
  "Manual test",
  "Command",
  "Review",
  "Document",
]);
export const validationOutcomeSchema = z.enum(["Passed", "Failed", "Partial"]);

export const validationRecordSchema = z.object({
  id: z.string().min(1),
  type: validationTypeSchema,
  outcome: validationOutcomeSchema,
  notes: z.string(),
  evidence: z.string(),
  origin: z.string().min(1),
  recordedAt: z.string().datetime(),
  supersedesId: z.string().min(1).nullable(),
  supersededById: z.string().min(1).nullable(),
  qualifiesForCompletion: z.boolean(),
});

export const activityTypeSchema = z.enum([
  "status-transition",
  "manual-blocked",
  "validation-recorded",
  "validation-corrected",
  "completion-validated",
  "completion-overridden",
  "dismissed",
  "reopened",
  "research-reopened",
  "source-added",
  "source-removed",
  "hierarchy-attached",
  "hierarchy-detached",
  "hierarchy-reassigned",
  "task-breakdown-created",
  "dependency-added",
  "dependency-removed",
  "dependency-waived",
  "dependency-restored",
  "parent-auto-reopened",
  "archived",
  "restored",
  "scope-archived",
  "scope-restored",
  "agent-claimed",
  "agent-released",
  "agent-claim-expired",
  "agent-updated",
]);

export const activityEventSchema = z.object({
  id: z.string().min(1),
  type: activityTypeSchema,
  summary: z.string().min(1),
  context: z.record(z.string(), z.string()),
  occurredAt: z.string().datetime(),
});

export const statusProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("neutral-import"),
    note: z.string().min(1),
    suggestedStatus: sourceStatusSuggestionSchema.optional(),
  }),
  z.object({
    kind: z.literal("user-authored"),
    note: z.string().min(1),
  }),
]);

export const scopeSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  repositoryId: z.string().min(1),
  repositoryName: z.string().min(1),
  worktreeId: z.string().min(1),
  worktreeName: z.string().min(1),
});

export const archiveStateSchema = z.object({
  isArchived: z.boolean(),
  directlyArchived: z.boolean(),
  archivedAt: z.string().datetime().nullable(),
  inheritedFrom: z.array(z.enum(["project", "repository", "worktree"])),
});

export const statusHistoryEntrySchema = z.object({
  id: z.string().min(1),
  previousStatus: statusSchema.nullable(),
  newStatus: statusSchema,
  origin: z.string().min(1),
  occurredAt: z.string().datetime(),
});

export const immutableSourceEvidenceSchema = z.object({
  imported: z.boolean(),
  sourceThread: z.string(),
  sourceFiles: z.array(sourceFileSchema),
  rawSource: z.unknown().optional(),
  note: z.string().min(1),
});

export const relatedActionableSchema = z.object({
  id: z.number().int().positive(),
  recordId: z.string().min(1),
  title: z.string().min(1),
  status: statusSchema,
  version: z.number().int().positive(),
  scope: scopeSchema,
  archiveState: archiveStateSchema,
});

export const hierarchyRelationshipSchema = z.object({
  id: z.string().min(1),
  parent: relatedActionableSchema,
  child: relatedActionableSchema,
  createdAt: z.string().datetime(),
});

export const dependencyStateSchema = z.enum([
  "satisfied",
  "unresolved",
  "waived",
  "dismissed-prerequisite",
]);

export const dependencyRelationshipSchema = z.object({
  id: z.string().min(1),
  dependent: relatedActionableSchema,
  prerequisite: relatedActionableSchema,
  state: dependencyStateSchema,
  isSatisfied: z.boolean(),
  waiverReason: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const readyRequirementSchema = z.enum([
  "researchPhase",
  "finding",
  "description",
  "research",
  "plannedValidation",
]);

export const actionableReadinessSchema = z
  .object({
    requiredForReady: z.array(readyRequirementSchema).max(5),
    blockers: z
      .array(
        z
          .object({
            field: readyRequirementSchema,
            message: z.string().min(1).max(240),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();

export const actionableSummarySchema = z.object({
  id: z.number().int().positive(),
  recordId: z.string().min(1),
  externalKey: z.string().min(1),
  title: z.string().min(1),
  priority: prioritySchema,
  status: statusSchema,
  statusProvenance: statusProvenanceSchema,
  scope: scopeSchema,
  worktree: z.string().min(1),
  effort: effortSchema,
  evidenceState: evidenceStateSchema,
  version: z.number().int().positive(),
  updated: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finding: z.string(),
  tags: z.array(z.string()),
  manualBlocker: z.string().nullable(),
  isDependencyBlocked: z.boolean(),
  isEffectivelyBlocked: z.boolean(),
  unresolvedDependencyCount: z.number().int().nonnegative(),
  dependencyCount: z.number().int().nonnegative(),
  blocksCount: z.number().int().nonnegative(),
  hasQualifyingValidation: z.boolean(),
  wasReopened: z.boolean(),
  archiveState: archiveStateSchema,
  blockedBy: z.array(z.number().int().positive()).optional(),
  blocks: z.array(z.number().int().positive()).optional(),
  parentId: z.number().int().positive().optional(),
  childIds: z.array(z.number().int().positive()).optional(),
  childCompletion: z
    .object({
      terminal: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .optional(),
});

export const actionableDetailSchema = actionableSummarySchema.extend({
  workspacePath: z.string().max(4_096).nullable(),
  agentClaim: z
    .object({
      agentId: z.string().min(1).max(120),
      claimedAt: z.string().datetime(),
      renewedAt: z.string().datetime(),
      leaseExpiresAt: z.string().datetime(),
      state: z.enum(["active", "expired"]),
      isReleasable: z.boolean(),
    })
    .strict()
    .nullable(),
  description: z.string(),
  resolution: z.string(),
  research: z.array(z.string()),
  validation: z.array(z.string()),
  userSources: z.array(userSourceReferenceSchema),
  immutableSourceEvidence: immutableSourceEvidenceSchema,
  files: z.array(sourceFileSchema),
  sourceThread: z.string(),
  readiness: actionableReadinessSchema,
  permittedTransitions: z.array(statusSchema),
  statusHistory: z.array(statusHistoryEntrySchema),
  validationRecords: z.array(validationRecordSchema),
  activity: z.array(activityEventSchema),
  completionEligibility: z.object({
    qualifyingValidationRecordId: z.string().min(1).nullable(),
    policy: z.string().min(1),
  }),
  relationships: z.object({
    parent: hierarchyRelationshipSchema.nullable(),
    subtasks: z.array(hierarchyRelationshipSchema),
    blockedBy: z.array(dependencyRelationshipSchema),
    blocks: z.array(dependencyRelationshipSchema),
  }),
});

export const actionablesListResponseSchema = z.object({
  project: z.object({
    name: z.string().min(1),
  }),
  repository: z.object({
    name: z.string().min(1),
  }),
  worktree: z.object({
    name: z.string().min(1),
  }),
  counts: z.object({
    total: z.number().int().nonnegative(),
    topLevel: z.number().int().nonnegative(),
  }),
  result: z.object({
    matched: z.number().int().nonnegative(),
    scopeTotal: z.number().int().nonnegative(),
    openScopeTotal: z.number().int().nonnegative(),
    topLevel: z.number().int().nonnegative(),
    nested: z.number().int().nonnegative(),
    normalizedQuery: z.record(z.string(), z.string()),
  }),
  items: z.array(actionableSummarySchema),
});

export const actionableDetailResponseSchema = z.object({
  item: actionableDetailSchema,
});

export const scopeOptionsResponseSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      version: z.number().int().positive(),
      archivedAt: z.string().datetime().nullable(),
      archiveState: archiveStateSchema,
      repositories: z.array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          version: z.number().int().positive(),
          archivedAt: z.string().datetime().nullable(),
          archiveState: archiveStateSchema,
          worktrees: z.array(
            z.object({
              id: z.string().min(1),
              name: z.string().min(1),
              version: z.number().int().positive(),
              archivedAt: z.string().datetime().nullable(),
              archiveState: archiveStateSchema,
            }),
          ),
        }),
      ),
    }),
  ),
});

const repositoryDetailsRequestSchema = z.object({
  name: z.string().trim().min(1, "Enter a repository name.").max(240),
  localPath: z
    .string()
    .trim()
    .min(1, "Enter the local repository path.")
    .max(4_096)
    .refine(
      (value) => /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value),
      "Enter an absolute Windows path.",
    ),
});

export const createRepositoryRequestSchema = z.discriminatedUnion(
  "projectMode",
  [
    repositoryDetailsRequestSchema
      .extend({
        projectMode: z.literal("existing"),
        projectId: z.string().min(1, "Choose a project."),
      })
      .strict(),
    repositoryDetailsRequestSchema
      .extend({
        projectMode: z.literal("new"),
        projectName: z.string().trim().min(1, "Enter a project name.").max(240),
      })
      .strict(),
  ],
);

export const createRepositoryResponseSchema = z.object({
  projectId: z.string().min(1),
  repositoryId: z.string().min(1),
  worktreeId: z.string().min(1),
  scopes: scopeOptionsResponseSchema,
});

export const repositoryFolderPickerResponseSchema = z
  .object({
    path: z.string().min(1).max(4_096).nullable(),
  })
  .strict();

export const actionableSortSchema = z.enum([
  "priority",
  "updated-desc",
  "updated-asc",
  "created-desc",
  "title",
  "status",
  "effort",
]);
export const archivedFilterSchema = z.enum(["active", "archived", "all"]);
export const parentFilterSchema = z.enum(["all", "top-level", "subtasks"]);
export const booleanFilterSchema = z.enum(["all", "yes", "no"]);
export const actionableStatusFilterSchema = statusSchema.or(
  z.enum(["active", "all"]),
);
export const actionableExcludeFilterKeys = [
  "status",
  "manualBlocked",
  "dependencyBlocked",
  "priority",
  "effort",
  "evidence",
  "tag",
  "parent",
  "validation",
  "reopened",
] as const;
export type ActionableExcludeFilterKey =
  (typeof actionableExcludeFilterKeys)[number];

export function parseActionableExcludeFilterKeys(value?: string) {
  const requested = new Set(
    (value ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
  );
  return actionableExcludeFilterKeys.filter((key) => requested.has(key));
}

export const actionableQuerySchema = z.object({
  project: z.string().default(""),
  repository: z.string().default(""),
  worktree: z.string().default(""),
  status: actionableStatusFilterSchema.default("active"),
  manualBlocked: booleanFilterSchema.default("all"),
  dependencyBlocked: booleanFilterSchema.default("all"),
  priority: prioritySchema.optional(),
  effort: effortSchema.optional(),
  evidence: evidenceStateSchema.optional(),
  tag: z.string().default(""),
  archived: archivedFilterSchema.default("active"),
  parent: parentFilterSchema.default("all"),
  validation: booleanFilterSchema.default("all"),
  reopened: booleanFilterSchema.default("all"),
  exclude: z
    .string()
    .default("")
    .transform((value) => parseActionableExcludeFilterKeys(value).join(",")),
  q: z.string().trim().max(500).default(""),
  sort: actionableSortSchema.default("priority"),
});

type ActionableExcludeFilterQuery = Partial<
  Record<ActionableExcludeFilterKey | "exclude", string>
>;

export function isActionableExcludeFilterActive(
  query: ActionableExcludeFilterQuery,
  key: ActionableExcludeFilterKey,
) {
  if (key === "status") return (query.status ?? "active") !== "all";
  if (key === "manualBlocked")
    return Boolean(query.manualBlocked && query.manualBlocked !== "all");
  if (key === "dependencyBlocked")
    return Boolean(
      query.dependencyBlocked && query.dependencyBlocked !== "all",
    );
  if (key === "parent") return Boolean(query.parent && query.parent !== "all");
  if (key === "validation")
    return Boolean(query.validation && query.validation !== "all");
  if (key === "reopened")
    return Boolean(query.reopened && query.reopened !== "all");
  return Boolean(query[key]);
}

export function activeActionableExcludeFilterKeys(
  query: ActionableExcludeFilterQuery,
) {
  return parseActionableExcludeFilterKeys(query.exclude).filter((key) =>
    isActionableExcludeFilterActive(query, key),
  );
}

export const dashboardQueueKeySchema = z.enum([
  "inbox",
  "researching",
  "ready",
  "in-progress",
  "manual-blocked",
  "dependency-blocked",
  "awaiting-validation",
  "recently-updated",
  "recently-completed",
  "reopened",
]);

export const dashboardQueueSchema = z.object({
  key: dashboardQueueKeySchema,
  label: z.string().min(1),
  description: z.string().min(1),
  count: z.number().int().nonnegative(),
  query: z.record(z.string(), z.string()),
  items: z.array(actionableSummarySchema),
});

export const dashboardAlertKeySchema = z.enum([
  "expiring-claims",
  "blocked-work",
  "missing-validation",
  "abandoned-sessions",
]);

export const dashboardAlertItemSchema = z.object({
  actionable: actionableSummarySchema,
  detail: z.string().min(1),
  dueAt: z.string().datetime().nullable(),
});

export const dashboardAlertSchema = z.object({
  key: dashboardAlertKeySchema,
  label: z.string().min(1),
  description: z.string().min(1),
  tone: z.enum(["warning", "critical"]),
  count: z.number().int().nonnegative(),
  items: z.array(dashboardAlertItemSchema),
});

export const dashboardResponseSchema = z.object({
  counts: z.object({
    total: z.number().int().nonnegative(),
    topLevel: z.number().int().nonnegative(),
    nested: z.number().int().nonnegative(),
  }),
  alerts: z.array(dashboardAlertSchema),
  queues: z.array(dashboardQueueSchema),
});

export const agentIdSchema = z
  .string()
  .trim()
  .min(1, "Enter an agent ID.")
  .max(120)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/,
    "Use letters, numbers, and . _ : @ / - only.",
  )
  .describe("Stable ID for this agent task session.");
export const agentTaskLeaseMinutesSchema = z
  .number()
  .int()
  .min(5)
  .max(120)
  .describe("Claim lease duration in minutes, from 5 through 120.");
export const agentClaimExpiryWarningMinutesSchema = z
  .number()
  .int()
  .min(1)
  .max(119)
  .describe("Expiring-claim warning window in minutes, from 1 through 119.");
export const agentTaskListViewSchema = z
  .enum(["available", "mine"])
  .describe("Use mine for owned claims or available within one work item.");

export const agentTaskSummaryChildIdsLimit = 100;

export const agentTaskSummarySchema = z
  .object({
    id: z.number().int().positive(),
    recordId: z.string().min(1),
    workItemId: z.number().int().positive(),
    parentId: z.number().int().positive().nullable(),
    childIds: z
      .array(z.number().int().positive())
      .max(agentTaskSummaryChildIdsLimit),
    childCount: z.number().int().nonnegative(),
    title: z.string().min(1).max(240),
    findingExcerpt: z.string().max(300),
    tags: z.array(z.string().min(1).max(60)).max(10),
    priority: prioritySchema,
    status: statusSchema,
    effort: effortSchema,
    evidenceState: evidenceStateSchema,
    isEffectivelyBlocked: z.boolean(),
    unresolvedDependencyCount: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    scope: scopeSchema,
    updatedAt: z.string().datetime(),
    readiness: actionableReadinessSchema,
    claim: z
      .object({
        agentId: agentIdSchema,
        claimedAt: z.string().datetime(),
        renewedAt: z.string().datetime(),
        leaseExpiresAt: z.string().datetime(),
      })
      .nullable(),
  })
  .strict();

export const agentTaskWorkItemStateSchema = z
  .object({
    id: z.number().int().positive(),
    status: statusSchema,
    terminal: z.boolean(),
  })
  .strict();

export const listAgentTasksRequestSchema = z
  .object({
    agentId: agentIdSchema,
    view: agentTaskListViewSchema.default("mine"),
    workItemId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Top-level Actionable ID for the current feature or bug; required for available.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Maximum tasks to return, from 1 through 100."),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.view === "available" && input.workItemId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["workItemId"],
        message:
          "Available tasks require the top-level feature or bug work-item ID.",
      });
    }
  });

export const listAgentTasksResponseSchema = z
  .object({
    items: z.array(agentTaskSummarySchema).max(100),
    hasMore: z.boolean(),
    workItem: agentTaskWorkItemStateSchema.nullable(),
  })
  .strict();

export const agentTaskVersionRecoveryMessage =
  "Use task.version from the preceding successful result, or re-list the task to obtain its current positive integer version.";
export const agentTaskClaimTokenRecoveryMessage =
  "Use claim.claimToken returned by claim_task or recover_task_claim; if it was discarded, list mine and recover the claim.";
export const agentTaskDirectPlacementRecoveryMessage =
  "For one direct task or sibling, set both parentId and workItemId to the same authorized top-level Actionable ID; omit both for a top-level task.";
export const agentTaskHandoffContentRecoveryMessage =
  "Provide at least one of finding, addFiles, appendResearch, appendPlannedValidation, or validation. If no task content needs to change, call actionables.release_task instead.";

export const agentTaskVersionInputSchema = z
  .number({ error: agentTaskVersionRecoveryMessage })
  .int({ error: agentTaskVersionRecoveryMessage })
  .positive({ error: agentTaskVersionRecoveryMessage });
export const agentTaskClaimTokenInputSchema = z
  .string({ error: agentTaskClaimTokenRecoveryMessage })
  .min(32, { error: agentTaskClaimTokenRecoveryMessage })
  .max(256, { error: agentTaskClaimTokenRecoveryMessage });

export const claimAgentTaskRequestSchema = z
  .object({
    agentId: agentIdSchema,
    workItemId: z
      .number()
      .int()
      .positive()
      .describe("Top-level Actionable ID for the current feature or bug."),
    version: agentTaskVersionInputSchema.describe(
      "Exact task version returned by list_tasks.",
    ),
    leaseMinutes: agentTaskLeaseMinutesSchema
      .optional()
      .describe(
        "Optional claim lease duration; omit to use the saved default.",
      ),
  })
  .strict();

export const agentTaskClaimCredentialSchema = z
  .object({
    agentId: agentIdSchema,
    claimToken: z.string().min(32).max(256),
    claimedAt: z.string().datetime(),
    renewedAt: z.string().datetime(),
    leaseExpiresAt: z.string().datetime(),
  })
  .strict();

export const claimAgentTaskResponseSchema = z
  .object({
    task: agentTaskSummarySchema,
    claim: agentTaskClaimCredentialSchema,
  })
  .strict();

export const recoverAgentTaskClaimRequestSchema = z
  .object({
    version: agentTaskVersionInputSchema.describe(
      "Current task version returned by list_tasks(view: mine).",
    ),
    leaseMinutes: agentTaskLeaseMinutesSchema
      .optional()
      .describe(
        "Optional recovered-claim lease duration; omit to use the saved default.",
      ),
  })
  .strict();

export const recoverAgentTaskClaimResponseSchema = claimAgentTaskResponseSchema;

export const renewAgentTaskClaimRequestSchema = z
  .object({
    claimToken: agentTaskClaimTokenInputSchema.describe(
      "Secret claim token returned by claim_task.",
    ),
    leaseMinutes: agentTaskLeaseMinutesSchema
      .optional()
      .describe(
        "Optional renewal lease duration; omit to use the saved default.",
      ),
  })
  .strict();

export const renewAgentTaskClaimResponseSchema = z
  .object({
    task: agentTaskSummarySchema,
  })
  .strict();

export const releaseAgentTaskClaimRequestSchema = z
  .object({
    claimToken: agentTaskClaimTokenInputSchema.describe(
      "Secret claim token returned by claim_task.",
    ),
  })
  .strict();

export const releaseAgentTaskClaimResponseSchema = z
  .object({
    task: agentTaskSummarySchema,
  })
  .strict();

export const forceReleaseAgentClaimRequestSchema = z
  .object({
    version: z.number().int().positive(),
    agentId: agentIdSchema,
    claimedAt: z.string().datetime(),
  })
  .strict();

export const archiveMutationRequestSchema = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();

export const archiveTargetKindSchema = z.enum([
  "actionable",
  "project",
  "repository",
  "worktree",
]);

export const archiveImpactResponseSchema = z.object({
  target: z.object({
    kind: archiveTargetKindSchema,
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.number().int().positive(),
    directlyArchived: z.boolean(),
  }),
  counts: z.object({
    activeSubtasks: z.number().int().nonnegative(),
    descendants: z.number().int().nonnegative(),
    blocks: z.number().int().nonnegative(),
    unresolvedPrerequisites: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string().min(1)),
});

const titleField = z.string().trim().min(1, "Enter a title.").max(240);
const markdownField = z.string().trim().max(100_000);
const notesSchema = z.array(z.string().trim().min(1)).max(200);
const tagSchema = z.string().trim().min(1, "Provide a nonblank tag.").max(60);
const tagsSchema = z.array(tagSchema).max(30);

export const createActionableRequestSchema = z
  .object({
    title: titleField,
    priority: prioritySchema.default("Unset"),
    effort: effortSchema.default("Unknown"),
    evidenceState: evidenceStateSchema.default("Unclassified"),
    projectId: z.string().min(1, "Choose a project."),
    repositoryId: z.string().min(1, "Choose a repository."),
    worktreeId: z.string().min(1, "Choose a worktree."),
    finding: markdownField,
    description: markdownField,
    resolution: markdownField.optional(),
    research: notesSchema.default([]),
    validation: notesSchema.default([]),
    tags: tagsSchema.default([]),
    userSources: z.array(userSourceReferenceInputSchema).max(50).default([]),
  })
  .strict();

export const updateActionableRequestSchema = createActionableRequestSchema
  .extend({
    version: z.number().int().positive(),
    status: statusSchema,
  })
  .strict();

export const groomActionableNotesRequestSchema = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();

const helperAgentPromptSchema = z.string().trim().min(1).max(20_000);

export const defaultLocalCodexTimeoutSeconds = 120;
export const minimumLocalCodexTimeoutSeconds = 30;
export const maximumLocalCodexTimeoutSeconds = 900;
export const defaultInboxTriageBatchSize = 5;
export const minimumInboxTriageBatchSize = 1;
export const maximumInboxTriageBatchSize = 50;
export const localCodexTimeoutSecondsSchema = z
  .number()
  .int()
  .min(minimumLocalCodexTimeoutSeconds)
  .max(maximumLocalCodexTimeoutSeconds)
  .describe(
    `Local Codex request timeout in seconds, from ${minimumLocalCodexTimeoutSeconds} through ${maximumLocalCodexTimeoutSeconds}.`,
  );

export const noteGroomerModels = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
export const noteGroomerModelSchema = z.enum(noteGroomerModels);

export const assistantReasoningEfforts = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const assistantReasoningEffortSchema = z.enum(assistantReasoningEfforts);

const helperAgentSettingsBaseSchema = z
  .object({
    codexResearchPrompt: codexPromptTemplateSchema.default(
      defaultCodexResearchPrompt,
    ),
    codexImplementationPrompt: codexPromptTemplateSchema.default(
      defaultCodexImplementationPrompt,
    ),
    agentClaimLeaseMinutes: agentTaskLeaseMinutesSchema,
    agentClaimExpiryWarningMinutes: agentClaimExpiryWarningMinutesSchema,
    localCodexTimeoutSeconds: localCodexTimeoutSecondsSchema.nullable(),
    localCodexEffectiveTimeoutSeconds: localCodexTimeoutSecondsSchema,
    inboxTriagerBatchSize: z
      .number()
      .int()
      .min(minimumInboxTriageBatchSize)
      .max(maximumInboxTriageBatchSize),
    inboxTriagerEnabled: z.boolean(),
    inboxTriagerModel: noteGroomerModelSchema.nullable(),
    inboxTriagerReasoningEffort: assistantReasoningEffortSchema.nullable(),
    inboxTriagerEffectiveModel: z.string().trim().min(1).max(200),
    inboxTriagerPrompt: helperAgentPromptSchema,
    noteGroomerEnabled: z.boolean(),
    noteGroomerModel: noteGroomerModelSchema.nullable(),
    noteGroomerReasoningEffort: assistantReasoningEffortSchema.nullable(),
    noteGroomerEffectiveModel: z.string().trim().min(1).max(200),
    noteGroomerPrompt: helperAgentPromptSchema,
    relationshipAuditorEnabled: z.boolean(),
    relationshipAuditorModel: noteGroomerModelSchema.nullable(),
    relationshipAuditorReasoningEffort:
      assistantReasoningEffortSchema.nullable(),
    relationshipAuditorEffectiveModel: z.string().trim().min(1).max(200),
    relationshipAuditorPrompt: helperAgentPromptSchema,
    version: z.number().int().positive(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

function validateAgentCoordinationSettings(
  input: {
    agentClaimLeaseMinutes: number;
    agentClaimExpiryWarningMinutes: number;
  },
  context: z.RefinementCtx,
) {
  if (input.agentClaimExpiryWarningMinutes >= input.agentClaimLeaseMinutes) {
    context.addIssue({
      code: "custom",
      path: ["agentClaimExpiryWarningMinutes"],
      message: "The expiry warning must be shorter than the claim lease.",
    });
  }
}

export const helperAgentSettingsSchema =
  helperAgentSettingsBaseSchema.superRefine(validateAgentCoordinationSettings);

export const updateHelperAgentSettingsRequestSchema =
  helperAgentSettingsBaseSchema
    .omit({
      localCodexEffectiveTimeoutSeconds: true,
      inboxTriagerEffectiveModel: true,
      noteGroomerEffectiveModel: true,
      relationshipAuditorEffectiveModel: true,
      updatedAt: true,
    })
    .strict()
    .superRefine(validateAgentCoordinationSettings);

export const agentIntegrationComponentIdSchema = z.enum([
  "mcpServer",
  "agentInstructions",
  "skill",
]);

export const agentIntegrationComponentSchema = z
  .object({
    id: agentIntegrationComponentIdSchema,
    label: z.string().min(1),
    description: z.string().min(1),
    targetPath: z.string().min(1),
    state: z.enum(["missing", "outdated", "installed", "modified"]),
    installed: z.boolean(),
  })
  .strict();

export const agentIntegrationSettingsSchema = z
  .object({
    mcp: z
      .object({
        apiOrigin: z.string().url(),
        endpoint: z.string().url(),
        enabled: z.boolean(),
        bearerTokenEnvironmentVariable: z.literal("ACTIONABLES_MCP_TOKEN"),
      })
      .strict(),
    mcpServer: agentIntegrationComponentSchema,
    agentInstructions: agentIntegrationComponentSchema,
    skill: agentIntegrationComponentSchema,
  })
  .strict();

export const installAgentIntegrationRequestSchema = z
  .object({
    mcpServer: z.boolean(),
    agentInstructions: z.boolean(),
    skill: z.boolean(),
  })
  .strict()
  .refine(
    (input) => input.mcpServer || input.agentInstructions || input.skill,
    {
      message: "Select at least one component to install.",
      path: ["components"],
    },
  );

export const agentIntegrationInstallResultSchema = z
  .object({
    component: agentIntegrationComponentIdSchema,
    outcome: z.enum(["installed", "updated", "already-installed"]),
    message: z.string().min(1),
  })
  .strict();

export const agentIntegrationInstallResponseSchema = z
  .object({
    settings: agentIntegrationSettingsSchema,
    results: z.array(agentIntegrationInstallResultSchema).min(1).max(3),
  })
  .strict();

export const groomActionableNotesProposalSchema = z
  .object({
    description: markdownField.describe(
      "Reorganized description preserving the original meaning.",
    ),
    research: notesSchema.describe(
      "Reorganized research notes containing no invented evidence.",
    ),
    validation: notesSchema.describe(
      "Reorganized planned checks containing no claimed test results.",
    ),
    changes: z
      .array(z.string().trim().min(1).max(500))
      .max(20)
      .describe("Concise summary of formatting and organization changes."),
  })
  .strict();

export const groomActionableNotesResponseSchema = z
  .object({
    basedOnVersion: z.number().int().positive(),
    model: z.string().trim().min(1).max(200),
    proposal: groomActionableNotesProposalSchema,
  })
  .strict();

export const triageInboxQueueRequestSchema = z
  .object({
    project: z.string().min(1).optional(),
    repository: z.string().min(1).optional(),
    worktree: z.string().min(1).optional(),
  })
  .strict();

export const inboxTriageProposalSchema = z
  .object({
    priority: prioritySchema,
    effort: effortSchema,
    evidenceState: evidenceStateSchema,
    finding: markdownField.min(1),
    description: markdownField.min(1),
    validation: notesSchema.min(1),
    tags: tagsSchema,
    changes: z
      .array(z.string().trim().min(1).max(500))
      .min(1)
      .max(20)
      .describe("Concise summary of the completed triage changes."),
  })
  .strict();

export const inboxTriageItemResultSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string().trim().min(1).max(240),
    outcome: z.enum(["triaged", "skipped", "failed"]),
    message: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const inboxTriageBatchResponseSchema = z
  .object({
    outcome: z.enum(["completed", "empty", "partial", "failed"]),
    requestedLimit: z.number().int().positive(),
    selectedCount: z.number().int().nonnegative(),
    triagedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    results: z
      .array(inboxTriageItemResultSchema)
      .max(maximumInboxTriageBatchSize),
  })
  .strict();

export const auditActionableRelationshipsRequestSchema = z
  .object({
    version: z.number().int().positive(),
  })
  .strict();

export const relationshipAuditRecommendationSchema = z
  .object({
    kind: z.enum(["hierarchy", "dependency"]),
    action: z.enum(["add", "remove", "review"]),
    fromId: z
      .number()
      .int()
      .positive()
      .describe(
        "Parent ID for hierarchy; dependent ID for dependency recommendations.",
      ),
    toId: z
      .number()
      .int()
      .positive()
      .describe(
        "Child ID for hierarchy; prerequisite ID for dependency recommendations.",
      ),
    confidence: z.enum(["low", "medium", "high"]),
    reason: z.string().trim().min(1).max(2_000),
    evidence: z.array(z.string().trim().min(1).max(1_000)).max(10),
  })
  .strict();

export const relationshipAuditProposalSchema = z
  .object({
    recommendations: z.array(relationshipAuditRecommendationSchema).max(50),
  })
  .strict();

export const relationshipAuditResponseSchema = z
  .object({
    workItemId: z.number().int().positive(),
    basedOnVersion: z.number().int().positive(),
    model: z.string().trim().min(1).max(200),
    auditedTaskIds: z.array(z.number().int().positive()).min(1).max(51),
    recommendations: z.array(relationshipAuditRecommendationSchema).max(50),
  })
  .strict();

export const statusTransitionRequestSchema = z
  .object({
    version: z.number().int().positive(),
    status: statusSchema,
    reason: z.string().trim().max(10_000).optional(),
    completionOverrideReason: z.string().trim().max(10_000).optional(),
    origin: z.literal("user").default("user"),
  })
  .strict();

export const createValidationRecordRequestSchema = z
  .object({
    version: z.number().int().positive(),
    type: validationTypeSchema,
    outcome: validationOutcomeSchema,
    notes: z.string().trim().max(100_000).default(""),
    evidence: z.string().trim().max(100_000).default(""),
    origin: z.literal("user").default("user"),
    supersedesId: z.string().trim().min(1).optional(),
  })
  .strict();

const claimedAgentMutationFields = {
  claimToken: agentTaskClaimTokenInputSchema.describe(
    "Secret claim token returned by claim_task.",
  ),
  version: agentTaskVersionInputSchema.describe(
    "Latest task version returned by the preceding operation.",
  ),
};

export const updateClaimedAgentTaskRequestSchema = z
  .object({
    ...claimedAgentMutationFields,
    title: titleField.optional().describe("Replace the task title."),
    priority: prioritySchema.optional().describe("Replace task priority."),
    effort: effortSchema.optional().describe("Replace the effort estimate."),
    evidenceState: evidenceStateSchema
      .optional()
      .describe("Replace the evidence classification."),
    finding: markdownField.optional().describe("Replace the finding Markdown."),
    description: markdownField
      .optional()
      .describe("Replace the intended-result Markdown."),
    resolution: markdownField
      .optional()
      .describe(
        "Replace the Resolution Markdown describing completed changes and important implementation decisions.",
      ),
    research: notesSchema
      .optional()
      .describe(
        "Replace all research notes; do not combine with appendResearch.",
      ),
    appendResearch: notesSchema
      .optional()
      .describe(
        "Append exact-deduplicated research notes while preserving existing notes.",
      ),
    plannedValidation: notesSchema
      .optional()
      .describe(
        "Replace all planned validation; do not combine with appendPlannedValidation.",
      ),
    appendPlannedValidation: notesSchema
      .optional()
      .describe("Append planned checks while preserving existing checks."),
    tags: tagsSchema.optional().describe("Replace all task tags."),
    userSources: z
      .array(userSourceReferenceInputSchema)
      .max(50)
      .optional()
      .describe(
        "Replace all source references; do not combine with addUserSources.",
      ),
    addUserSources: z
      .array(userSourceReferenceInputSchema)
      .max(50)
      .optional()
      .describe("Add new exact-deduplicated source references."),
  })
  .strict()
  .superRefine((input, context) => {
    for (const [replaceField, appendField] of [
      ["research", "appendResearch"],
      ["plannedValidation", "appendPlannedValidation"],
      ["userSources", "addUserSources"],
    ] as const) {
      if (
        input[replaceField] !== undefined &&
        input[appendField] !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: [appendField],
          message: `Use either ${replaceField} or ${appendField}, not both.`,
        });
      }
    }
  })
  .refine(
    (input) =>
      [
        "title",
        "priority",
        "effort",
        "evidenceState",
        "finding",
        "description",
        "resolution",
        "research",
        "appendResearch",
        "plannedValidation",
        "appendPlannedValidation",
        "tags",
        "userSources",
        "addUserSources",
      ].some((field) => input[field as keyof typeof input] !== undefined),
    {
      message: "Provide at least one task field to update.",
      path: ["update"],
    },
  );

export const transitionClaimedAgentTaskRequestSchema = z
  .object({
    ...claimedAgentMutationFields,
    status: statusSchema.describe("Permitted lifecycle status to move into."),
    reason: z
      .string()
      .trim()
      .max(10_000)
      .optional()
      .describe(
        "Required explanation for blocking, dismissal, reopening, or returning In progress work to Researching.",
      ),
  })
  .strict();

export const dismissAgentTaskRequestSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1, "Enter a dismissal reason.")
      .max(10_000)
      .describe("Required reason for dismissing this unclaimed task."),
  })
  .strict();

export const recordClaimedAgentTaskValidationRequestSchema = z
  .object({
    ...claimedAgentMutationFields,
    type: validationTypeSchema.describe("Kind of validation performed."),
    outcome: validationOutcomeSchema.describe("Observed validation outcome."),
    notes: z
      .string()
      .trim()
      .max(100_000)
      .default("")
      .describe("Concise validation notes."),
    evidence: z
      .string()
      .trim()
      .max(100_000)
      .default("")
      .describe("Actual command, result, or other validation evidence."),
    supersedesId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Validation record ID corrected by this new record."),
  })
  .strict();

const handoffValidationSchema = recordClaimedAgentTaskValidationRequestSchema
  .omit({ claimToken: true, version: true })
  .describe("Optional actual validation result to record before release.");

export const handoffClaimedAgentTaskRequestSchema = z
  .object({
    ...claimedAgentMutationFields,
    finding: markdownField
      .optional()
      .describe("Replace the current finding before release."),
    addFiles: z
      .array(sourceFileSchema)
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Add exact-deduplicated file references while preserving existing files.",
      ),
    appendResearch: notesSchema
      .min(1)
      .optional()
      .describe("Append exact-deduplicated research notes before release."),
    appendPlannedValidation: notesSchema
      .min(1)
      .optional()
      .describe("Append planned checks before release."),
    validation: handoffValidationSchema.optional(),
  })
  .strict()
  .describe(agentTaskHandoffContentRecoveryMessage)
  .refine(
    (input) =>
      [
        "finding",
        "addFiles",
        "appendResearch",
        "appendPlannedValidation",
        "validation",
      ].some((field) => input[field as keyof typeof input] !== undefined),
    {
      message: agentTaskHandoffContentRecoveryMessage,
      path: ["handoff"],
    },
  );

export const createSubtaskRequestSchema = z
  .object({
    version: z.number().int().positive(),
    title: titleField,
  })
  .strict();

export const taskBreakdownTemplateSchema = z.enum([
  "bug",
  "feature",
  "research",
  "migration",
]);

export const createTaskBreakdownRequestSchema = z
  .object({
    version: z.number().int().positive(),
    template: taskBreakdownTemplateSchema,
  })
  .strict();

export const createAgentTaskRequestSchema = z
  .object({
    idempotencyKey: z
      .string()
      .uuid()
      .describe(
        "Caller-generated UUID; reuse it only when retrying this exact creation request.",
      ),
    parentId: z
      .number({ error: agentTaskDirectPlacementRecoveryMessage })
      .int({ error: agentTaskDirectPlacementRecoveryMessage })
      .positive({ error: agentTaskDirectPlacementRecoveryMessage })
      .optional()
      .describe(
        "Optional parent Actionable ID. For a direct task, set both parentId and workItemId to the same authorized top-level Actionable; omit both for a top-level task.",
      ),
    workItemId: z
      .number({ error: agentTaskDirectPlacementRecoveryMessage })
      .int({ error: agentTaskDirectPlacementRecoveryMessage })
      .positive({ error: agentTaskDirectPlacementRecoveryMessage })
      .optional()
      .describe(
        "Top-level feature or bug Actionable that authorizes direct-task creation. For a direct task, set it to the same top-level Actionable as parentId.",
      ),
    projectId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Project ID; required only for a top-level task."),
    repositoryId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Repository ID; required only for a top-level task."),
    worktreeId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Worktree ID; required with projectId and repositoryId for an existing top-level scope.",
      ),
    repositoryPath: z
      .string()
      .trim()
      .min(1, "Enter the local repository path.")
      .max(4_096)
      .refine(
        (value) => /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value),
        "Enter an absolute Windows path.",
      )
      .optional()
      .describe(
        "Local Git repository or worktree path used to resolve or provision a top-level scope.",
      ),
    ensureScope: z
      .literal(true)
      .optional()
      .describe(
        "Set true with repositoryPath to create missing project, repository, or worktree scope records.",
      ),
    title: titleField.describe("Clear title for the new task."),
    priority: prioritySchema
      .exclude(["Unset"], {
        error: "Choose a deliberate priority other than Unset.",
      })
      .describe("Required deliberate task priority; Unset is not allowed."),
    description: markdownField
      .default("")
      .describe("Optional intended-result Markdown."),
    effort: effortSchema
      .exclude(["Unknown"], {
        error: "Choose a deliberate effort estimate other than Unknown.",
      })
      .describe("Required deliberate effort estimate; Unknown is not allowed."),
    plannedValidation: notesSchema
      .default([])
      .describe("Optional checks planned for this task."),
    tags: z
      .array(tagSchema, { error: "Provide at least one meaningful tag." })
      .min(1, "Provide at least one meaningful tag.")
      .max(30)
      .describe("Required grouping tags; provide at least one meaningful tag."),
  })
  .strict()
  .superRefine((input, context) => {
    const scopeFields = ["projectId", "repositoryId", "worktreeId"] as const;
    const hasScopeIds = scopeFields.some((field) => input[field] !== undefined);
    const hasRepositoryPlacement =
      input.repositoryPath !== undefined || input.ensureScope !== undefined;
    if (input.parentId === undefined) {
      if (input.workItemId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["workItemId"],
          message: agentTaskDirectPlacementRecoveryMessage,
        });
      }
      if (hasScopeIds && hasRepositoryPlacement) {
        for (const field of ["repositoryPath", "ensureScope"] as const) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${field} must be omitted when scope IDs are provided.`,
          });
        }
        return;
      }
      if (hasScopeIds) {
        for (const field of scopeFields) {
          if (input[field] === undefined) {
            context.addIssue({
              code: "custom",
              path: [field],
              message: `${field} is required with the other scope IDs.`,
            });
          }
        }
        return;
      }
      if (hasRepositoryPlacement) {
        if (input.repositoryPath === undefined) {
          context.addIssue({
            code: "custom",
            path: ["repositoryPath"],
            message: "repositoryPath is required when ensureScope is true.",
          });
        }
        if (input.ensureScope !== true) {
          context.addIssue({
            code: "custom",
            path: ["ensureScope"],
            message:
              "Set ensureScope to true to provision scope from repositoryPath.",
          });
        }
        return;
      }
      for (const field of scopeFields) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for an existing top-level scope.`,
        });
      }
      return;
    }
    if (input.workItemId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["workItemId"],
        message: agentTaskDirectPlacementRecoveryMessage,
      });
    }
    for (const field of [
      ...scopeFields,
      "repositoryPath",
      "ensureScope",
    ] as const) {
      if (input[field] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be omitted when parentId supplies the task scope.`,
        });
      }
    }
  });

export const setParentRequestSchema = z
  .object({
    version: z.number().int().positive(),
    parentId: z.number().int().positive(),
    parentVersion: z.number().int().positive(),
    currentParentVersion: z.number().int().positive().optional(),
  })
  .strict();

export const detachParentRequestSchema = z
  .object({
    version: z.number().int().positive(),
    parentVersion: z.number().int().positive(),
  })
  .strict();

export const createDependencyRequestSchema = z
  .object({
    version: z.number().int().positive(),
    prerequisiteId: z.number().int().positive(),
    prerequisiteVersion: z.number().int().positive(),
  })
  .strict();

export const dependencyActionRequestSchema = z
  .object({
    version: z.number().int().positive(),
    prerequisiteVersion: z.number().int().positive(),
    reason: z.string().trim().max(10_000).optional(),
  })
  .strict();

export const fieldErrorsSchema = z.record(z.string(), z.array(z.string()));

export const actionablesCorrelationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "Use letters, numbers, and . _ : - only.",
  );

export const actionablesRetryModeSchema = z.enum([
  "same_request",
  "after_input_change",
  "after_state_change",
  "never",
]);
export type ActionablesRetryMode = z.infer<typeof actionablesRetryModeSchema>;

export const actionablesRecoveryActionSchema = z.enum([
  "retry_request",
  "modify_request",
  "resolve_state",
  "reconcile_state",
  "migrate_database",
  "stop",
]);
export type ActionablesRecoveryAction = z.infer<
  typeof actionablesRecoveryActionSchema
>;

export const actionablesRecoverySchema = z
  .object({
    action: actionablesRecoveryActionSchema,
    guidance: z.string().trim().min(1).max(2_000),
    retryAt: z.string().datetime().optional(),
  })
  .strict();
export type ActionablesRecovery = z.infer<typeof actionablesRecoverySchema>;

export const actionablesErrorResponseSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    detail: z.string().trim().min(1).max(600),
    errors: fieldErrorsSchema.optional(),
    currentVersion: z.number().int().positive().optional(),
    correlationId: actionablesCorrelationIdSchema,
    retryMode: actionablesRetryModeSchema,
    recovery: actionablesRecoverySchema,
    retryable: z.boolean(),
    nextAction: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.nextAction !== payload.recovery.guidance) {
      context.addIssue({
        code: "custom",
        path: ["nextAction"],
        message: "Legacy nextAction must mirror recovery.guidance.",
      });
    }
    const retryable = ["same_request", "after_state_change"].includes(
      payload.retryMode,
    );
    if (payload.retryable !== retryable) {
      context.addIssue({
        code: "custom",
        path: ["retryable"],
        message:
          "Legacy retryable must match same-request or after-state-change recovery.",
      });
    }
  });
export type ActionablesErrorPayload = z.infer<
  typeof actionablesErrorResponseSchema
>;

type ActionablesRecoveryDefinition = Pick<
  ActionablesErrorPayload,
  "retryMode"
> &
  Omit<ActionablesRecovery, "retryAt">;

const actionablesRecoveryByCode: Record<string, ActionablesRecoveryDefinition> =
  {
    INVALID_REQUEST: {
      retryMode: "after_input_change",
      action: "modify_request",
      guidance:
        "Correct every field reported in errors, then submit a new call with corrected arguments.",
    },
    INVALID_SCOPE: {
      retryMode: "after_input_change",
      action: "modify_request",
      guidance:
        "Choose an existing, internally consistent Actionables scope, then submit a corrected request.",
    },
    NOT_FOUND: {
      retryMode: "after_input_change",
      action: "modify_request",
      guidance:
        "Verify the Actionable and top-level work-item IDs. Do not create a replacement implicitly.",
    },
    IDEMPOTENCY_CONFLICT: {
      retryMode: "after_input_change",
      action: "modify_request",
      guidance:
        "Reuse the key only for an identical retry, or generate a new UUID for a new task.",
    },
    INVALID_STATUS_TRANSITION: {
      retryMode: "after_input_change",
      action: "modify_request",
      guidance:
        "Inspect permittedTransitions on the latest task and submit a legal target; returning In progress to Researching also requires a meaningful reason.",
    },
    REASON_REQUIRED: {
      retryMode: "after_input_change",
      action: "modify_request",
      guidance:
        "Add the required meaningful reason, then submit the corrected request.",
    },
    VALIDATION_EVIDENCE_REQUIRED: {
      retryMode: "after_input_change",
      action: "modify_request",
      guidance:
        "Add the required validation evidence, then submit the corrected request.",
    },
    RESEARCH_PHASE_REQUIRED: {
      retryMode: "after_state_change",
      action: "resolve_state",
      guidance:
        "Call actionables.transition_task with status Researching, then begin investigation.",
    },
    RESEARCH_REQUIRED: {
      retryMode: "after_state_change",
      action: "resolve_state",
      guidance:
        "Call actionables.update_task with appendResearch, then retry Ready using the returned version.",
    },
    READY_REQUIREMENTS_NOT_MET: {
      retryMode: "after_state_change",
      action: "resolve_state",
      guidance:
        "Inspect readiness.requiredForReady on the latest task. Supply only the named missing fields with finding, description, appendResearch, or appendPlannedValidation, then use the returned version and confirm Ready appears in permittedTransitions before transitioning.",
    },
    RESOLUTION_REQUIRED: {
      retryMode: "after_state_change",
      action: "resolve_state",
      guidance:
        "Call actionables.update_task with non-empty Resolution content, then retry Done using the returned version.",
    },
    VALIDATION_REQUIRED: {
      retryMode: "after_state_change",
      action: "resolve_state",
      guidance:
        "Record qualifying validation evidence, then retry Done using the returned version.",
    },
    INCOMPLETE_SUBTASKS: {
      retryMode: "after_state_change",
      action: "resolve_state",
      guidance:
        "Complete or explicitly dismiss every active direct task before retrying completion.",
    },
    VERSION_CONFLICT: {
      retryMode: "after_state_change",
      action: "reconcile_state",
      guidance:
        "Re-list or fetch the task, reconcile the newer state, then submit a new request with its current version.",
    },
    ALREADY_CLAIMED: {
      retryMode: "after_state_change",
      action: "resolve_state",
      guidance:
        "Wait until the active claim expires, then re-list available tasks in the same work item before claiming its current version.",
    },
    OWN_CLAIM_ACTIVE: {
      retryMode: "after_state_change",
      action: "resolve_state",
      guidance:
        "Call actionables.recover_task_claim with this task ID and currentVersion to rotate and return fresh credentials for the current Codex thread.",
    },
    CLAIM_OWNER_MISMATCH: {
      retryMode: "after_state_change",
      action: "resolve_state",
      guidance:
        "Use the Codex thread that owns the active claim, or wait for the claim to expire.",
    },
    CLAIM_NOT_FOUND: {
      retryMode: "after_state_change",
      action: "reconcile_state",
      guidance:
        "List mine; if the task is no longer owned, list available in the same work item and claim its current version.",
    },
    INVALID_CLAIM_TOKEN: {
      retryMode: "after_state_change",
      action: "reconcile_state",
      guidance:
        "Discard the token and list mine. If this thread still owns the task, call actionables.recover_task_claim with its current version; otherwise reclaim within the same work item.",
    },
    CLAIM_EXPIRED: {
      retryMode: "after_state_change",
      action: "reconcile_state",
      guidance:
        "Re-list available tasks in the same work item and claim the current version.",
    },
    ARCHIVED: {
      retryMode: "after_state_change",
      action: "resolve_state",
      guidance:
        "Restore the archived Actionable or governing scope before attempting agent work again.",
    },
    TERMINAL: {
      retryMode: "after_state_change",
      action: "resolve_state",
      guidance:
        "Do not retry the claim or mutation. Inspect terminal work read-only with scoped list_tasks or get_task using workItemId. Continued work requires an explicitly authorized, reasoned dashboard reopen before normal list and claim.",
    },
    TERMINAL_READ_INVALIDATED: {
      retryMode: "never",
      action: "stop",
      guidance:
        "Stop terminal inspection and discard any partial pages. The task is active again; continued access requires the normal explicitly authorized list and claim flow, then a fresh read with claimToken.",
    },
    THREAD_ID_REQUIRED: {
      retryMode: "after_state_change",
      action: "resolve_state",
      guidance:
        "Run the operation from a Codex thread that supplies consistent MCP thread metadata.",
    },
    CREATOR_THREAD_MISMATCH: {
      retryMode: "never",
      action: "stop",
      guidance:
        "Use the Codex thread that created this unclaimed task, or use the normal claimed-task workflow instead of repeating this request.",
    },
    SCHEMA_MIGRATION_REQUIRED: {
      retryMode: "after_state_change",
      action: "migrate_database",
      guidance:
        "Inspect errors.migrations and the active configured Actionables database migration status. Apply missing migrations; reconcile incomplete or unexpected history with the documented operator recovery before retrying only after health reports schema current.",
    },
  };

export type ActionablesInternalRetryMode = Extract<
  ActionablesRetryMode,
  "same_request" | "never"
>;

export type CreateActionablesErrorPayloadInput = {
  code: string;
  detail: string;
  errors?: Record<string, string[]>;
  currentVersion?: number;
  correlationId: string;
  retryAt?: string;
  internalRetryMode?: ActionablesInternalRetryMode;
};

export function actionablesErrorPayload({
  internalRetryMode = "never",
  retryAt,
  ...input
}: CreateActionablesErrorPayloadInput): ActionablesErrorPayload {
  const definition =
    input.code === "INTERNAL_ERROR"
      ? internalRetryMode === "same_request"
        ? {
            retryMode: "same_request" as const,
            action: "retry_request" as const,
            guidance:
              "Retry the same request once. If it fails again, inspect the server log using correlationId.",
          }
        : {
            retryMode: "never" as const,
            action: "reconcile_state" as const,
            guidance:
              "Do not retry automatically. Inspect the server log using correlationId and reconcile task state before choosing a new operation.",
          }
      : (actionablesRecoveryByCode[input.code] ?? {
          retryMode: "never" as const,
          action: "stop" as const,
          guidance:
            "Do not retry automatically. Inspect the reported error and choose an explicitly supported recovery path.",
        });
  const recovery = {
    action: definition.action,
    guidance: definition.guidance,
    ...(retryAt ? { retryAt } : {}),
  };
  return actionablesErrorResponseSchema.parse({
    ...input,
    retryMode: definition.retryMode,
    recovery,
    retryable: ["same_request", "after_state_change"].includes(
      definition.retryMode,
    ),
    nextAction: definition.guidance,
  });
}

export const bulkAgentTaskLimit = 25;
export const bulkAgentTaskModeSchema = z
  .enum(["preview", "apply"])
  .describe("Preview validates without writes; apply executes valid items.");

export const bulkCreateAgentTasksRequestSchema = z
  .object({
    mode: bulkAgentTaskModeSchema,
    items: z
      .array(createAgentTaskRequestSchema)
      .min(1)
      .max(bulkAgentTaskLimit)
      .describe("One through 25 independently idempotent task creations."),
  })
  .strict()
  .superRefine((input, context) => {
    const seen = new Set<string>();
    input.items.forEach((item, index) => {
      if (seen.has(item.idempotencyKey)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "idempotencyKey"],
          message: "Use a unique idempotency key for each batch item.",
        });
      }
      seen.add(item.idempotencyKey);
    });
  });

export const bulkPrepareAgentTaskItemSchema = z
  .object({
    idempotencyKey: z
      .string()
      .uuid()
      .describe(
        "Caller-generated UUID; reuse it only when retrying this exact preparation request.",
      ),
    id: z.number().int().positive().describe("Actionable ID to prepare."),
    workItemId: z
      .number()
      .int()
      .positive()
      .describe("Top-level Actionable authorizing this preparation."),
    version: agentTaskVersionInputSchema.describe(
      "Task version from the preceding list or creation result.",
    ),
    finding: markdownField
      .optional()
      .describe("Optional finding Markdown to replace before Ready."),
    description: markdownField
      .optional()
      .describe("Optional intended-result Markdown to replace before Ready."),
    appendResearch: notesSchema
      .min(1, "Provide at least one research note.")
      .optional()
      .describe("Research notes to append with exact deduplication."),
    appendPlannedValidation: notesSchema
      .min(1, "Provide at least one planned validation step.")
      .optional()
      .describe("Planned checks to append before Ready."),
    addUserSources: z
      .array(userSourceReferenceInputSchema)
      .min(1)
      .max(50)
      .optional()
      .describe("User sources to add with exact deduplication."),
  })
  .strict();

export const bulkPrepareAgentTasksRequestSchema = z
  .object({
    mode: bulkAgentTaskModeSchema,
    items: z
      .array(bulkPrepareAgentTaskItemSchema)
      .min(1)
      .max(bulkAgentTaskLimit)
      .describe("One through 25 atomic Inbox-to-Ready preparations."),
  })
  .strict()
  .superRefine((input, context) => {
    const keys = new Set<string>();
    const ids = new Set<number>();
    input.items.forEach((item, index) => {
      if (keys.has(item.idempotencyKey)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "idempotencyKey"],
          message: "Use a unique idempotency key for each batch item.",
        });
      }
      if (ids.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "Prepare each Actionable at most once per batch.",
        });
      }
      keys.add(item.idempotencyKey);
      ids.add(item.id);
    });
  });

export const bulkAgentTaskChangedFieldSchema = z.enum([
  "finding",
  "description",
  "research",
  "plannedValidation",
  "userSources",
  "status",
]);

export const bulkAgentTaskCountSchema = z
  .object({
    field: z.enum(["research", "plannedValidation", "userSources"]),
    persisted: z.number().int().nonnegative(),
    duplicatesIgnored: z.number().int().nonnegative(),
  })
  .strict();

const bulkAgentTaskIndexSchema = z
  .number()
  .int()
  .nonnegative()
  .max(bulkAgentTaskLimit - 1);

const bulkAgentTaskReceiptFields = {
  id: z.number().int().positive(),
  version: z.number().int().positive(),
  status: statusSchema,
};

const bulkPreparedAgentTaskReceiptFields = {
  id: z.number().int().positive(),
  version: z.number().int().positive(),
  status: z.literal("Ready"),
  claimReleased: z.literal(true),
  changedFields: z
    .array(bulkAgentTaskChangedFieldSchema)
    .max(bulkAgentTaskChangedFieldSchema.options.length),
  counts: z.array(bulkAgentTaskCountSchema).max(3),
};

export const bulkPreparedAgentTaskReceiptSchema = z
  .object(bulkPreparedAgentTaskReceiptFields)
  .strict();

export const bulkCreateAgentTaskSuccessSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({ index: bulkAgentTaskIndexSchema, outcome: z.literal("valid") })
      .strict(),
    z
      .object({
        index: bulkAgentTaskIndexSchema,
        outcome: z.literal("created"),
        ...bulkAgentTaskReceiptFields,
      })
      .strict(),
    z
      .object({
        index: bulkAgentTaskIndexSchema,
        outcome: z.literal("replayed"),
        ...bulkAgentTaskReceiptFields,
      })
      .strict(),
  ],
);

export const bulkPrepareAgentTaskSuccessSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        index: bulkAgentTaskIndexSchema,
        outcome: z.literal("valid"),
        ...bulkAgentTaskReceiptFields,
      })
      .strict(),
    z
      .object({
        index: bulkAgentTaskIndexSchema,
        outcome: z.literal("prepared"),
        ...bulkPreparedAgentTaskReceiptFields,
      })
      .strict(),
    z
      .object({
        index: bulkAgentTaskIndexSchema,
        outcome: z.literal("replayed"),
        ...bulkPreparedAgentTaskReceiptFields,
      })
      .strict(),
  ],
);

export const bulkAgentTaskFailureSchema = z
  .object({
    index: bulkAgentTaskIndexSchema,
    outcome: z.literal("failed"),
    error: actionablesErrorResponseSchema,
  })
  .strict();

export const bulkCreateAgentTaskItemResultSchema = z.union([
  bulkCreateAgentTaskSuccessSchema,
  bulkAgentTaskFailureSchema,
]);

export const bulkPrepareAgentTaskItemResultSchema = z.union([
  bulkPrepareAgentTaskSuccessSchema,
  bulkAgentTaskFailureSchema,
]);

export const bulkAgentTaskItemResultSchema = z.union([
  bulkCreateAgentTaskItemResultSchema,
  bulkPrepareAgentTaskItemResultSchema,
]);

export const bulkAgentTaskSummarySchema = z
  .object({
    requested: z.number().int().min(1).max(bulkAgentTaskLimit),
    succeeded: z.number().int().nonnegative().max(bulkAgentTaskLimit),
    replayed: z.number().int().nonnegative().max(bulkAgentTaskLimit),
    failed: z.number().int().nonnegative().max(bulkAgentTaskLimit),
  })
  .strict();

function validateBulkAgentTasksResponse(
  response: {
    mode: z.infer<typeof bulkAgentTaskModeSchema>;
    summary: z.infer<typeof bulkAgentTaskSummarySchema>;
    items: z.infer<typeof bulkAgentTaskItemResultSchema>[];
  },
  context: z.RefinementCtx,
) {
  const succeeded = response.items.filter(
    (item) => item.outcome !== "failed",
  ).length;
  const replayed = response.items.filter(
    (item) => item.outcome === "replayed",
  ).length;
  if (
    response.items.length !== response.summary.requested ||
    succeeded !== response.summary.succeeded ||
    response.items.length - succeeded !== response.summary.failed ||
    replayed !== response.summary.replayed
  ) {
    context.addIssue({
      code: "custom",
      path: ["summary"],
      message: "Bulk summary counts must match the ordered item results.",
    });
  }
  if (response.items.some((item, index) => item.index !== index)) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "Bulk item results must preserve request order and indices.",
    });
  }
}

export const bulkCreateAgentTasksResponseSchema = z
  .object({
    mode: bulkAgentTaskModeSchema,
    summary: bulkAgentTaskSummarySchema,
    items: z
      .array(bulkCreateAgentTaskItemResultSchema)
      .min(1)
      .max(bulkAgentTaskLimit),
  })
  .strict()
  .superRefine(validateBulkAgentTasksResponse);

export const bulkPrepareAgentTasksResponseSchema = z
  .object({
    mode: bulkAgentTaskModeSchema,
    summary: bulkAgentTaskSummarySchema,
    items: z
      .array(bulkPrepareAgentTaskItemResultSchema)
      .min(1)
      .max(bulkAgentTaskLimit),
  })
  .strict()
  .superRefine(validateBulkAgentTasksResponse);

export const problemDetailsSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int(),
  code: z.string().min(1),
  requestId: z.string().min(1),
  detail: z.string().optional(),
  errors: fieldErrorsSchema.optional(),
  current: actionableDetailSchema.optional(),
});

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  database: z.literal("ok"),
  schema: z.literal("current"),
  requestId: z.string().min(1),
});

const seedScopeSchema = z.object({
  externalKey: z.string().min(1),
  name: z.string().min(1),
  localPath: z.string().optional(),
});

const seedPrioritySchema = z.enum(["Critical", "High", "Medium", "Low"]);
const seedStatusProvenanceSchema = z.object({
  kind: z.literal("neutral-import"),
  note: z.string().min(1),
  suggestedStatus: sourceStatusSuggestionSchema.optional(),
});

export const seedActionableSchema = z.object({
  ordinal: z.number().int().positive(),
  externalKey: z.string().min(1),
  title: z.string().min(1),
  priority: seedPrioritySchema,
  status: z.literal("Inbox"),
  statusProvenance: seedStatusProvenanceSchema,
  effort: effortSchema.exclude(["Unknown", "XS", "L–XL", "XL"]),
  updated: z.string().min(1),
  finding: z.string().min(1),
  description: z.string().min(1),
  research: z.array(z.string()),
  validation: z.array(z.string()),
  files: z.array(sourceFileSchema),
  tags: z.array(z.string()),
  blockedBy: z.array(z.number().int().positive()).optional(),
  blocks: z.array(z.number().int().positive()).optional(),
  parentId: z.number().int().positive().optional(),
  childIds: z.array(z.number().int().positive()).optional(),
});

export const seedDocumentSchema = z.object({
  version: z.literal(1),
  source: z.object({
    provider: z.literal("CODEX"),
    containerId: z.string().min(1),
    threadUrl: z.string().min(1),
  }),
  project: seedScopeSchema,
  repository: seedScopeSchema,
  worktree: seedScopeSchema,
  statusPolicy: z.object({
    initialStatus: z.literal("Inbox"),
    note: z.string().min(1),
  }),
  items: z.array(seedActionableSchema).length(32),
});

export const portableFormat = "actionables-portable" as const;
export const portableSchemaVersion = 1 as const;

const portableIdSchema = z.string().trim().min(1).max(240);
const portableTimestampSchema = z.string().datetime();
const portableArchiveSchema = z
  .object({
    directArchivedAt: portableTimestampSchema.nullable(),
    inheritedFrom: z
      .array(z.enum(["project", "repository", "worktree"]))
      .max(3),
  })
  .strict();

const portableProjectSchema = z
  .object({
    portableId: portableIdSchema,
    name: z.string().trim().min(1).max(240),
    archive: portableArchiveSchema,
    createdAt: portableTimestampSchema.optional(),
    updatedAt: portableTimestampSchema.optional(),
  })
  .strict();

const portableRepositorySchema = z
  .object({
    portableId: portableIdSchema,
    projectId: portableIdSchema,
    name: z.string().trim().min(1).max(240),
    localPath: z.string().max(4_096).nullable(),
    archive: portableArchiveSchema,
    createdAt: portableTimestampSchema.optional(),
    updatedAt: portableTimestampSchema.optional(),
  })
  .strict();

const portableWorktreeSchema = z
  .object({
    portableId: portableIdSchema,
    projectId: portableIdSchema,
    repositoryId: portableIdSchema,
    name: z.string().trim().min(1).max(240),
    localPath: z.string().max(4_096).nullable(),
    archive: portableArchiveSchema,
    createdAt: portableTimestampSchema.optional(),
    updatedAt: portableTimestampSchema.optional(),
  })
  .strict();

export const portableFieldOwnershipSchema = z.record(
  z.string().min(1),
  z.enum(["imported", "user-authored"]),
);

const portableActionableSchema = z
  .object({
    portableId: portableIdSchema,
    projectId: portableIdSchema,
    repositoryId: portableIdSchema,
    worktreeId: portableIdSchema,
    title: titleField,
    priority: prioritySchema,
    status: statusSchema,
    statusProvenance: statusProvenanceSchema,
    effort: effortSchema,
    evidenceState: evidenceStateSchema,
    finding: z.string().max(100_000),
    description: z.string().max(100_000),
    resolution: z.string().max(100_000).default(""),
    research: notesSchema,
    validation: notesSchema,
    files: z.array(sourceFileSchema).max(500),
    tags: tagsSchema,
    manualBlocker: z.string().max(100_000).nullable(),
    dismissalReason: z.string().max(100_000).nullable(),
    completionOverride: z.string().max(100_000).nullable(),
    archive: portableArchiveSchema,
    importedEvidence: z
      .object({
        provider: z.string().max(120),
        containerId: z.string().max(500),
        threadUrl: z.string().max(4_096),
        contentHash: z.string().max(128),
        rawFragment: z.json(),
      })
      .strict(),
    provenance: z
      .object({
        origin: z.enum(["imported", "user-authored"]),
        fieldOwnership: portableFieldOwnershipSchema,
      })
      .strict(),
    createdAt: portableTimestampSchema.optional(),
    updatedAt: portableTimestampSchema.optional(),
  })
  .strict();

const portableStatusHistorySchema = z
  .object({
    portableId: portableIdSchema,
    actionableId: portableIdSchema,
    previousStatus: statusSchema.nullable(),
    newStatus: statusSchema,
    origin: z.string().min(1).max(200),
    occurredAt: portableTimestampSchema,
  })
  .strict();

const portableValidationRecordSchema = z
  .object({
    portableId: portableIdSchema,
    actionableId: portableIdSchema,
    type: validationTypeSchema,
    outcome: validationOutcomeSchema,
    notes: z.string().max(100_000),
    evidence: z.string().max(100_000),
    origin: z.string().min(1).max(200),
    recordedAt: portableTimestampSchema,
    supersedesId: portableIdSchema.nullable(),
  })
  .strict();

const portableUserSourceSchema = z
  .object({
    portableId: portableIdSchema,
    actionableId: portableIdSchema,
    type: userSourceReferenceInputSchema.shape.type,
    locator: z.string().trim().min(1).max(4_096),
    label: z.string().trim().max(200).nullable(),
    provenance: userSourceReferenceSchema.shape.provenance,
    createdAt: portableTimestampSchema,
    removedAt: portableTimestampSchema.nullable(),
  })
  .strict();

const portableActivitySchema = z
  .object({
    portableId: portableIdSchema,
    actionableId: portableIdSchema,
    type: activityTypeSchema,
    summary: z.string().min(1).max(1_000),
    context: z.record(z.string(), z.string()),
    occurredAt: portableTimestampSchema,
  })
  .strict();

const portableHierarchySchema = z
  .object({
    portableId: portableIdSchema,
    parentId: portableIdSchema,
    childId: portableIdSchema,
    createdAt: portableTimestampSchema,
    detachedAt: portableTimestampSchema.nullable(),
    provenance: z.string().min(1).max(200),
  })
  .strict();

const portableDependencySchema = z
  .object({
    portableId: portableIdSchema,
    dependentId: portableIdSchema,
    prerequisiteId: portableIdSchema,
    createdAt: portableTimestampSchema,
    waivedAt: portableTimestampSchema.nullable(),
    waiverReason: z.string().max(100_000).nullable(),
    removedAt: portableTimestampSchema.nullable(),
    provenance: z.string().min(1).max(200),
  })
  .strict();

export const relationshipSuggestionSchema = z
  .object({
    portableId: portableIdSchema,
    kind: z.enum(["hierarchy", "dependency"]),
    fromId: portableIdSchema,
    toId: portableIdSchema,
    reason: z.string().min(1).max(10_000),
    provenance: z.string().min(1).max(500),
  })
  .strict();

export const portableDocumentSchema = z
  .object({
    format: z.literal(portableFormat),
    schemaVersion: z.literal(portableSchemaVersion),
    exportedAt: portableTimestampSchema,
    application: z
      .object({
        name: z.literal("Actionables"),
        version: z.string().min(1).max(100),
        schema: z.string().min(1).max(100),
      })
      .strict(),
    metadata: z
      .object({
        sourceName: z.string().max(500).nullable(),
        sourceKind: z.enum(["backup", "reviewed-seed", "user-json"]),
      })
      .strict(),
    projects: z.array(portableProjectSchema).max(10_000),
    repositories: z.array(portableRepositorySchema).max(10_000),
    worktrees: z.array(portableWorktreeSchema).max(10_000),
    actionables: z.array(portableActionableSchema).max(100_000),
    statusHistory: z.array(portableStatusHistorySchema).max(500_000),
    validationRecords: z.array(portableValidationRecordSchema).max(500_000),
    userSources: z.array(portableUserSourceSchema).max(500_000),
    activities: z.array(portableActivitySchema).max(1_000_000),
    hierarchy: z.array(portableHierarchySchema).max(200_000),
    dependencies: z.array(portableDependencySchema).max(500_000),
    relationshipSuggestions: z.array(relationshipSuggestionSchema).max(500_000),
  })
  .strict();

export const importClassificationSchema = z.enum([
  "create",
  "safe-update",
  "no-op",
  "conflict",
  "invalid",
  "missing-reference",
  "integrity-failure",
  "suggestion",
]);

export const importPreviewChangeSchema = z
  .object({
    field: z.string().min(1),
    current: z.unknown().optional(),
    incoming: z.unknown().optional(),
    reason: z.string().min(1),
  })
  .strict();

export const importPreviewItemSchema = z
  .object({
    id: z.string().min(1),
    recordType: z.string().min(1),
    portableId: z.string().min(1),
    display: z.string().min(1),
    classification: importClassificationSchema,
    changes: z.array(importPreviewChangeSchema),
    errors: z.array(z.string()),
  })
  .strict();

const importCountSchema = z
  .object({
    creates: z.number().int().nonnegative(),
    safeUpdates: z.number().int().nonnegative(),
    noOps: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    missingReferences: z.number().int().nonnegative(),
    integrityFailures: z.number().int().nonnegative(),
    suggestions: z.number().int().nonnegative(),
  })
  .strict();

export const importPreviewResponseSchema = z
  .object({
    previewToken: z.string().min(1),
    contentDigest: z.string().length(64),
    expiresAt: portableTimestampSchema,
    schemaVersion: z.literal(portableSchemaVersion),
    compatibility: z.string().min(1),
    canCommit: z.boolean(),
    items: z.array(importPreviewItemSchema),
    totals: importCountSchema,
    totalsByRecordType: z.record(z.string(), importCountSchema),
    archiveEffects: z.array(z.string()),
    lifecycleEffects: z.array(z.string()),
    affectedActionableIds: z.array(portableIdSchema),
  })
  .strict();

export const prepareImportCommitRequestSchema = z
  .object({
    contentDigest: z.string().length(64),
    conflictResolutions: z.record(z.string(), z.literal("skip")),
    acceptedSuggestionIds: z.array(z.string().min(1)),
  })
  .strict();

export const prepareImportCommitResponseSchema = z
  .object({
    commitToken: z.string().min(1),
    selectionsDigest: z.string().length(64),
    expiresAt: portableTimestampSchema,
  })
  .strict();

export const commitImportRequestSchema = z
  .object({
    contentDigest: z.string().length(64),
    commitToken: z.string().min(1),
    selectionsDigest: z.string().length(64),
  })
  .strict();

export const importCommitResponseSchema = z
  .object({
    importRunId: z.string().min(1),
    committedAt: portableTimestampSchema,
    summary: importCountSchema,
    totalsByRecordType: z.record(z.string(), importCountSchema),
    affectedActionables: z.array(
      z
        .object({
          portableId: portableIdSchema,
          id: z.number().int().positive(),
          title: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type Priority = z.infer<typeof prioritySchema>;
export type Status = z.infer<typeof statusSchema>;
export type ActionableReadiness = z.infer<typeof actionableReadinessSchema>;
export type Effort = z.infer<typeof effortSchema>;
export type EvidenceState = z.infer<typeof evidenceStateSchema>;
export type SourceFile = z.infer<typeof sourceFileSchema>;
export type UserSourceReferenceInput = z.infer<
  typeof userSourceReferenceInputSchema
>;
export type UserSourceReference = z.infer<typeof userSourceReferenceSchema>;
export type ValidationType = z.infer<typeof validationTypeSchema>;
export type ValidationOutcome = z.infer<typeof validationOutcomeSchema>;
export type ValidationRecord = z.infer<typeof validationRecordSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type ActionableSummary = z.infer<typeof actionableSummarySchema>;
export type ActionableDetail = z.infer<typeof actionableDetailSchema>;
export type ActionablesListResponse = z.infer<
  typeof actionablesListResponseSchema
>;
export type ScopeOptionsResponse = z.infer<typeof scopeOptionsResponseSchema>;
export type CreateRepositoryRequest = z.infer<
  typeof createRepositoryRequestSchema
>;
export type CreateRepositoryResponse = z.infer<
  typeof createRepositoryResponseSchema
>;
export type RepositoryFolderPickerResponse = z.infer<
  typeof repositoryFolderPickerResponseSchema
>;
export type ActionableQuery = z.infer<typeof actionableQuerySchema>;
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
export type AgentTaskSummary = z.infer<typeof agentTaskSummarySchema>;
export type ListAgentTasksRequest = z.infer<typeof listAgentTasksRequestSchema>;
export type ListAgentTasksResponse = z.infer<
  typeof listAgentTasksResponseSchema
>;
export type ClaimAgentTaskRequest = z.infer<typeof claimAgentTaskRequestSchema>;
export type ClaimAgentTaskResponse = z.infer<
  typeof claimAgentTaskResponseSchema
>;
export type RecoverAgentTaskClaimRequest = z.infer<
  typeof recoverAgentTaskClaimRequestSchema
>;
export type RecoverAgentTaskClaimResponse = z.infer<
  typeof recoverAgentTaskClaimResponseSchema
>;
export type RenewAgentTaskClaimRequest = z.infer<
  typeof renewAgentTaskClaimRequestSchema
>;
export type RenewAgentTaskClaimResponse = z.infer<
  typeof renewAgentTaskClaimResponseSchema
>;
export type ReleaseAgentTaskClaimRequest = z.infer<
  typeof releaseAgentTaskClaimRequestSchema
>;
export type ReleaseAgentTaskClaimResponse = z.infer<
  typeof releaseAgentTaskClaimResponseSchema
>;
export type ForceReleaseAgentClaimRequest = z.infer<
  typeof forceReleaseAgentClaimRequestSchema
>;
export type ArchiveTargetKind = z.infer<typeof archiveTargetKindSchema>;
export type ArchiveImpactResponse = z.infer<typeof archiveImpactResponseSchema>;
export type CreateActionableRequest = z.infer<
  typeof createActionableRequestSchema
>;
export type UpdateActionableRequest = z.infer<
  typeof updateActionableRequestSchema
>;
export type GroomActionableNotesRequest = z.infer<
  typeof groomActionableNotesRequestSchema
>;
export type TriageInboxQueueRequest = z.infer<
  typeof triageInboxQueueRequestSchema
>;
export type HelperAgentSettings = z.infer<typeof helperAgentSettingsSchema>;
export type NoteGroomerModel = z.infer<typeof noteGroomerModelSchema>;
export type AssistantReasoningEffort = z.infer<
  typeof assistantReasoningEffortSchema
>;
export type UpdateHelperAgentSettingsRequest = z.infer<
  typeof updateHelperAgentSettingsRequestSchema
>;
export type AgentIntegrationComponent = z.infer<
  typeof agentIntegrationComponentSchema
>;
export type AgentIntegrationSettings = z.infer<
  typeof agentIntegrationSettingsSchema
>;
export type InstallAgentIntegrationRequest = z.infer<
  typeof installAgentIntegrationRequestSchema
>;
export type AgentIntegrationInstallResponse = z.infer<
  typeof agentIntegrationInstallResponseSchema
>;
export type GroomActionableNotesProposal = z.infer<
  typeof groomActionableNotesProposalSchema
>;
export type GroomActionableNotesResponse = z.infer<
  typeof groomActionableNotesResponseSchema
>;
export type InboxTriageProposal = z.infer<typeof inboxTriageProposalSchema>;
export type InboxTriageItemResult = z.infer<typeof inboxTriageItemResultSchema>;
export type InboxTriageBatchResponse = z.infer<
  typeof inboxTriageBatchResponseSchema
>;
export type AuditActionableRelationshipsRequest = z.infer<
  typeof auditActionableRelationshipsRequestSchema
>;
export type RelationshipAuditRecommendation = z.infer<
  typeof relationshipAuditRecommendationSchema
>;
export type RelationshipAuditResponse = z.infer<
  typeof relationshipAuditResponseSchema
>;
export type StatusTransitionRequest = z.infer<
  typeof statusTransitionRequestSchema
>;
export type CreateValidationRecordRequest = z.infer<
  typeof createValidationRecordRequestSchema
>;
export type UpdateClaimedAgentTaskRequest = z.infer<
  typeof updateClaimedAgentTaskRequestSchema
>;
export type TransitionClaimedAgentTaskRequest = z.infer<
  typeof transitionClaimedAgentTaskRequestSchema
>;
export type DismissAgentTaskRequest = z.infer<
  typeof dismissAgentTaskRequestSchema
>;
export type RecordClaimedAgentTaskValidationRequest = z.infer<
  typeof recordClaimedAgentTaskValidationRequestSchema
>;
export type HandoffClaimedAgentTaskRequest = z.infer<
  typeof handoffClaimedAgentTaskRequestSchema
>;
export type CreateSubtaskRequest = z.infer<typeof createSubtaskRequestSchema>;
export type TaskBreakdownTemplate = z.infer<typeof taskBreakdownTemplateSchema>;
export type CreateTaskBreakdownRequest = z.infer<
  typeof createTaskBreakdownRequestSchema
>;
export type CreateAgentTaskRequest = z.infer<
  typeof createAgentTaskRequestSchema
>;
export type BulkCreateAgentTasksRequest = z.infer<
  typeof bulkCreateAgentTasksRequestSchema
>;
export type BulkPrepareAgentTaskItem = z.infer<
  typeof bulkPrepareAgentTaskItemSchema
>;
export type BulkPrepareAgentTasksRequest = z.infer<
  typeof bulkPrepareAgentTasksRequestSchema
>;
export type BulkAgentTaskItemResult = z.infer<
  typeof bulkAgentTaskItemResultSchema
>;
export type BulkPreparedAgentTaskReceipt = z.infer<
  typeof bulkPreparedAgentTaskReceiptSchema
>;
export type BulkCreateAgentTasksResponse = z.infer<
  typeof bulkCreateAgentTasksResponseSchema
>;
export type BulkPrepareAgentTasksResponse = z.infer<
  typeof bulkPrepareAgentTasksResponseSchema
>;
export type SetParentRequest = z.infer<typeof setParentRequestSchema>;
export type DetachParentRequest = z.infer<typeof detachParentRequestSchema>;
export type CreateDependencyRequest = z.infer<
  typeof createDependencyRequestSchema
>;
export type DependencyActionRequest = z.infer<
  typeof dependencyActionRequestSchema
>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type SeedDocument = z.infer<typeof seedDocumentSchema>;
export type PortableDocument = z.infer<typeof portableDocumentSchema>;
export type PortableActionable = PortableDocument["actionables"][number];
export type ImportPreviewItem = z.infer<typeof importPreviewItemSchema>;
export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;
export type PrepareImportCommitRequest = z.infer<
  typeof prepareImportCommitRequestSchema
>;
export type PrepareImportCommitResponse = z.infer<
  typeof prepareImportCommitResponseSchema
>;
export type CommitImportRequest = z.infer<typeof commitImportRequestSchema>;
export type ImportCommitResponse = z.infer<typeof importCommitResponseSchema>;
