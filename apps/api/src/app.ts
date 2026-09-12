import { randomUUID } from "node:crypto";
import {
  actionableQuerySchema,
  actionablesCorrelationIdSchema,
  actionableDetailResponseSchema,
  codexWorkspaceResponseSchema,
  actionablesListResponseSchema,
  auditActionableRelationshipsRequestSchema,
  archiveImpactResponseSchema,
  archiveMutationRequestSchema,
  archiveTargetKindSchema,
  createDependencyRequestSchema,
  createRepositoryRequestSchema,
  createRepositoryResponseSchema,
  repositoryFolderPickerResponseSchema,
  createSubtaskRequestSchema,
  createTaskBreakdownRequestSchema,
  createValidationRecordRequestSchema,
  createActionableRequestSchema,
  dependencyActionRequestSchema,
  detachParentRequestSchema,
  healthResponseSchema,
  dashboardResponseSchema,
  groomActionableNotesRequestSchema,
  groomActionableNotesResponseSchema,
  inboxTriageBatchResponseSchema,
  helperAgentSettingsSchema,
  agentIntegrationSettingsSchema,
  agentIntegrationInstallResponseSchema,
  installAgentIntegrationRequestSchema,
  resolveApiRuntimeConfig,
  scopeOptionsResponseSchema,
  setParentRequestSchema,
  statusTransitionRequestSchema,
  updateActionableRequestSchema,
  updateHelperAgentSettingsRequestSchema,
  updateRepositoryProjectRequestSchema,
  forceReleaseAgentClaimRequestSchema,
  relationshipAuditResponseSchema,
  triageInboxQueueRequestSchema,
  type ActionableQuery,
  type ApiRuntimeConfig,
} from "@actionables/contracts";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  assertDatabaseSchemaReady,
  SchemaMigrationRequiredError,
  type AppPrismaClient,
} from "./database.js";
import {
  createActionable,
  createRepository,
  archiveImpact,
  ScopeVersionConflictError,
  DomainValidationError,
  getDashboard,
  getActionable,
  getActionableWorkspace,
  listActionablesWithQuery,
  listScopeOptions,
  recordValidation,
  setActionableArchived,
  setScopeArchived,
  transitionActionable,
  updateActionable,
  updateRepositoryProject,
  VersionConflictError,
} from "./repository.js";
import {
  createDependency,
  createSubtask,
  createTaskBreakdown,
  detachParent,
  removeDependency,
  restoreDependency,
  setParent,
  waiveDependency,
} from "./relationships.js";
import { registerMcpRoutes } from "./mcp.js";
import {
  AgentTaskClaimError,
  AgentClaimReleaseConflictError,
  forceReleaseAgentTaskClaim,
} from "./agent-tasks.js";
import {
  AssistantContextTooLargeError,
  AssistantRunnerError,
  defaultCodexAssistantModel,
  type AssistantRunner,
} from "./assistant-runner.js";
import { groomActionableNotes } from "./note-groomer.js";
import { triageInboxQueue } from "./inbox-triager.js";
import { auditWorkItemRelationships } from "./relationship-auditor.js";
import {
  getHelperAgentSettings,
  HelperAgentSettingsVersionConflictError,
  updateHelperAgentSettings,
} from "./helper-agent-settings.js";
import {
  AgentIntegrationConflictError,
  AgentIntegrationInstallError,
  AgentIntegrationInstaller,
} from "./agent-integration.js";
import {
  selectNativeFolder,
  type NativeFolderPicker,
} from "./native-folder-picker.js";

type BuildAppOptions = {
  prisma: AppPrismaClient;
  logger?: boolean | FastifyBaseLogger;
  mcpBearerToken?: string;
  runtimeConfig?: ApiRuntimeConfig;
  assistantRunner?: AssistantRunner;
  agentHomeDirectory?: string;
  folderPicker?: NativeFolderPicker;
};

function fieldErrors(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}) {
  const errors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.join(".") || "request";
    errors[field] ??= [];
    errors[field].push(issue.message);
  }
  return errors;
}

function problem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
  options: {
    detail?: string;
    errors?: Record<string, string[]>;
    current?: unknown;
  } = {},
) {
  return reply.code(status).send({
    type: `https://actionables.local/problems/${code.toLowerCase()}`,
    title,
    status,
    code,
    requestId: request.id,
    ...options,
  });
}

