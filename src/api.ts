import {
  actionableDetailResponseSchema,
  actionablesListResponseSchema,
  agentIntegrationInstallResponseSchema,
  agentIntegrationSettingsSchema,
  auditActionableRelationshipsRequestSchema,
  archiveImpactResponseSchema,
  createRepositoryResponseSchema,
  repositoryFolderPickerResponseSchema,
  dashboardResponseSchema,
  problemDetailsSchema,
  scopeOptionsResponseSchema,
  inboxTriageBatchResponseSchema,
  type ActionableDetail,
  type ActionableQuery,
  type ActionablesListResponse,
  type AgentIntegrationInstallResponse,
  type AgentIntegrationSettings,
  type ArchiveImpactResponse,
  type ArchiveTargetKind,
  type CreateDependencyRequest,
  type CreateSubtaskRequest,
  type CreateTaskBreakdownRequest,
  type CreateValidationRecordRequest,
  type CreateActionableRequest,
  type CreateRepositoryRequest,
  type CreateRepositoryResponse,
  type UpdateRepositoryProjectRequest,
  type RepositoryFolderPickerResponse,
  type GroomActionableNotesRequest,
  type GroomActionableNotesResponse,
  type HelperAgentSettings,
  type InboxTriageBatchResponse,
  type ProblemDetails,
  type DependencyActionRequest,
  type DetachParentRequest,
  type ScopeOptionsResponse,
  type DashboardResponse,
  type InstallAgentIntegrationRequest,
  type ForceReleaseAgentClaimRequest,
  type StatusTransitionRequest,
  type SetParentRequest,
  type UpdateActionableRequest,
  groomActionableNotesResponseSchema,
  helperAgentSettingsSchema,
  relationshipAuditResponseSchema,
  type AuditActionableRelationshipsRequest,
  type RelationshipAuditResponse,
  type TriageInboxQueueRequest,
  type UpdateHelperAgentSettingsRequest,
} from "@actionables/contracts";

export class ApiProblem extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.title);
  }
}

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json();

  if (!response.ok) {
    const parsed = problemDetailsSchema.safeParse(payload);
    if (parsed.success) throw new ApiProblem(parsed.data);
    throw new Error(`Request failed with ${response.status}.`);
  }

  return payload;
}

function queryString(query: Partial<Record<keyof ActionableQuery, string>>) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const text = params.toString();
  return text ? `?${text}` : "";
}

export async function fetchActionables(
  query: Partial<Record<keyof ActionableQuery, string>> = {},
): Promise<ActionablesListResponse> {
  return actionablesListResponseSchema.parse(
    await requestJson(`/api/actionables${queryString(query)}`),
  );
}

export async function fetchActionable(id: number): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(`/api/actionables/${id}`),
  );
  return response.item;
}

export async function forceReleaseAgentClaim(
  id: number,
  input: ForceReleaseAgentClaimRequest,
): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(`/api/actionables/${id}/agent-claim/force-release`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  return response.item;
}

export async function fetchScopeOptions(): Promise<ScopeOptionsResponse> {
  return scopeOptionsResponseSchema.parse(await requestJson("/api/scopes"));
}

export async function fetchHelperAgentSettings(): Promise<HelperAgentSettings> {
  return helperAgentSettingsSchema.parse(
    await requestJson("/api/settings/helper-agents"),
  );
}

export async function updateHelperAgentSettings(
  input: UpdateHelperAgentSettingsRequest,
): Promise<HelperAgentSettings> {
  return helperAgentSettingsSchema.parse(
    await requestJson("/api/settings/helper-agents", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchAgentIntegrationSettings(): Promise<AgentIntegrationSettings> {
  return agentIntegrationSettingsSchema.parse(
    await requestJson("/api/settings/agent-integration"),
  );
}

export async function installAgentIntegration(
  input: InstallAgentIntegrationRequest,
): Promise<AgentIntegrationInstallResponse> {
  return agentIntegrationInstallResponseSchema.parse(
    await requestJson("/api/settings/agent-integration/install", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function createRepository(
  input: CreateRepositoryRequest,
): Promise<CreateRepositoryResponse> {
  return createRepositoryResponseSchema.parse(
    await requestJson("/api/repositories", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function selectRepositoryFolder(): Promise<RepositoryFolderPickerResponse> {
  return repositoryFolderPickerResponseSchema.parse(
    await requestJson("/api/repositories/folder-picker", {
      method: "POST",
    }),
  );
}

/** Save a project assignment without deleting the repository or its work. */
export async function updateRepositoryProject(
  id: string,
  input: UpdateRepositoryProjectRequest,
): Promise<ScopeOptionsResponse> {
  return scopeOptionsResponseSchema.parse(
    await requestJson(`/api/repositories/${encodeURIComponent(id)}/project`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchDashboard(
  query: Pick<
    Partial<Record<keyof ActionableQuery, string>>,
    "project" | "repository" | "worktree"
  >,
): Promise<DashboardResponse> {
  return dashboardResponseSchema.parse(
    await requestJson(`/api/dashboard${queryString(query)}`),
  );
}

export async function fetchArchiveImpact(
  kind: ArchiveTargetKind,
  id: string | number,
): Promise<ArchiveImpactResponse> {
  return archiveImpactResponseSchema.parse(
    await requestJson(
      `/api/archive-impact/${kind}/${encodeURIComponent(String(id))}`,
    ),
  );
}

export async function setActionableArchived(
  id: number,
  version: number,
  archived: boolean,
): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(
      `/api/actionables/${id}/${archived ? "archive" : "restore"}`,
      {
        method: "POST",
        body: JSON.stringify({ version }),
      },
    ),
  );
  return response.item;
}

export async function setScopeArchived(
  kind: Exclude<ArchiveTargetKind, "actionable">,
  id: string,
  version: number,
  archived: boolean,
): Promise<ScopeOptionsResponse> {
  return scopeOptionsResponseSchema.parse(
    await requestJson(
      `/api/scopes/${kind}/${encodeURIComponent(id)}/${archived ? "archive" : "restore"}`,
      {
        method: "POST",
        body: JSON.stringify({ version }),
      },
    ),
  );
}

export async function createActionable(
  input: CreateActionableRequest,
): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson("/api/actionables", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  return response.item;
}

export async function updateActionable(
  id: number,
  input: UpdateActionableRequest,
): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(`/api/actionables/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
  return response.item;
}

export async function groomActionableNotes(
  id: number,
  input: GroomActionableNotesRequest,
): Promise<GroomActionableNotesResponse> {
  return groomActionableNotesResponseSchema.parse(
    await requestJson(`/api/actionables/${id}/assistant/note-grooming`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function triageInboxQueue(
  input: TriageInboxQueueRequest,
): Promise<InboxTriageBatchResponse> {
  return inboxTriageBatchResponseSchema.parse(
    await requestJson("/api/assistant/inbox-triage", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function auditActionableRelationships(
  id: number,
  input: AuditActionableRelationshipsRequest,
): Promise<RelationshipAuditResponse> {
  auditActionableRelationshipsRequestSchema.parse(input);
  return relationshipAuditResponseSchema.parse(
    await requestJson(`/api/actionables/${id}/assistant/relationship-audit`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function transitionActionable(
  id: number,
  input: StatusTransitionRequest,
): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(`/api/actionables/${id}/status-transitions`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  return response.item;
}

export async function recordValidation(
  id: number,
  input: CreateValidationRecordRequest,
): Promise<ActionableDetail> {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(`/api/actionables/${id}/validation-records`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
  return response.item;
}

async function relationshipRequest(
  path: string,
  method: string,
  input: unknown,
) {
  const response = actionableDetailResponseSchema.parse(
    await requestJson(path, { method, body: JSON.stringify(input) }),
  );
  return response.item;
}

export const createSubtask = (id: number, input: CreateSubtaskRequest) =>
  relationshipRequest(`/api/actionables/${id}/subtasks`, "POST", input);

export const createTaskBreakdown = (
  id: number,
  input: CreateTaskBreakdownRequest,
) =>
  relationshipRequest(`/api/actionables/${id}/task-breakdowns`, "POST", input);

export const setParent = (id: number, input: SetParentRequest) =>
  relationshipRequest(`/api/actionables/${id}/parent`, "PUT", input);

export const detachParent = (id: number, input: DetachParentRequest) =>
  relationshipRequest(`/api/actionables/${id}/parent`, "DELETE", input);

export const createDependency = (id: number, input: CreateDependencyRequest) =>
  relationshipRequest(`/api/actionables/${id}/dependencies`, "POST", input);

export const removeDependency = (
  id: number,
  relationshipId: string,
  input: DependencyActionRequest,
) =>
  relationshipRequest(
    `/api/actionables/${id}/dependencies/${relationshipId}`,
    "DELETE",
    input,
  );

export const waiveDependency = (
  id: number,
  relationshipId: string,
  input: DependencyActionRequest,
) =>
  relationshipRequest(
    `/api/actionables/${id}/dependencies/${relationshipId}/waive`,
    "POST",
    input,
  );

export const restoreDependency = (
  id: number,
  relationshipId: string,
  input: DependencyActionRequest,
) =>
  relationshipRequest(
    `/api/actionables/${id}/dependencies/${relationshipId}/restore`,
    "POST",
    input,
  );