function parseRouteId(
  request: FastifyRequest,
  reply: FastifyReply,
  rawId: string,
) {
  const parsed = Number(rawId);
  if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(parsed) || parsed < 1) {
    problem(
      request,
      reply,
      400,
      "INVALID_ID",
      "The actionable identifier is invalid.",
      {
        errors: { id: ["Actionable id must be a positive integer."] },
      },
    );
    return null;
  }
  return parsed;
}

function normalizeActionableQuery(raw: unknown): ActionableQuery {
  const defaults = actionableQuerySchema.parse({});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  let normalized = defaults;
  const source = raw as Record<string, unknown>;
  const keys: Array<keyof ActionableQuery> = [
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
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== "string") continue;
    const parsed = actionableQuerySchema.safeParse({
      ...normalized,
      [key]: value,
    });
    if (parsed.success) normalized = parsed.data;
  }
  return normalized;
}

export function buildApp({
  prisma,
  logger = false,
  mcpBearerToken,
  runtimeConfig = resolveApiRuntimeConfig(undefined),
  assistantRunner,
  agentHomeDirectory,
  folderPicker = selectNativeFolder,
}: BuildAppOptions) {
  const agentIntegration = new AgentIntegrationInstaller({
    homeDirectory: agentHomeDirectory,
    runtimeConfig,
    mcpEnabled: Boolean(mcpBearerToken?.trim()),
  });
  const assistantDefaultModel =
    assistantRunner?.defaultModel ?? defaultCodexAssistantModel;
  const app = Fastify({
    ...(typeof logger === "object" ? { loggerInstance: logger } : { logger }),
    bodyLimit: 6 * 1024 * 1024,
    genReqId(request) {
      const incoming = request.headers["x-correlation-id"];
      const parsed = actionablesCorrelationIdSchema.safeParse(incoming);
      return parsed.success ? parsed.data : randomUUID();
    },
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-correlation-id", request.id);
    return payload;
  });

  if (mcpBearerToken?.trim()) {
    registerMcpRoutes(app, prisma, mcpBearerToken);
  }

  app.addHook("preHandler", async (request) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
      request.routeOptions.url !== "/mcp"
    ) {
      await assertDatabaseSchemaReady(prisma);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SchemaMigrationRequiredError) {
      const migrations = [
        ...error.missingMigrations.map((name) => `Missing: ${name}`),
        ...error.incompleteMigrations.map((name) => `Incomplete: ${name}`),
        ...error.unexpectedMigrations.map((name) => `Unexpected: ${name}`),
      ];
      return problem(
        request,
        reply,
        503,
        "SCHEMA_MIGRATION_REQUIRED",
        "The active Actionables database schema is not current.",
        {
          detail:
            "Inspect the reported migration state for the configured database. Apply missing migrations or use the documented operator recovery for incomplete or unexpected history, then retry only after health reports schema current.",
          ...(migrations.length ? { errors: { migrations } } : {}),
        },
      );
    }
    if (error instanceof DomainValidationError) {
      return problem(request, reply, 422, error.code, error.message, {
        errors: error.fieldErrors,
      });
    }
    if (error instanceof VersionConflictError) {
      return problem(
        request,
        reply,
        409,
        "VERSION_CONFLICT",
        "This actionable has a newer saved version.",
        {
          detail:
            "Review the saved version or reload its version and reapply your draft.",
          current: error.current,
        },
      );
    }
    if (error instanceof HelperAgentSettingsVersionConflictError) {
      return problem(
        request,
        reply,
        409,
        "VERSION_CONFLICT",
        "The helper agent settings have a newer saved version.",
        {
          detail: "Review the saved settings before reapplying your changes.",
          current: error.current,
        },
      );
    }
    if (error instanceof AgentIntegrationConflictError) {
      return problem(
        request,
        reply,
        409,
        error.code,
        "Existing Codex integration configuration needs manual review.",
        {
          detail: error.message,
          errors: Object.fromEntries(
            error.conflicts.map((component) => [
              component.id,
              [
                `${component.targetPath} differs from the expected Actionables configuration. Keep the existing content or reconcile it manually before retrying.`,
              ],
            ]),
          ),
        },
      );
    }
    if (error instanceof AgentIntegrationInstallError) {
      return problem(
        request,
        reply,
        500,
        error.code,
        "Could not install the Actionables agent integration.",
        {
          detail: error.message,
          errors: { targetPath: [error.targetPath] },
        },
      );
    }
    if (error instanceof AgentClaimReleaseConflictError) {
      return problem(request, reply, 409, error.code, error.message, {
        detail:
          error.code === "CLAIM_CHANGED"
            ? "Reload and confirm the current claim before trying again."
            : "The claim was already released or expired elsewhere.",
        current: error.current,
      });
    }
    if (error instanceof ScopeVersionConflictError) {
      return problem(
        request,
        reply,
        409,
        "VERSION_CONFLICT",
        "This scope record has a newer saved version.",
        {
          detail: `Reload the target and retry from version ${error.currentVersion}.`,
        },
      );
    }
    if (error instanceof AgentTaskClaimError && error.code === "NOT_FOUND") {
      return problem(request, reply, 404, "NOT_FOUND", "Actionable not found.");
    }
    if (error instanceof AssistantContextTooLargeError) {
      return problem(
        request,
        reply,
        422,
        "ASSISTANT_CONTEXT_TOO_LARGE",
        "The assistant context is too large for one request.",
        { detail: error.guidance },
      );
    }
    if (error instanceof AssistantRunnerError) {
      const status =
        error.code === "ASSISTANT_UNAVAILABLE"
          ? 503
          : error.code === "ASSISTANT_TIMEOUT"
            ? 504
            : 502;
      const detail =
        error.code === "ASSISTANT_UNAVAILABLE"
          ? "Confirm that Codex is installed and signed in, then retry."
          : error.code === "ASSISTANT_TIMEOUT"
            ? error.timeoutMs
              ? `The request exceeded the configured ${error.timeoutMs / 1_000}-second local assistant time limit. Retry with shorter notes or increase the timeout in Settings.`
              : "The request exceeded the local assistant time limit. Retry with shorter notes or increase the timeout in Settings."
            : "The model did not produce a usable proposal. No Actionable data was changed.";
      return problem(
        request,
        reply,
        status,
        error.code,
        "The local assistant could not complete the request.",
        { detail },
      );
    }
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode)
        : 0;
    if (statusCode === 400) {
      return problem(
        request,
        reply,
        400,
        "MALFORMED_JSON",
        "The request JSON is malformed.",
      );
    }
    if (statusCode === 413) {
      return problem(
        request,
        reply,
        413,
        "REQUEST_TOO_LARGE",
        "The request exceeds the 6 MB server limit.",
      );
    }

    request.log.error({ err: error }, "Unhandled request error");
    return problem(
      request,
      reply,
      500,
      "INTERNAL_ERROR",
      "The request could not be completed.",
    );
  });

  app.get("/api/health", async (request) => {
    await assertDatabaseSchemaReady(prisma);
    await prisma.project.count();
    return healthResponseSchema.parse({
      status: "ok",
      database: "ok",
      schema: "current",
      requestId: request.id,
    });
  });

  app.get("/api/scopes", async () => {
    return scopeOptionsResponseSchema.parse(await listScopeOptions(prisma));
  });

  app.get("/api/settings/helper-agents", async () => {
    return helperAgentSettingsSchema.parse(
      await getHelperAgentSettings(prisma, assistantDefaultModel),
    );
  });

  app.patch("/api/settings/helper-agents", async (request, reply) => {
    const currentSettings = await getHelperAgentSettings(
      prisma,
      assistantDefaultModel,
    );
    const parsed = updateHelperAgentSettingsRequestSchema.safeParse(
      request.body && typeof request.body === "object"
        ? {
            codexResearchPrompt: currentSettings.codexResearchPrompt,
            codexImplementationPrompt:
              currentSettings.codexImplementationPrompt,
            inboxTriagerBatchSize: currentSettings.inboxTriagerBatchSize,
            inboxTriagerEnabled: currentSettings.inboxTriagerEnabled,
            inboxTriagerModel: currentSettings.inboxTriagerModel,
            inboxTriagerReasoningEffort:
              currentSettings.inboxTriagerReasoningEffort,
            inboxTriagerPrompt: currentSettings.inboxTriagerPrompt,
            ...request.body,
          }
        : request.body,
    );
    if (!parsed.success) {
      return problem(
        request,
        reply,
        422,
        "VALIDATION_ERROR",
        "Check the helper agent settings.",
        { errors: fieldErrors(parsed.error) },
      );
    }
    return helperAgentSettingsSchema.parse(
      await updateHelperAgentSettings(
        prisma,
        parsed.data,
        assistantDefaultModel,
      ),
    );
  });

  app.get("/api/settings/agent-integration", async () => {
    return agentIntegrationSettingsSchema.parse(
      await agentIntegration.status(),
    );
  });

  app.post(
    "/api/settings/agent-integration/install",
    async (request, reply) => {
      const parsed = installAgentIntegrationRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_FAILED",
          "Select an Actionables agent component to install.",
          {
            detail:
              "Choose the MCP server registration, agent instructions, workflow skill, or any combination. Nothing is installed by default.",
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return agentIntegrationInstallResponseSchema.parse(
        await agentIntegration.install(parsed.data),
      );
    },
  );

  app.post("/api/repositories", async (request, reply) => {
    const parsed = createRepositoryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return problem(
        request,
        reply,
        422,
        "VALIDATION_ERROR",
        "Check the repository details.",
        { errors: fieldErrors(parsed.error) },
      );
    }

    const created = await createRepository(prisma, parsed.data);
    return reply.code(201).send(createRepositoryResponseSchema.parse(created));
  });

  app.post("/api/repositories/folder-picker", async (request, reply) => {
    try {
      return repositoryFolderPickerResponseSchema.parse({
        path: await folderPicker(),
      });
    } catch (error) {
      request.log.error({ err: error }, "Repository folder picker failed");
      return problem(
        request,
        reply,
        503,
        "FOLDER_PICKER_FAILED",
        "The folder picker could not be opened.",
      );
    }
  });

  app.patch<{ Params: { id: string } }>(
    "/api/repositories/:id/project",
    async (request, reply) => {
      const parsed = updateRepositoryProjectRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success)
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the project assignment.",
          { errors: fieldErrors(parsed.error) },
        );
      const scopes = await updateRepositoryProject(
        prisma,
        request.params.id,
        parsed.data,
      );
      if (!scopes)
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Repository not found.",
        );
      return scopeOptionsResponseSchema.parse(scopes);
    },
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/actionables",
    async (request) => {
      const query = normalizeActionableQuery(request.query);
      return actionablesListResponseSchema.parse(
        await listActionablesWithQuery(prisma, query),
      );
    },
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/dashboard",
    async (request) => {
      const query = normalizeActionableQuery(request.query);
      return dashboardResponseSchema.parse(await getDashboard(prisma, query));
    },
  );

  app.post("/api/actionables", async (request, reply) => {
    const parsed = createActionableRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return problem(
        request,
        reply,
        422,
        "VALIDATION_ERROR",
        "Check the actionable fields.",
        {
          errors: fieldErrors(parsed.error),
        },
      );
    }

    const item = await createActionable(prisma, parsed.data);
    reply.header("location", `/actionables/${item.id}`);
    return reply.code(201).send(actionableDetailResponseSchema.parse({ item }));
  });

  app.get<{ Params: { id: string } }>(
    "/api/actionables/:id",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;

      const item = await getActionable(prisma, id);
      if (!item) {
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      }

      return actionableDetailResponseSchema.parse({ item });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/actionables/:id/codex-workspace",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const workspace = await getActionableWorkspace(prisma, id);
      if (!workspace)
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      return codexWorkspaceResponseSchema.parse(workspace);
    },
  );

  app.post("/api/assistant/inbox-triage", async (request, reply) => {
    const parsed = triageInboxQueueRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return problem(
        request,
        reply,
        422,
        "VALIDATION_ERROR",
        "Check the Inbox-triage request.",
        { errors: fieldErrors(parsed.error) },
      );
    }
    const settings = await getHelperAgentSettings(
      prisma,
      assistantDefaultModel,
    );
    if (!settings.inboxTriagerEnabled) {
      return problem(
        request,
        reply,
        409,
        "ASSISTANT_ACTION_DISABLED",
        "Inbox triage is disabled.",
        {
          detail:
            "Enable Triage Inbox with local Codex in Settings before retrying.",
        },
      );
    }
    return inboxTriageBatchResponseSchema.parse(
      await triageInboxQueue(
        prisma,
        assistantRunner,
        parsed.data,
        settings.inboxTriagerBatchSize,
        settings.inboxTriagerPrompt,
        {
          model: settings.inboxTriagerModel ?? undefined,
          reasoningEffort: settings.inboxTriagerReasoningEffort ?? undefined,
          timeoutMs: settings.localCodexEffectiveTimeoutSeconds * 1_000,
        },
      ),
    );
  });

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/assistant/note-grooming",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = groomActionableNotesRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the note-grooming request.",
          { errors: fieldErrors(parsed.error) },
        );
      }
      const item = await getActionable(prisma, id);
      if (!item) {
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      }
      if (item.version !== parsed.data.version) {
        throw new VersionConflictError(item);
      }
      const settings = await getHelperAgentSettings(
        prisma,
        assistantDefaultModel,
      );
      if (!settings.noteGroomerEnabled) {
        return problem(
          request,
          reply,
          409,
          "ASSISTANT_ACTION_DISABLED",
          "Note grooming is disabled.",
          {
            detail:
              "Enable Groom notes with local Codex in Settings before retrying.",
          },
        );
      }
      if (!assistantRunner) {
        throw new AssistantRunnerError(
          "ASSISTANT_UNAVAILABLE",
          "No local assistant runner is configured.",
        );
      }
      return groomActionableNotesResponseSchema.parse(
        await groomActionableNotes(
          assistantRunner,
          item,
          settings.noteGroomerPrompt,
          {
            model: settings.noteGroomerModel ?? undefined,
            reasoningEffort: settings.noteGroomerReasoningEffort ?? undefined,
            timeoutMs: settings.localCodexEffectiveTimeoutSeconds * 1_000,
          },
        ),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/assistant/relationship-audit",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = auditActionableRelationshipsRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the relationship-audit request.",
          { errors: fieldErrors(parsed.error) },
        );
      }
      const item = await getActionable(prisma, id);
      if (!item) {
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      }
      if (item.version !== parsed.data.version) {
        throw new VersionConflictError(item);
      }
      const settings = await getHelperAgentSettings(
        prisma,
        assistantDefaultModel,
      );
      if (!settings.relationshipAuditorEnabled) {
        return problem(
          request,
          reply,
          409,
          "ASSISTANT_ACTION_DISABLED",
          "Relationship auditing is disabled.",
          {
            detail: "Enable Relationship auditor in Settings before retrying.",
          },
        );
      }
      if (!assistantRunner) {
        throw new AssistantRunnerError(
          "ASSISTANT_UNAVAILABLE",
          "No local assistant runner is configured.",
        );
      }
      return relationshipAuditResponseSchema.parse(
        await auditWorkItemRelationships(
          prisma,
          assistantRunner,
          item,
          settings.relationshipAuditorPrompt,
          {
            model: settings.relationshipAuditorModel ?? undefined,
            reasoningEffort:
              settings.relationshipAuditorReasoningEffort ?? undefined,
            timeoutMs: settings.localCodexEffectiveTimeoutSeconds * 1_000,
          },
        ),
      );
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/actionables/:id",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;

      const parsed = updateActionableRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the actionable fields.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }

      const item = await updateActionable(prisma, id, parsed.data);
      if (!item) {
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      }
      return actionableDetailResponseSchema.parse({ item });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/agent-claim/force-release",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = forceReleaseAgentClaimRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the agent claim release.",
          { errors: fieldErrors(parsed.error) },
        );
      }
      const item = await forceReleaseAgentTaskClaim(prisma, id, parsed.data);
      return actionableDetailResponseSchema.parse({ item });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/status-transitions",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;

      const parsed = statusTransitionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the status transition.",
          { errors: fieldErrors(parsed.error) },
        );
      }

      const item = await transitionActionable(prisma, id, parsed.data);
      if (!item) {
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      }
      return actionableDetailResponseSchema.parse({ item });
    },
  );

  app.get<{ Params: { kind: string; id: string } }>(
    "/api/archive-impact/:kind/:id",
    async (request, reply) => {
      const kind = archiveTargetKindSchema.safeParse(request.params.kind);
      if (!kind.success) {
        return problem(
          request,
          reply,
          400,
          "INVALID_ARCHIVE_TARGET",
          "The archive target is invalid.",
        );
      }
      const impact = await archiveImpact(prisma, kind.data, request.params.id);
      if (!impact)
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Archive target not found.",
        );
      return archiveImpactResponseSchema.parse(impact);
    },
  );

  const actionableArchiveMutation =
    (archived: boolean) =>
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = archiveMutationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the archive request.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      const item = await setActionableArchived(
        prisma,
        id,
        parsed.data.version,
        archived,
      );
      if (!item)
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      return actionableDetailResponseSchema.parse({ item });
    };
  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/archive",
    actionableArchiveMutation(true),
  );
  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/restore",
    actionableArchiveMutation(false),
  );

  const scopeArchiveMutation =
    (archived: boolean) =>
    async (
      request: FastifyRequest<{ Params: { kind: string; id: string } }>,
      reply: FastifyReply,
    ) => {
      const kind = archiveTargetKindSchema
        .exclude(["actionable"])
        .safeParse(request.params.kind);
      if (!kind.success) {
        return problem(
          request,
          reply,
          400,
          "INVALID_ARCHIVE_TARGET",
          "The scope archive target is invalid.",
        );
      }
      const parsed = archiveMutationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the archive request.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      const scopes = await setScopeArchived(
        prisma,
        kind.data,
        request.params.id,
        parsed.data.version,
        archived,
      );
      if (!scopes)
        return problem(request, reply, 404, "NOT_FOUND", "Scope not found.");
      return scopeOptionsResponseSchema.parse(scopes);
    };
  app.post<{ Params: { kind: string; id: string } }>(
    "/api/scopes/:kind/:id/archive",
    scopeArchiveMutation(true),
  );
  app.post<{ Params: { kind: string; id: string } }>(
    "/api/scopes/:kind/:id/restore",
    scopeArchiveMutation(false),
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/validation-records",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;

      const parsed = createValidationRecordRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the validation record.",
          { errors: fieldErrors(parsed.error) },
        );
      }

      const item = await recordValidation(prisma, id, parsed.data);
      if (!item) {
        return problem(
          request,
          reply,
          404,
          "NOT_FOUND",
          "Actionable not found.",
        );
      }
      return actionableDetailResponseSchema.parse({ item });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/subtasks",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = createSubtaskRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the subtask fields.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return actionableDetailResponseSchema.parse({
        item: await createSubtask(prisma, id, parsed.data),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/task-breakdowns",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = createTaskBreakdownRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the task breakdown fields.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return actionableDetailResponseSchema.parse({
        item: await createTaskBreakdown(prisma, id, parsed.data),
      });
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/actionables/:id/parent",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = setParentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the hierarchy fields.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return actionableDetailResponseSchema.parse({
        item: await setParent(prisma, id, parsed.data),
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/actionables/:id/parent",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = detachParentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the hierarchy fields.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return actionableDetailResponseSchema.parse({
        item: await detachParent(prisma, id, parsed.data),
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/actionables/:id/dependencies",
    async (request, reply) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = createDependencyRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(
          request,
          reply,
          422,
          "VALIDATION_ERROR",
          "Check the dependency fields.",
          {
            errors: fieldErrors(parsed.error),
          },
        );
      }
      return actionableDetailResponseSchema.parse({
        item: await createDependency(prisma, id, parsed.data),
      });
    },
  );

  const dependencyMutation =
    (action: typeof removeDependency, title: string) =>
    async (
      request: FastifyRequest<{
        Params: { id: string; relationshipId: string };
      }>,
      reply: FastifyReply,
    ) => {
      const id = parseRouteId(request, reply, request.params.id);
      if (id === null) return;
      const parsed = dependencyActionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return problem(request, reply, 422, "VALIDATION_ERROR", title, {
          errors: fieldErrors(parsed.error),
        });
      }
      return actionableDetailResponseSchema.parse({
        item: await action(
          prisma,
          id,
          request.params.relationshipId,
          parsed.data,
        ),
      });
    };

  app.delete<{ Params: { id: string; relationshipId: string } }>(
    "/api/actionables/:id/dependencies/:relationshipId",
    dependencyMutation(removeDependency, "Check the dependency removal."),
  );
  app.post<{ Params: { id: string; relationshipId: string } }>(
    "/api/actionables/:id/dependencies/:relationshipId/waive",
    dependencyMutation(waiveDependency, "Check the dependency waiver."),
  );
  app.post<{ Params: { id: string; relationshipId: string } }>(
    "/api/actionables/:id/dependencies/:relationshipId/restore",
    dependencyMutation(restoreDependency, "Check the dependency restoration."),
  );

  return app;
}
