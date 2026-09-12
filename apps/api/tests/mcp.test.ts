import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { actionablesErrorResponseSchema } from "@actionables/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createPrismaClient, type AppPrismaClient } from "../src/database.js";
import { getAgentCoordinationSettings } from "../src/helper-agent-settings.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const canonicalWorkflowSkillPath = resolve(
  repoRoot,
  "resources",
  "agent-integration",
  "actionables-workflow",
  "SKILL.md",
);
const prismaCli = resolve(repoRoot, "node_modules/prisma/build/index.js");
const bearerToken = "test-mcp-token-with-at-least-thirty-two-characters";
const threadId = "019fa45f-581d-7bc0-afe3-a2b65171df62";
const agentId = `codex:${threadId}`;
const json = (value: unknown) => value as never;
const validTaskClassification = {
  priority: "Medium",
  effort: "S",
  tags: ["mcp"],
};

function workflowInstructions(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .trim();
}

let databasePath: string;
let prisma: AppPrismaClient;
let app: ReturnType<typeof buildApp>;
let address: string;
let scope: { projectId: string; repositoryId: string; worktreeId: string };
let nextOrdinal = 1;

async function createTask(overrides: { status?: string; title?: string } = {}) {
  const highest = await prisma.actionable.aggregate({
    _max: { sourceOrdinal: true },
  });
  const ordinal = Math.max(nextOrdinal, (highest._max.sourceOrdinal ?? 0) + 1);
  nextOrdinal = ordinal + 1;
  return prisma.actionable.create({
    data: {
      externalKey: `mcp-task-${ordinal}`,
      sourceOrdinal: ordinal,
      title: overrides.title ?? `MCP task ${ordinal}`,
      priority: "High",
      status: overrides.status ?? "Ready",
      statusProvenance: "MCP integration fixture.",
      effort: "S",
      evidenceState: "Confirmed",
      updatedLabel: "fixture",
      finding: "Initial finding",
      description: "Initial description",
      researchJson: json([]),
      validationJson: json(["Run the MCP integration test."]),
      filesJson: json([{ path: "apps/api/src/mcp.ts" }]),
      tagsJson: json(["mcp"]),
      userSourcesJson: json([]),
      blockedByOrdinalsJson: json([]),
      blocksOrdinalsJson: json([]),
      childOrdinalsJson: json([]),
      importProvider: "MANUAL",
      sourceContainerId: "",
      sourceThread: "",
      contentHash: "",
      rawFragmentJson: json({ fixture: true }),
      ...scope,
    },
  });
}

function threadMetadata(value: string) {
  return {
    threadId: value,
    "x-codex-turn-metadata": { thread_id: value },
  };
}

async function connectClient(
  token = bearerToken,
  requestThreadId: string | null = threadId,
  options: { address?: string; correlationId?: string } = {},
) {
  const targetAddress = options.address ?? address;
  const client = new Client({ name: "actionables-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${targetAddress}/mcp`),
    {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
          origin: targetAddress,
          ...(options.correlationId
            ? { "x-correlation-id": options.correlationId }
            : {}),
        },
      },
    },
  );
  await client.connect(transport);
  const callToolWithoutThread = client.callTool.bind(client);
  client.callTool = ((params, ...rest) =>
    callToolWithoutThread(
      requestThreadId
        ? { ...params, _meta: threadMetadata(requestThreadId) }
        : params,
      ...rest,
    )) as typeof client.callTool;
  return { client, transport };
}

function output<T>(value: unknown) {
  const result = value as CallToolResult;
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
    true,
  );
  expect(result.content).toEqual([
    {
      type: "text",
      text: "Actionables operation succeeded. Read structuredContent for the authoritative result.",
    },
  ]);
  return result.structuredContent as T;
}

function errorOutput(value: unknown) {
  const result = value as CallToolResult;
  expect(result.isError).toBe(true);
  const parsed = actionablesErrorResponseSchema.parse(
    JSON.parse(
      result.content.find((item) => item.type === "text")?.text ?? "{}",
    ),
  );
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

function validationErrorText(value: unknown) {
  const result = value as CallToolResult;
  expect(result.isError).toBe(true);
  const message = result.content.find((item) => item.type === "text")?.text;
  expect(message).toEqual(expect.any(String));
  return message!;
}

function captureLogger(entries: Array<{ value: unknown; message?: string }>) {
  const logger = {
    level: "error",
    child: () => logger,
    fatal: () => undefined,
    error: (value: unknown, message?: string) =>
      entries.push({ value, message }),
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    silent: () => undefined,
  };
  return logger as never;
}

function describedProperties(
  schema: unknown,
  path = "input",
): Array<{ path: string; schema: Record<string, unknown> }> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const node = schema as Record<string, unknown>;
  const found: Array<{ path: string; schema: Record<string, unknown> }> = [];
  if (
    node.properties &&
    typeof node.properties === "object" &&
    !Array.isArray(node.properties)
  ) {
    for (const [name, property] of Object.entries(node.properties)) {
      if (!property || typeof property !== "object" || Array.isArray(property))
        continue;
      found.push({
        path: `${path}.${name}`,
        schema: property as Record<string, unknown>,
      });
      found.push(...describedProperties(property, `${path}.${name}`));
    }
  }
  found.push(...describedProperties(node.items, `${path}[]`));
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const alternatives = node[keyword];
    if (Array.isArray(alternatives)) {
      alternatives.forEach((alternative, index) => {
        found.push(
          ...describedProperties(alternative, `${path}.${keyword}[${index}]`),
        );
      });
    }
  }
  if (
    node.$defs &&
    typeof node.$defs === "object" &&
    !Array.isArray(node.$defs)
  ) {
    for (const [name, definition] of Object.entries(node.$defs)) {
      found.push(...describedProperties(definition, `${path}.$defs.${name}`));
    }
  }
  return found;
}

beforeAll(async () => {
  const databaseName = `mcp-${randomUUID()}.db`;
  databasePath = resolve(repoRoot, "data", databaseName);
  const databaseUrl = `file:./data/${databaseName}`;
  const databaseFile = await open(databasePath, "a");
  await databaseFile.close();
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
  prisma = createPrismaClient(databaseUrl);
  const project = await prisma.project.create({
    data: { externalKey: "mcp-project", name: "MCP Project" },
  });
  const repository = await prisma.repository.create({
    data: {
      externalKey: "mcp-repository",
      name: "MCP Repository",
      projectId: project.id,
    },
  });
  const worktree = await prisma.worktree.create({
    data: {
      externalKey: "mcp-worktree",
      name: "MCP Worktree",
      projectId: project.id,
      repositoryId: repository.id,
    },
  });
  scope = {
    projectId: project.id,
    repositoryId: repository.id,
    worktreeId: worktree.id,
  };
  app = buildApp({ prisma, mcpBearerToken: bearerToken });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  if (databasePath) {
    await Promise.all(
      ["", "-journal", "-shm", "-wal"].map((suffix) =>
        rm(`${databasePath}${suffix}`, { force: true }),
      ),
    );
  }
});

describe("Actionables MCP", () => {
  it("exposes exactly the bounded task tools through the official client", async () => {
    const { client, transport } = await connectClient();
    try {
      const canonicalSkill = await readFile(canonicalWorkflowSkillPath, "utf8");
      expect(client.getInstructions()).toBe(
        workflowInstructions(canonicalSkill),
      );
      expect(client.getInstructions()).toEqual(
        expect.stringContaining(
          "may remain Researching between turns only while additional investigation is genuinely required",
        ),
      );
      expect(client.getInstructions()).toEqual(
        expect.stringContaining(
          "Never report research or the overall task complete while a lifecycle-owned Actionable remains Researching",
        ),
      );
      expect(client.getInstructions()).toContain(
        "truncation.reconciliationGuidance",
      );
      expect(client.getInstructions()).toContain("actionables.get_task_detail");
      expect(client.getInstructions()).toContain(
        "pass `contentHash` with each `nextOffset` until null",
      );
      expect(client.getInstructions()).toContain(
        "When guidance is absent, normal flow may continue",
      );
      expect(client.getInstructions()).toContain(
        "Treat successful `structuredContent` as authoritative",
      );
      expect(client.getInstructions()).toContain(
        "Inspect `hasMore` before treating a bounded list as exhaustive",
      );
      expect(client.getInstructions()).toContain(
        "a deliberate priority other than `Unset`, an effort estimate other than `Unknown`, and at least one meaningful tag",
      );
      expect(client.getInstructions()).toContain(
        "keep the root as the coordination record and create the minimum direct task set covering every implementation slice",
      );
      expect(client.getInstructions()).toContain(
        "narrow it to one non-overlapping slice and create only the remaining slices as sibling direct tasks under the same top-level work item",
      );
      expect(client.getInstructions()).toContain(
        "Do not split by technical layer, create adjacent cleanup, or duplicate scope",
      );
      expect(client.getInstructions()).toContain(
        "do not claim that dependency relationships were created",
      );
      expect(client.getInstructions()).toContain(
        "in the current task and every created task. Leave created tasks unclaimed in Inbox",
      );
      expect(client.getInstructions()).toContain(
        "Move a research-complete split root to Ready as the coordination record",
      );
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(
        [
          "actionables.create_task",
          "actionables.bulk_create_tasks",
          "actionables.bulk_prepare_tasks",
          "actionables.list_tasks",
          "actionables.get_task",
          "actionables.get_task_detail",
          "actionables.claim_task",
          "actionables.recover_task_claim",
          "actionables.renew_task_claim",
          "actionables.update_task",
          "actionables.transition_task",
          "actionables.dismiss_task",
          "actionables.record_task_validation",
          "actionables.handoff_task",
          "actionables.release_task",
        ].sort(),
      );
      const claimTaskTool = tools.find(
        (tool) => tool.name === "actionables.claim_task",
      );
      for (const responsePath of ["task.version", "claim.claimToken"]) {
        expect(client.getInstructions()).toEqual(
          expect.stringContaining(responsePath),
        );
        expect(claimTaskTool?.description).toEqual(
          expect.stringContaining(responsePath),
        );
      }
      const recoverTaskTool = tools.find(
        (tool) => tool.name === "actionables.recover_task_claim",
      );
      expect(
        Object.keys(
          (recoverTaskTool?.inputSchema as { properties?: object })
            .properties ?? {},
        ).sort(),
      ).toEqual(["id", "leaseMinutes", "version"]);
      expect(recoverTaskTool?.description).toContain(
        "superseded token becomes invalid immediately",
      );
      const createTaskTool = tools.find(
        (tool) => tool.name === "actionables.create_task",
      );
      const directTaskGuidance =
        "For one direct task or sibling, provide the authorized top-level Actionable as both workItemId and parentId, omit placement fields, and never use a direct task as the parent.";
      const createTaskInputSchema = createTaskTool?.inputSchema as {
        required?: string[];
        properties?: Record<
          string,
          { description?: string; enum?: string[]; minItems?: number }
        >;
      };
      expect(createTaskTool?.description).toContain(
        "a deliberate priority other than Unset, an effort estimate other than Unknown, and at least one meaningful tag",
      );
      expect(canonicalSkill).toContain(directTaskGuidance);
      expect(client.getInstructions()).toContain(directTaskGuidance);
      expect(createTaskTool?.description).toContain(directTaskGuidance);
      expect(createTaskTool?.description).toContain(
        "never use a direct task as the parent",
      );
      expect(createTaskInputSchema.required).toEqual(
        expect.arrayContaining(["priority", "effort", "tags"]),
      );
      expect(createTaskInputSchema.properties?.priority).toMatchObject({
        description: "Required deliberate task priority; Unset is not allowed.",
        enum: ["Critical", "High", "Medium", "Low", "Backlog"],
      });
      expect(createTaskInputSchema.properties?.effort).toMatchObject({
        description:
          "Required deliberate effort estimate; Unknown is not allowed.",
        enum: ["XS", "S", "S–M", "M", "M–L", "L", "L–XL", "XL"],
      });
      expect(createTaskInputSchema.properties?.tags).toMatchObject({
        description:
          "Required grouping tags; provide at least one meaningful tag.",
        minItems: 1,
      });
      for (const name of [
        "actionables.bulk_create_tasks",
        "actionables.bulk_prepare_tasks",
      ]) {
        const schema = tools.find((tool) => tool.name === name)
          ?.inputSchema as {
          required?: string[];
          properties?: Record<
            string,
            { enum?: string[]; minItems?: number; maxItems?: number }
          >;
        };
        expect(schema.required, name).toEqual(
          expect.arrayContaining(["mode", "items"]),
        );
        expect(schema.properties?.mode, name).toMatchObject({
          enum: ["preview", "apply"],
        });
        expect(schema.properties?.items, name).toMatchObject({
          minItems: 1,
          maxItems: 25,
        });
      }
      const bulkCreateOutput = JSON.stringify(
        tools.find((tool) => tool.name === "actionables.bulk_create_tasks")
          ?.outputSchema,
      );
      const bulkPrepareOutput = JSON.stringify(
        tools.find((tool) => tool.name === "actionables.bulk_prepare_tasks")
          ?.outputSchema,
      );
      expect(bulkCreateOutput).toContain('"const":"created"');
      expect(bulkCreateOutput).not.toContain('"const":"prepared"');
      expect(bulkPrepareOutput).toContain('"const":"prepared"');
      expect(bulkPrepareOutput).not.toContain('"const":"created"');
      expect(bulkPrepareOutput).toContain(
        '"claimReleased","changedFields","counts"',
      );
      const handoffTaskTool = tools.find(
        (tool) => tool.name === "actionables.handoff_task",
      );
      const releaseTaskTool = tools.find(
        (tool) => tool.name === "actionables.release_task",
      );
      expect(handoffTaskTool?.inputSchema.description).toContain(
        "If no task content needs to change, call actionables.release_task instead.",
      );
      expect(handoffTaskTool?.description).toContain(
        "If no task content needs to change, call actionables.release_task instead.",
      );
      expect(releaseTaskTool?.description).toContain(
        "does not save or update task content",
      );
      expect(releaseTaskTool?.description).toContain("Use handoff_task");
      for (const tool of tools) {
        const properties = describedProperties(tool.inputSchema);
        expect(properties.length, tool.name).toBeGreaterThan(0);
        for (const property of properties) {
          expect(
            property.schema.description,
            `${tool.name} ${property.path}`,
          ).toEqual(expect.any(String));
        }
      }
      const byName = Object.fromEntries(
        tools.map((tool) => [tool.name, tool.annotations]),
      );
      expect(byName["actionables.list_tasks"]).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(byName["actionables.get_task_detail"]).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(byName["actionables.create_task"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(byName["actionables.bulk_create_tasks"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(byName["actionables.bulk_prepare_tasks"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      });
      expect(byName["actionables.update_task"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      expect(byName["actionables.transition_task"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      expect(byName["actionables.dismiss_task"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });
      expect(byName["actionables.handoff_task"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });
      expect(byName["actionables.release_task"]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
      const descriptions = Object.fromEntries(
        tools.map((tool) => [tool.name, tool.description]),
      );
      expect(descriptions["actionables.get_task_detail"]).toContain(
        "pass each nextOffset until null",
      );
      expect(descriptions["actionables.bulk_create_tasks"]).toContain(
        "1 through 25",
      );
      expect(descriptions["actionables.bulk_create_tasks"]).toContain(
        "commits each schema-valid item atomically",
      );
      expect(descriptions["actionables.bulk_prepare_tasks"]).toContain(
        "claims for the current Codex thread",
      );
      expect(descriptions["actionables.bulk_prepare_tasks"]).toContain(
        "Claim credentials are never accepted or returned",
      );
      expect(descriptions["actionables.transition_task"]).toContain(
        "Ready requires non-empty finding, description, Research, and planned validation",
      );
      expect(descriptions["actionables.transition_task"]).toContain(
        "If a composed call returns isError, stop",
      );
      expect(descriptions["actionables.handoff_task"]).toContain(
        "If any requested write fails",
      );
      expect(descriptions["actionables.release_task"]).toContain(
        "record findings so far, remaining questions, and the next research step",
      );
      const receiptTools = [
        "actionables.renew_task_claim",
        "actionables.update_task",
        "actionables.transition_task",
        "actionables.dismiss_task",
        "actionables.record_task_validation",
        "actionables.handoff_task",
        "actionables.release_task",
      ];
      const receiptSchemas = receiptTools.map(
        (name) => tools.find((tool) => tool.name === name)!.outputSchema,
      );
      for (const schema of receiptSchemas.slice(1)) {
        expect(schema).toEqual(receiptSchemas[0]);
      }
      expect(
        (receiptSchemas[0] as { required?: string[] }).required?.sort(),
      ).toEqual(
        [
          "id",
          "version",
          "status",
          "changedFields",
          "claimReleased",
          "reconciliationFields",
          "readiness",
          "permittedTransitions",
          "counts",
        ].sort(),
      );
      expect(
        (
          tools.find((tool) => tool.name === "actionables.list_tasks")!
            .outputSchema as { required?: string[] }
        ).required,
      ).toContain("hasMore");
    } finally {
      await transport.close();
    }
  });

  it("correlates redacted internal errors and distinguishes read retries from mutation uncertainty", async () => {
    const entries: Array<{ value: unknown; message?: string }> = [];
    const testApp = buildApp({
      prisma,
      mcpBearerToken: bearerToken,
      logger: captureLogger(entries),
    });
    const testAddress = await testApp.listen({ host: "127.0.0.1", port: 0 });
    const correlationId = "mcp-internal-error-test";
    const connected = await connectClient(bearerToken, threadId, {
      address: testAddress,
      correlationId,
    });

    try {
      const readFailure = vi
        .spyOn(prisma.actionable, "findMany")
        .mockRejectedValueOnce(new Error("private read diagnostic"));
      const readError = errorOutput(
        await connected.client.callTool({
          name: "actionables.list_tasks",
          arguments: { view: "mine" },
        }),
      );
      readFailure.mockRestore();
      expect(readError).toMatchObject({
        code: "INTERNAL_ERROR",
        detail: "The task operation could not be completed.",
        correlationId,
        retryMode: "same_request",
        recovery: { action: "retry_request" },
      });
      expect(JSON.stringify(readError)).not.toContain(
        "private read diagnostic",
      );

      const before = await prisma.actionable.count();
      const readinessFailure = vi
        .spyOn(prisma, "$queryRaw")
        .mockRejectedValueOnce(new Error("private mutation diagnostic"));
      const mutationError = errorOutput(
        await connected.client.callTool({
          name: "actionables.create_task",
          arguments: {
            idempotencyKey: randomUUID(),
            ...scope,
            title: "Must not be created after an internal readiness failure",
            ...validTaskClassification,
          },
        }),
      );
      readinessFailure.mockRestore();
      expect(mutationError).toMatchObject({
        code: "INTERNAL_ERROR",
        detail: "The task operation could not be completed.",
        correlationId,
        retryMode: "never",
        recovery: { action: "reconcile_state" },
      });
      expect(JSON.stringify(mutationError)).not.toContain(
        "private mutation diagnostic",
      );
      expect(await prisma.actionable.count()).toBe(before);

      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            value: expect.objectContaining({
              correlationId,
              toolName: "actionables.list_tasks",
            }),
          }),
          expect.objectContaining({
            value: expect.objectContaining({
              correlationId,
              toolName: "actionables.create_task",
            }),
          }),
        ]),
      );
      expect(
        entries.map(
          ({ value }) =>
            (value as { err?: Error }).err?.message ?? String(value),
        ),
      ).toEqual(
        expect.arrayContaining([
          "private read diagnostic",
          "private mutation diagnostic",
        ]),
      );
    } finally {
      vi.restoreAllMocks();
      await connected.transport.close();
      await testApp.close();
    }
  });

  it("returns typed migration recovery before a mutation and recovers without restart", async () => {
    const latest = (
      await prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name
        FROM "_prisma_migrations"
        ORDER BY migration_name DESC
        LIMIT 1
      `
    )[0]!;
    const idempotencyKey = randomUUID();
    const argumentsValue = {
      idempotencyKey,
      ...scope,
      title: "Created only after schema readiness recovers",
      ...validTaskClassification,
    };
    const connected = await connectClient(bearerToken, threadId, {
      correlationId: "mcp-schema-readiness-test",
    });
    const claimedTask = await createTask({
      status: "Ready",
      title: "Expired claim protected by schema readiness",
    });
    const claimed = output<{
      task: { version: number };
      claim: { claimToken: string };
    }>(
      await connected.client.callTool({
        name: "actionables.claim_task",
        arguments: {
          id: claimedTask.sourceOrdinal,
          workItemId: claimedTask.sourceOrdinal,
          version: claimedTask.version,
        },
      }),
    );
    await prisma.agentTaskClaim.update({
      where: { actionableId: claimedTask.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const protectedVersion = (
      await prisma.actionable.findUniqueOrThrow({
        where: { id: claimedTask.id },
      })
    ).version;
    const protectedActivityCount = await prisma.activityEvent.count({
      where: { actionableId: claimedTask.id },
    });
    const before = await prisma.actionable.count();

    try {
      await prisma.$executeRaw`
        UPDATE "_prisma_migrations"
        SET rolled_back_at = CURRENT_TIMESTAMP
        WHERE migration_name = ${latest.migration_name}
      `;
      try {
        const blocked = errorOutput(
          await connected.client.callTool({
            name: "actionables.create_task",
            arguments: argumentsValue,
          }),
        );
        expect(blocked).toMatchObject({
          code: "SCHEMA_MIGRATION_REQUIRED",
          correlationId: "mcp-schema-readiness-test",
          retryMode: "after_state_change",
          recovery: { action: "migrate_database" },
          errors: { migrations: [`Incomplete: ${latest.migration_name}`] },
        });
        expect(await prisma.actionable.count()).toBe(before);

        for (const request of [
          {
            name: "actionables.get_task",
            arguments: {
              id: claimedTask.sourceOrdinal,
              claimToken: claimed.claim.claimToken,
            },
          },
          {
            name: "actionables.get_task_detail",
            arguments: {
              id: claimedTask.sourceOrdinal,
              claimToken: claimed.claim.claimToken,
              version: claimed.task.version,
              field: "finding",
            },
          },
        ]) {
          expect(
            errorOutput(await connected.client.callTool(request)),
          ).toMatchObject({
            code: "SCHEMA_MIGRATION_REQUIRED",
            retryMode: "after_state_change",
          });
        }
        expect(
          (
            await prisma.actionable.findUniqueOrThrow({
              where: { id: claimedTask.id },
            })
          ).version,
        ).toBe(protectedVersion);
        expect(
          await prisma.activityEvent.count({
            where: { actionableId: claimedTask.id },
          }),
        ).toBe(protectedActivityCount);
        expect(
          await prisma.agentTaskClaim.count({
            where: { actionableId: claimedTask.id },
          }),
        ).toBe(1);
      } finally {
        await prisma.$executeRaw`
          UPDATE "_prisma_migrations"
          SET rolled_back_at = NULL
          WHERE migration_name = ${latest.migration_name}
        `;
      }

      const created = output<{ id: number }>(
        await connected.client.callTool({
          name: "actionables.create_task",
          arguments: argumentsValue,
        }),
      );
      expect(created.id).toEqual(expect.any(Number));
      expect(await prisma.actionable.count()).toBe(before + 1);
    } finally {
      await connected.transport.close();
    }
  });

  it("uses the saved lease when MCP calls omit it and preserves explicit overrides", async () => {
    await getAgentCoordinationSettings(prisma);
    await prisma.helperAgentSettings.update({
      where: { id: "helper-agents" },
      data: { agentClaimLeaseMinutes: 45 },
    });
    const task = await createTask({ title: "Configured MCP lease" });
    const { client, transport } = await connectClient();

    try {
      const claimed = output<{
        task: { version: number };
        claim: {
          claimToken: string;
          claimedAt: string;
          leaseExpiresAt: string;
        };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: task.version,
          },
        }),
      );
      expect(
        Date.parse(claimed.claim.leaseExpiresAt) -
          Date.parse(claimed.claim.claimedAt),
      ).toBe(45 * 60_000);

      const omitted = output<{
        claimLease: { renewedAt: string; leaseExpiresAt: string };
      }>(
        await client.callTool({
          name: "actionables.renew_task_claim",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: claimed.claim.claimToken,
          },
        }),
      );
      const omittedDuration =
        Date.parse(omitted.claimLease.leaseExpiresAt) -
        Date.parse(omitted.claimLease.renewedAt);
      expect(omittedDuration).toBeGreaterThanOrEqual(45 * 60_000 - 1_000);
      expect(omittedDuration).toBeLessThanOrEqual(45 * 60_000);

      const explicit = output<{
        claimLease: { renewedAt: string; leaseExpiresAt: string };
      }>(
        await client.callTool({
          name: "actionables.renew_task_claim",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: claimed.claim.claimToken,
            leaseMinutes: 60,
          },
        }),
      );
      const explicitDuration =
        Date.parse(explicit.claimLease.leaseExpiresAt) -
        Date.parse(explicit.claimLease.renewedAt);
      expect(explicitDuration).toBeGreaterThanOrEqual(60 * 60_000 - 1_000);
      expect(explicitDuration).toBeLessThanOrEqual(60 * 60_000);

      output(
        await client.callTool({
          name: "actionables.release_task",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: claimed.claim.claimToken,
          },
        }),
      );
    } finally {
      await prisma.helperAgentSettings.update({
        where: { id: "helper-agents" },
        data: { agentClaimLeaseMinutes: 30 },
      });
      await transport.close();
    }
  });

  it("requires deliberate classification for every created task", async () => {
    const { client, transport } = await connectClient();
    const before = await prisma.actionable.count();
    try {
      const expectClassificationError = async (
        field: "priority" | "effort" | "tags",
        value: unknown,
        expectedMessage: string,
      ) => {
        const argumentsValue: Record<string, unknown> = {
          idempotencyKey: randomUUID(),
          ...scope,
          title: `Invalid ${field} classification`,
          ...validTaskClassification,
        };
        if (value === undefined) delete argumentsValue[field];
        else argumentsValue[field] = value;

        const message = validationErrorText(
          await client.callTool({
            name: "actionables.create_task",
            arguments: argumentsValue,
          }),
        );
        expect(message).toContain(field);
        expect(message).toContain(expectedMessage);
      };

      await expectClassificationError(
        "priority",
        undefined,
        "Choose a deliberate priority other than Unset.",
      );
      await expectClassificationError(
        "priority",
        "Unset",
        "Choose a deliberate priority other than Unset.",
      );
      await expectClassificationError(
        "effort",
        undefined,
        "Choose a deliberate effort estimate other than Unknown.",
      );
      await expectClassificationError(
        "effort",
        "Unknown",
        "Choose a deliberate effort estimate other than Unknown.",
      );
      await expectClassificationError(
        "tags",
        undefined,
        "Provide at least one meaningful tag.",
      );
      await expectClassificationError(
        "tags",
        [],
        "Provide at least one meaningful tag.",
      );
      await expectClassificationError("tags", [" "], "Provide a nonblank tag.");

      expect(await prisma.actionable.count()).toBe(before);
    } finally {
      await transport.close();
    }
  });

  it("gives targeted recovery for invalid coordination inputs", async () => {
    const task = await createTask({ title: "Schema recovery task" });
    const { client, transport } = await connectClient();
    try {
      const claimed = output<{
        task: { version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: task.version,
          },
        }),
      );
      const schemaError = async (
        name: string,
        argumentsValue: Record<string, unknown>,
        expected: string,
      ) => {
        const message = validationErrorText(
          await client.callTool({ name, arguments: argumentsValue }),
        );
        expect(message).toContain(expected);
      };
      const updateBase = {
        id: task.sourceOrdinal,
        claimToken: claimed.claim.claimToken,
        version: claimed.task.version,
        resolution: "This must not persist.",
      };
      const versionRecovery =
        "Use task.version from the preceding successful result";
      const tokenRecovery =
        "Use claim.claimToken returned by claim_task or recover_task_claim";
      const placementRecovery =
        "set both parentId and workItemId to the same authorized top-level Actionable ID";

      const withoutVersion: Record<string, unknown> = { ...updateBase };
      delete withoutVersion.version;
      await schemaError(
        "actionables.update_task",
        withoutVersion,
        versionRecovery,
      );
      await schemaError(
        "actionables.update_task",
        { ...updateBase, version: "current" },
        versionRecovery,
      );
      const withoutToken: Record<string, unknown> = { ...updateBase };
      delete withoutToken.claimToken;
      await schemaError("actionables.update_task", withoutToken, tokenRecovery);
      await schemaError(
        "actionables.update_task",
        { ...updateBase, claimToken: "discarded" },
        tokenRecovery,
      );
      await schemaError(
        "actionables.create_task",
        {
          idempotencyKey: randomUUID(),
          parentId: task.sourceOrdinal,
          title: "Missing work item placement",
          ...validTaskClassification,
        },
        placementRecovery,
      );
      await schemaError(
        "actionables.create_task",
        {
          idempotencyKey: randomUUID(),
          workItemId: task.sourceOrdinal,
          title: "Missing parent placement",
          ...validTaskClassification,
        },
        placementRecovery,
      );
      await schemaError(
        "actionables.handoff_task",
        {
          id: task.sourceOrdinal,
          claimToken: claimed.claim.claimToken,
          version: claimed.task.version,
        },
        "If no task content needs to change, call actionables.release_task instead.",
      );

      const stored = await prisma.actionable.findUniqueOrThrow({
        where: { id: task.id },
      });
      expect(stored.version).toBe(claimed.task.version);
      expect(stored.resolution).toBe("");
      await expect(
        prisma.agentTaskClaim.findUnique({
          where: { actionableId: task.id },
        }),
      ).resolves.not.toBeNull();

      output(
        await client.callTool({
          name: "actionables.release_task",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: claimed.claim.claimToken,
          },
        }),
      );
    } finally {
      await transport.close();
    }
  });

  it("creates top-level and direct-child tasks and returns the same task on retry", async () => {
    const { client, transport } = await connectClient();
    try {
      const topLevelKey = randomUUID();
      const topLevelArguments = {
        idempotencyKey: topLevelKey,
        ...scope,
        title: "Agent-created top-level task",
        priority: "High",
        description: "Created through the single MCP task operation.",
        effort: "S",
        plannedValidation: ["Verify top-level creation."],
        tags: ["planning", "backend"],
      };
      const topLevel = output<{
        id: number;
        recordId: string;
        title: string;
        priority: string;
        status: string;
        description: string;
        effort: string;
        plannedValidation: string[];
        tags: string[];
        version: number;
        parent: null;
        scope: typeof scope;
      }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: topLevelArguments,
        }),
      );
      expect(topLevel).toMatchObject({
        title: topLevelArguments.title,
        priority: "High",
        status: "Inbox",
        description: topLevelArguments.description,
        effort: "S",
        plannedValidation: topLevelArguments.plannedValidation,
        tags: topLevelArguments.tags,
        parent: null,
        scope,
      });
      const topLevelRetry = output<{ id: number; version: number }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: topLevelArguments,
        }),
      );
      expect(topLevelRetry).toEqual(
        expect.objectContaining({
          id: topLevel.id,
          version: topLevel.version,
        }),
      );
      const classificationConflict = errorOutput(
        await client.callTool({
          name: "actionables.create_task",
          arguments: { ...topLevelArguments, priority: "Low" },
        }),
      );
      expect(classificationConflict).toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        retryable: false,
      });

      const childKey = randomUUID();
      const childArguments = {
        idempotencyKey: childKey,
        workItemId: topLevel.id,
        parentId: topLevel.id,
        title: "Agent-created direct child",
        priority: "Medium",
        description: "Must inherit the parent scope.",
        effort: "M",
        plannedValidation: ["Verify direct hierarchy placement."],
        tags: ["planning", "frontend"],
      };
      const child = output<{
        id: number;
        recordId: string;
        title: string;
        priority: string;
        status: string;
        effort: string;
        parent: { id: number };
        scope: typeof scope;
        tags: string[];
        version: number;
      }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: childArguments,
        }),
      );
      expect(child).toMatchObject({
        title: childArguments.title,
        priority: childArguments.priority,
        status: "Inbox",
        effort: childArguments.effort,
        parent: { id: topLevel.id },
        scope,
        tags: childArguments.tags,
      });
      const childRetry = output<{ id: number; version: number }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: childArguments,
        }),
      );
      expect(childRetry).toEqual(
        expect.objectContaining({ id: child.id, version: child.version }),
      );

      expect(
        await prisma.actionable.count({
          where: {
            title: {
              in: [topLevelArguments.title, childArguments.title],
            },
          },
        }),
      ).toBe(2);
      expect(
        await prisma.hierarchyRelationship.count({
          where: {
            parentId: topLevel.recordId,
            child: { sourceOrdinal: child.id },
            detachedAt: null,
          },
        }),
      ).toBe(1);
      const storedTopLevel = await prisma.actionable.findUniqueOrThrow({
        where: { id: topLevel.recordId },
        include: { agentTaskClaim: true },
      });
      expect(storedTopLevel).toMatchObject({
        priority: topLevelArguments.priority,
        status: "Inbox",
        effort: topLevelArguments.effort,
        tagsJson: topLevelArguments.tags,
        agentTaskClaim: null,
        rawFragmentJson: { creatorThreadId: threadId },
      });
      const storedChild = await prisma.actionable.findUniqueOrThrow({
        where: { id: child.recordId },
        include: { agentTaskClaim: true },
      });
      expect(storedChild).toMatchObject({
        priority: childArguments.priority,
        status: "Inbox",
        effort: childArguments.effort,
        tagsJson: childArguments.tags,
        agentTaskClaim: null,
      });
    } finally {
      await transport.close();
    }
  });

  it("previews and applies bounded bulk creation with ordered compact replay receipts", async () => {
    const { client, transport } = await connectClient();
    const batchMarker = randomUUID();
    const items = Array.from({ length: 3 }, (_, index) => ({
      idempotencyKey: randomUUID(),
      ...scope,
      title: `Bulk create ${batchMarker} ${index}`,
      priority: "Medium" as const,
      description: `Prepared in bounded bulk item ${index}.`,
      effort: "S" as const,
      plannedValidation: [`Validate bounded item ${index}.`],
      tags: ["mcp", "bulk"],
    }));
    const titleWhere = { startsWith: `Bulk create ${batchMarker}` };
    type BulkItem = {
      index: number;
      outcome: "valid" | "created" | "replayed" | "failed";
      id?: number;
      version?: number;
      status?: string;
      error?: { code: string; detail: string };
    };
    type BulkResponse = {
      mode: "preview" | "apply";
      summary: {
        requested: number;
        succeeded: number;
        replayed: number;
        failed: number;
      };
      items: BulkItem[];
    };

    try {
      const before = await prisma.actionable.count({
        where: { title: titleWhere },
      });
      const preview = output<BulkResponse>(
        await client.callTool({
          name: "actionables.bulk_create_tasks",
          arguments: { mode: "preview", items },
        }),
      );
      expect(preview).toMatchObject({
        mode: "preview",
        summary: {
          requested: 3,
          succeeded: 3,
          replayed: 0,
          failed: 0,
        },
      });
      expect(preview.items).toHaveLength(3);
      expect(
        preview.items.map(({ index, outcome }) => ({ index, outcome })),
      ).toEqual(
        Array.from({ length: 3 }, (_, index) => ({
          index,
          outcome: "valid",
        })),
      );
      expect(
        await prisma.actionable.count({ where: { title: titleWhere } }),
      ).toBe(before);

      const applied = output<BulkResponse>(
        await client.callTool({
          name: "actionables.bulk_create_tasks",
          arguments: { mode: "apply", items },
        }),
      );
      expect(applied).toMatchObject({
        mode: "apply",
        summary: {
          requested: 3,
          succeeded: 3,
          replayed: 0,
          failed: 0,
        },
      });
      expect(applied.items.map((item) => item.index)).toEqual(
        Array.from({ length: 3 }, (_, index) => index),
      );
      expect(applied.items.every((item) => item.outcome === "created")).toBe(
        true,
      );
      expect(new Set(applied.items.map((item) => item.id)).size).toBe(3);
      expect(
        await prisma.actionable.count({ where: { title: titleWhere } }),
      ).toBe(before + 3);
      const serialized = JSON.stringify(applied);
      expect(serialized.length).toBeLessThan(64 * 1024);
      expect(serialized).not.toContain(items[0]!.description);
      expect(serialized).not.toContain("claimToken");

      const replayed = output<BulkResponse>(
        await client.callTool({
          name: "actionables.bulk_create_tasks",
          arguments: { mode: "apply", items },
        }),
      );
      expect(replayed.summary).toEqual({
        requested: 3,
        succeeded: 3,
        replayed: 3,
        failed: 0,
      });
      expect(replayed.items.every((item) => item.outcome === "replayed")).toBe(
        true,
      );
      expect(replayed.items.map((item) => item.id)).toEqual(
        applied.items.map((item) => item.id),
      );
      expect(
        await prisma.actionable.count({ where: { title: titleWhere } }),
      ).toBe(before + 3);

      const additional = {
        ...items[1]!,
        idempotencyKey: randomUUID(),
        title: `Bulk create ${batchMarker} additional`,
      };
      const mixed = output<BulkResponse>(
        await client.callTool({
          name: "actionables.bulk_create_tasks",
          arguments: {
            mode: "apply",
            items: [
              { ...items[0]!, title: `${items[0]!.title} changed` },
              additional,
            ],
          },
        }),
      );
      expect(mixed).toMatchObject({
        summary: { requested: 2, succeeded: 1, replayed: 0, failed: 1 },
        items: [
          {
            index: 0,
            outcome: "failed",
            error: { code: "IDEMPOTENCY_CONFLICT" },
          },
          { index: 1, outcome: "created" },
        ],
      });

      const beforeOversized = await prisma.actionable.count({
        where: { title: titleWhere },
      });
      const oversized = await client.callTool({
        name: "actionables.bulk_create_tasks",
        arguments: {
          mode: "apply",
          items: Array.from({ length: 26 }, (_, index) => ({
            ...items[index % items.length]!,
            idempotencyKey: randomUUID(),
            title: `Bulk create ${batchMarker} oversized ${index}`,
          })),
        },
      });
      expect(oversized.isError).toBe(true);
      expect(
        await prisma.actionable.count({ where: { title: titleWhere } }),
      ).toBe(beforeOversized);

      const malformed = await client.callTool({
        name: "actionables.bulk_create_tasks",
        arguments: {
          mode: "apply",
          items: [
            {
              ...items[0]!,
              idempotencyKey: randomUUID(),
              title: `Bulk create ${batchMarker} schema-valid sibling`,
            },
            {
              ...items[1]!,
              idempotencyKey: randomUUID(),
              title: `Bulk create ${batchMarker} malformed sibling`,
              tags: [],
            },
          ],
        },
      });
      expect(malformed.isError).toBe(true);
      expect(
        await prisma.actionable.count({ where: { title: titleWhere } }),
      ).toBe(beforeOversized);
    } finally {
      await transport.close();
    }
  });

  it("previews and atomically prepares bulk siblings with replay-safe partial results", async () => {
    const { client, transport } = await connectClient();
    const batchMarker = randomUUID();
    const createItems = Array.from({ length: 3 }, (_, index) => ({
      idempotencyKey: randomUUID(),
      ...scope,
      title: `Bulk prepare ${batchMarker} ${index}`,
      priority: "High" as const,
      description: `Bounded preparation task ${index}.`,
      effort: "S" as const,
      plannedValidation: [`Run initial check ${index}.`],
      tags: ["mcp", "bulk-prepare"],
    }));
    type BulkItem = {
      index: number;
      outcome: "created" | "valid" | "prepared" | "replayed" | "failed";
      id?: number;
      version?: number;
      status?: string;
      claimReleased?: boolean;
      error?: { code: string; detail: string };
    };
    type BulkResponse = {
      mode: "preview" | "apply";
      summary: {
        requested: number;
        succeeded: number;
        replayed: number;
        failed: number;
      };
      items: BulkItem[];
    };

    try {
      const created = output<BulkResponse>(
        await client.callTool({
          name: "actionables.bulk_create_tasks",
          arguments: { mode: "apply", items: createItems },
        }),
      );
      const createdTasks = created.items.map((item) => ({
        id: item.id!,
        version: item.version!,
      }));
      const preparationItems = createdTasks.map((task, index) => ({
        idempotencyKey: randomUUID(),
        id: task.id,
        workItemId: task.id,
        version: task.version,
        ...(index === 1
          ? {}
          : { finding: `Independently confirmed finding ${index}.` }),
        appendResearch: [`Inspected the relevant source for item ${index}.`],
        appendPlannedValidation: [`Run the focused regression ${index}.`],
        addUserSources: [
          {
            type: "File" as const,
            locator: `apps/api/src/bulk-${index}.ts`,
          },
        ],
      }));
      const beforePreview = await prisma.actionable.findMany({
        where: { sourceOrdinal: { in: createdTasks.map((task) => task.id) } },
        orderBy: { sourceOrdinal: "asc" },
        select: {
          sourceOrdinal: true,
          version: true,
          status: true,
          finding: true,
          researchJson: true,
          validationJson: true,
          agentTaskClaim: true,
          _count: { select: { statusHistory: true, activityEvents: true } },
        },
      });

      const preview = output<BulkResponse>(
        await client.callTool({
          name: "actionables.bulk_prepare_tasks",
          arguments: { mode: "preview", items: preparationItems },
        }),
      );
      expect(preview).toMatchObject({
        mode: "preview",
        summary: { requested: 3, succeeded: 2, replayed: 0, failed: 1 },
        items: [
          { index: 0, outcome: "valid" },
          {
            index: 1,
            outcome: "failed",
            error: { code: "READY_REQUIREMENTS_NOT_MET" },
          },
          { index: 2, outcome: "valid" },
        ],
      });
      expect(
        await prisma.actionable.findMany({
          where: { sourceOrdinal: { in: createdTasks.map((task) => task.id) } },
          orderBy: { sourceOrdinal: "asc" },
          select: {
            sourceOrdinal: true,
            version: true,
            status: true,
            finding: true,
            researchJson: true,
            validationJson: true,
            agentTaskClaim: true,
            _count: { select: { statusHistory: true, activityEvents: true } },
          },
        }),
      ).toEqual(beforePreview);

      const applied = output<BulkResponse>(
        await client.callTool({
          name: "actionables.bulk_prepare_tasks",
          arguments: { mode: "apply", items: preparationItems },
        }),
      );
      expect(applied).toMatchObject({
        mode: "apply",
        summary: { requested: 3, succeeded: 2, replayed: 0, failed: 1 },
        items: [
          {
            index: 0,
            outcome: "prepared",
            status: "Ready",
            claimReleased: true,
          },
          {
            index: 1,
            outcome: "failed",
            error: { code: "READY_REQUIREMENTS_NOT_MET" },
          },
          {
            index: 2,
            outcome: "prepared",
            status: "Ready",
            claimReleased: true,
          },
        ],
      });
      const serialized = JSON.stringify(applied);
      expect(serialized.length).toBeLessThan(64 * 1024);
      expect(serialized).not.toContain("claimToken");
      expect(serialized).not.toContain("Inspected the relevant source");

      const stored = await prisma.actionable.findMany({
        where: { sourceOrdinal: { in: createdTasks.map((task) => task.id) } },
        orderBy: { sourceOrdinal: "asc" },
        include: { agentTaskClaim: true },
      });
      expect(stored[0]).toMatchObject({
        status: "Ready",
        finding: "Independently confirmed finding 0.",
        researchJson: ["Inspected the relevant source for item 0."],
        validationJson: [
          "Run initial check 0.",
          "Run the focused regression 0.",
        ],
        agentTaskClaim: null,
      });
      expect(stored[1]).toMatchObject({
        version: createdTasks[1]!.version,
        status: "Inbox",
        finding: "",
        researchJson: [],
        validationJson: ["Run initial check 1."],
        agentTaskClaim: null,
      });
      expect(stored[2]).toMatchObject({
        status: "Ready",
        finding: "Independently confirmed finding 2.",
        researchJson: ["Inspected the relevant source for item 2."],
        validationJson: [
          "Run initial check 2.",
          "Run the focused regression 2.",
        ],
        agentTaskClaim: null,
      });
      const successfulBeforeReplay = await prisma.actionable.findMany({
        where: {
          sourceOrdinal: { in: [createdTasks[0]!.id, createdTasks[2]!.id] },
        },
        orderBy: { sourceOrdinal: "asc" },
        select: {
          version: true,
          status: true,
          _count: { select: { statusHistory: true, activityEvents: true } },
        },
      });

      const replayed = output<BulkResponse>(
        await client.callTool({
          name: "actionables.bulk_prepare_tasks",
          arguments: { mode: "apply", items: preparationItems },
        }),
      );
      expect(replayed).toMatchObject({
        summary: { requested: 3, succeeded: 2, replayed: 2, failed: 1 },
        items: [
          { index: 0, outcome: "replayed", status: "Ready" },
          { index: 1, outcome: "failed" },
          { index: 2, outcome: "replayed", status: "Ready" },
        ],
      });
      expect(
        await prisma.actionable.findMany({
          where: {
            sourceOrdinal: {
              in: [createdTasks[0]!.id, createdTasks[2]!.id],
            },
          },
          orderBy: { sourceOrdinal: "asc" },
          select: {
            version: true,
            status: true,
            _count: { select: { statusHistory: true, activityEvents: true } },
          },
        }),
      ).toEqual(successfulBeforeReplay);
    } finally {
      await transport.close();
    }
  });

  it("dismisses only an unclaimed task created by the calling Codex thread", async () => {
    const { client, transport } = await connectClient();
    const other = await connectClient(
      bearerToken,
      "019fa45f-581d-7bc0-afe3-a2b65171df63",
    );
    const withoutThread = await connectClient(bearerToken, null);
    try {
      const createArguments = (title: string) => ({
        idempotencyKey: randomUUID(),
        ...scope,
        title,
        ...validTaskClassification,
      });
      const created = output<{ id: number; recordId: string; version: number }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: createArguments("Same-thread dismissal"),
        }),
      );
      const dismissed = output<{ status: string; version: number }>(
        await client.callTool({
          name: "actionables.dismiss_task",
          arguments: {
            id: created.id,
            reason: "Disposable task created during this Codex thread.",
          },
        }),
      );
      expect(dismissed).toMatchObject({
        status: "Dismissed",
        version: created.version + 1,
        changedFields: ["status"],
        reconciliationFields: [],
        claimReleased: false,
        counts: [],
      });
      const stored = await prisma.actionable.findUniqueOrThrow({
        where: { id: created.recordId },
        include: {
          statusHistory: { orderBy: { occurredAt: "desc" }, take: 1 },
          activityEvents: { orderBy: { occurredAt: "desc" }, take: 1 },
        },
      });
      expect(stored).toMatchObject({
        status: "Dismissed",
        dismissalReasonMd: "Disposable task created during this Codex thread.",
      });
      expect(stored.statusHistory[0]).toMatchObject({
        previousStatus: "Inbox",
        newStatus: "Dismissed",
        origin: `agent:${agentId}`,
      });
      expect(stored.activityEvents[0]).toMatchObject({
        type: "dismissed",
        metadataJson: expect.objectContaining({
          reason: "Disposable task created during this Codex thread.",
          origin: `agent:${agentId}`,
        }),
      });

      const protectedTask = output<{
        id: number;
        recordId: string;
        version: number;
      }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: createArguments("Thread-protected dismissal"),
        }),
      );
      const wrongThread = errorOutput(
        await other.client.callTool({
          name: "actionables.dismiss_task",
          arguments: {
            id: protectedTask.id,
            reason: "Must not dismiss from another thread.",
          },
        }),
      );
      expect(wrongThread).toMatchObject({
        code: "CREATOR_THREAD_MISMATCH",
        retryable: false,
      });
      expect(
        (
          await prisma.actionable.findUniqueOrThrow({
            where: { id: protectedTask.recordId },
          })
        ).status,
      ).toBe("Inbox");

      const claimed = output<{
        task: { version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: protectedTask.id,
            workItemId: protectedTask.id,
            version: protectedTask.version,
          },
        }),
      );
      const liveClaim = errorOutput(
        await client.callTool({
          name: "actionables.dismiss_task",
          arguments: {
            id: protectedTask.id,
            reason: "Claimed work must use transition_task.",
          },
        }),
      );
      expect(liveClaim).toMatchObject({
        code: "ALREADY_CLAIMED",
        retryable: true,
      });
      output(
        await client.callTool({
          name: "actionables.release_task",
          arguments: {
            id: protectedTask.id,
            claimToken: claimed.claim.claimToken,
          },
        }),
      );

      const missingThread = errorOutput(
        await withoutThread.client.callTool({
          name: "actionables.list_tasks",
          arguments: { view: "mine" },
        }),
      );
      expect(missingThread).toMatchObject({
        code: "THREAD_ID_REQUIRED",
        retryMode: "after_state_change",
        recovery: { action: "resolve_state" },
        retryable: true,
      });
    } finally {
      await withoutThread.transport.close();
      await other.transport.close();
      await transport.close();
    }
  });

  it("atomically provisions and reuses scope from a local Git path", async () => {
    const { client, transport } = await connectClient();
    try {
      const before = {
        projects: await prisma.project.count(),
        repositories: await prisma.repository.count(),
        worktrees: await prisma.worktree.count(),
      };
      const argumentsValue = {
        idempotencyKey: randomUUID(),
        repositoryPath: repoRoot,
        ensureScope: true,
        title: "Task with automatically provisioned scope",
        ...validTaskClassification,
      };
      const created = output<{
        id: number;
        scope: {
          projectId: string;
          repositoryId: string;
          worktreeId: string;
        };
        scopeProvisioning: {
          ensured: true;
          repositoryPath: string;
          worktreePath: string;
          projectCreated: boolean;
          repositoryCreated: boolean;
          worktreeCreated: boolean;
        };
      }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: argumentsValue,
        }),
      );
      expect(created.scopeProvisioning).toMatchObject({
        ensured: true,
        projectCreated: true,
        repositoryCreated: true,
        worktreeCreated: true,
      });
      expect(created.scopeProvisioning.repositoryPath.toLowerCase()).toBe(
        repoRoot.toLowerCase(),
      );
      expect(await prisma.project.count()).toBe(before.projects + 1);
      expect(await prisma.repository.count()).toBe(before.repositories + 1);
      expect(await prisma.worktree.count()).toBe(before.worktrees + 1);

      const second = output<{
        scope: typeof created.scope;
        scopeProvisioning: typeof created.scopeProvisioning;
      }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            ...argumentsValue,
            idempotencyKey: randomUUID(),
            title: "Second task in automatically provisioned scope",
          },
        }),
      );
      expect(second.scope).toEqual(created.scope);
      expect(second.scopeProvisioning).toMatchObject({
        projectCreated: false,
        repositoryCreated: false,
        worktreeCreated: false,
      });
      expect(await prisma.project.count()).toBe(before.projects + 1);
      expect(await prisma.repository.count()).toBe(before.repositories + 1);
      expect(await prisma.worktree.count()).toBe(before.worktrees + 1);

      const retry = output<{ id: number }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: argumentsValue,
        }),
      );
      expect(retry.id).toBe(created.id);
    } finally {
      await transport.close();
    }
  }, 15_000);

  it("selects the longest registered monorepo project and preserves worktree ownership", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "actionables-monorepo-"));
    const checkout = resolve(directory, "main");
    const worktree = resolve(directory, "branch");
    await mkdir(checkout);
    execFileSync("git", ["init", checkout], {
      stdio: "pipe",
      windowsHide: true,
    });
    for (const root of ["", "apps/alpha", "apps/alpha/nested", "apps/beta"]) {
      await mkdir(resolve(checkout, root), { recursive: true });
      await writeFile(
        resolve(checkout, root, "AGENTS.md"),
        `Instructions for ${root || "root"}`,
      );
    }
    execFileSync("git", ["-C", checkout, "add", "."], {
      stdio: "pipe",
      windowsHide: true,
    });
    execFileSync(
      "git",
      [
        "-C",
        checkout,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "fixture",
      ],
      { stdio: "pipe", windowsHide: true },
    );
    execFileSync(
      "git",
      ["-C", checkout, "worktree", "add", "-b", "fixture-branch", worktree],
      { stdio: "pipe", windowsHide: true },
    );
    const project = await prisma.project.create({
      data: { externalKey: randomUUID(), name: "Monorepo projects" },
    });
    const repositories = [];
    for (const projectRoot of ["apps/alpha", "apps/alpha/nested", "apps/beta"])
      repositories.push(
        await prisma.repository.create({
          data: {
            externalKey: randomUUID(),
            projectId: project.id,
            name: projectRoot,
            localPath: checkout,
            projectRoot,
          },
        }),
      );
    const { client, transport } = await connectClient();
    const create = (repositoryPath: string) =>
      client.callTool({
        name: "actionables.create_task",
        arguments: {
          idempotencyKey: randomUUID(),
          repositoryPath,
          ensureScope: true,
          title: "Monorepo scope fixture",
          ...validTaskClassification,
        },
      });
    try {
      for (const path of [checkout, worktree]) {
        expect(errorOutput(await create(path)).code).toBe("INVALID_REQUEST");
        for (const repository of repositories) {
          const result = output<{
            scope: { repositoryId: string; worktreeId: string };
          }>(await create(resolve(path, repository.projectRoot!)));
          expect(result.scope.repositoryId).toBe(repository.id);
          const saved = await prisma.worktree.findUniqueOrThrow({
            where: { id: result.scope.worktreeId },
          });
          expect(saved).toMatchObject({
            projectId: project.id,
            repositoryId: repository.id,
            localPath: await realpath(path),
          });
          const retry = output<{ scope: typeof result.scope }>(
            await create(resolve(path, repository.projectRoot!)),
          );
          expect(retry.scope).toEqual(result.scope);
        }
      }
      const duplicate = await prisma.repository.create({
        data: {
          externalKey: randomUUID(),
          projectId: project.id,
          name: "Ambiguous older scope",
          localPath: checkout,
          projectRoot: "apps/alpha",
        },
      });
      expect(
        errorOutput(await create(resolve(checkout, "apps/alpha"))).code,
      ).toBe("INVALID_REQUEST");
      await prisma.repository.delete({ where: { id: duplicate.id } });
    } finally {
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects a non-Git repositoryPath without leaving partial scope records", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "actionables-scope-"));
    const before = {
      projects: await prisma.project.count(),
      repositories: await prisma.repository.count(),
      worktrees: await prisma.worktree.count(),
      actionables: await prisma.actionable.count(),
    };
    const { client, transport } = await connectClient();
    try {
      const error = errorOutput(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            idempotencyKey: randomUUID(),
            repositoryPath: directory,
            ensureScope: true,
            title: "Task with invalid automatic scope",
            ...validTaskClassification,
          },
        }),
      );
      expect(error).toMatchObject({
        code: "INVALID_REQUEST",
        retryMode: "after_input_change",
        recovery: { action: "modify_request" },
        retryable: false,
        nextAction: expect.stringContaining("corrected arguments"),
        errors: { repositoryPath: expect.any(Array) },
      });
      expect(await prisma.project.count()).toBe(before.projects);
      expect(await prisma.repository.count()).toBe(before.repositories);
      expect(await prisma.worktree.count()).toBe(before.worktrees);
      expect(await prisma.actionable.count()).toBe(before.actionables);
    } finally {
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed placement, unknown or nested parents, and conflicting retries", async () => {
    const root = await createTask({ title: "Creation boundary root" });
    const { client, transport } = await connectClient();
    try {
      for (const argumentsValue of [
        {
          idempotencyKey: randomUUID(),
          title: "Missing top-level scope",
        },
        {
          idempotencyKey: "not-a-uuid",
          ...scope,
          title: "Malformed idempotency key",
        },
        {
          idempotencyKey: randomUUID(),
          workItemId: root.sourceOrdinal,
          parentId: root.sourceOrdinal,
          ...scope,
          title: "Parent plus forbidden explicit scope",
        },
        {
          idempotencyKey: randomUUID(),
          parentId: root.sourceOrdinal,
          title: "Parent without an authorized work item",
        },
        {
          idempotencyKey: randomUUID(),
          repositoryPath: repoRoot,
          title: "Repository path without provisioning permission",
        },
        {
          idempotencyKey: randomUUID(),
          ensureScope: true,
          title: "Provisioning permission without a repository path",
        },
        {
          idempotencyKey: randomUUID(),
          ...scope,
          repositoryPath: repoRoot,
          ensureScope: true,
          title: "Existing and automatic scope together",
        },
        {
          idempotencyKey: randomUUID(),
          workItemId: root.sourceOrdinal,
          parentId: 0,
          title: "Invalid parent ID",
        },
        {
          idempotencyKey: randomUUID(),
          ...scope,
          title: " ",
        },
      ]) {
        expect(
          (
            await client.callTool({
              name: "actionables.create_task",
              arguments: { ...validTaskClassification, ...argumentsValue },
            })
          ).isError,
        ).toBe(true);
      }

      const unknownParent = errorOutput(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            idempotencyKey: randomUUID(),
            workItemId: 999_999,
            parentId: 999_999,
            title: "Unknown parent",
            ...validTaskClassification,
          },
        }),
      );
      expect(unknownParent).toMatchObject({
        code: "NOT_FOUND",
        errors: { parentId: expect.any(Array) },
      });

      const invalidScope = errorOutput(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            idempotencyKey: randomUUID(),
            projectId: "missing-project",
            repositoryId: "missing-repository",
            worktreeId: "missing-worktree",
            title: "Invalid top-level scope",
            ...validTaskClassification,
          },
        }),
      );
      expect(invalidScope).toMatchObject({
        code: "INVALID_SCOPE",
        retryMode: "after_input_change",
        recovery: { action: "modify_request" },
        errors: {
          projectId: expect.any(Array),
          repositoryId: expect.any(Array),
          worktreeId: expect.any(Array),
        },
      });

      const child = output<{ id: number }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            idempotencyKey: randomUUID(),
            workItemId: root.sourceOrdinal,
            parentId: root.sourceOrdinal,
            title: "Existing direct child",
            ...validTaskClassification,
          },
        }),
      );
      const nested = errorOutput(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            idempotencyKey: randomUUID(),
            workItemId: root.sourceOrdinal,
            parentId: child.id,
            title: "Forbidden grandchild",
            ...validTaskClassification,
          },
        }),
      );
      expect(nested).toMatchObject({
        code: "INVALID_REQUEST",
        errors: { parentId: expect.any(Array) },
      });

      const reusedKey = randomUUID();
      const originalArguments = {
        idempotencyKey: reusedKey,
        ...scope,
        title: "Original keyed task",
        ...validTaskClassification,
      };
      const original = output<{ id: number }>(
        await client.callTool({
          name: "actionables.create_task",
          arguments: originalArguments,
        }),
      );
      const conflict = errorOutput(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            ...originalArguments,
            title: "Different task with reused key",
          },
        }),
      );
      expect(conflict).toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        retryable: false,
      });
      expect(
        await prisma.actionable.count({
          where: {
            sourceOrdinal: original.id,
            title: originalArguments.title,
          },
        }),
      ).toBe(1);
    } finally {
      await transport.close();
    }
  });

  it("returns bounded public claim and recovery responses for a large work item", async () => {
    const root = await createTask({
      status: "Ready",
      title: "Large MCP work item",
    });
    const children = await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        createTask({ title: `Large MCP child ${index + 1}` }),
      ),
    );
    await prisma.hierarchyRelationship.createMany({
      data: children.map((child) => ({
        parentId: root.id,
        childId: child.id,
        provenance: "test",
      })),
    });

    const { client, transport } = await connectClient();
    try {
      const fullPage = output<{ items: unknown[]; hasMore: boolean }>(
        await client.callTool({
          name: "actionables.list_tasks",
          arguments: {
            view: "available",
            workItemId: root.sourceOrdinal,
            limit: 100,
          },
        }),
      );
      expect(fullPage.items).toHaveLength(100);
      expect(fullPage.hasMore).toBe(true);
      const claimed = output<{
        task: {
          version: number;
          subtasks: Array<{ id: number }>;
          truncation: { omitted: { subtasks: number } };
        };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: root.sourceOrdinal,
            workItemId: root.sourceOrdinal,
            version: root.version,
          },
        }),
      );
      expect(claimed.task.subtasks).toHaveLength(5);
      expect(claimed.task.truncation.omitted.subtasks).toBe(96);

      const recovered = output<{
        task: {
          version: number;
          subtasks: Array<{ id: number }>;
          truncation: { omitted: { subtasks: number } };
        };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.recover_task_claim",
          arguments: {
            id: root.sourceOrdinal,
            version: claimed.task.version,
          },
        }),
      );
      expect(recovered.task).toMatchObject({
        version: claimed.task.version + 1,
        truncation: { omitted: { subtasks: 96 } },
      });
      expect(recovered.task.subtasks).toHaveLength(5);
      expect(recovered.claim.claimToken).not.toBe(claimed.claim.claimToken);

      const released = output<{
        version: number;
        claimReleased: boolean;
        changedFields: string[];
      }>(
        await client.callTool({
          name: "actionables.release_task",
          arguments: {
            id: root.sourceOrdinal,
            claimToken: recovered.claim.claimToken,
          },
        }),
      );
      expect(released).toMatchObject({
        version: recovered.task.version + 1,
        claimReleased: true,
        changedFields: [],
      });
      expect(
        await prisma.activityEvent.count({
          where: { actionableId: root.id, type: "agent-released" },
        }),
      ).toBe(1);
    } finally {
      await transport.close();
    }
  });

  it("runs list, claim-with-detail, update, transition, validation, and release", async () => {
    const task = await createTask({
      status: "Inbox",
      title: "End-to-end MCP workflow",
    });
    const { client, transport } = await connectClient();
    try {
      const listed = output<{
        items: Array<{
          id: number;
          version: number;
          readiness: { requiredForReady: string[] };
        }>;
        hasMore: boolean;
      }>(
        await client.callTool({
          name: "actionables.list_tasks",
          arguments: {
            view: "available",
            workItemId: task.sourceOrdinal,
            limit: 100,
          },
        }),
      );
      const available = listed.items.find(
        (item) => item.id === task.sourceOrdinal,
      );
      expect(available).toBeDefined();
      expect(listed.hasMore).toBe(false);
      expect(available!.readiness.requiredForReady).toEqual([
        "researchPhase",
        "research",
      ]);

      const claimed = output<{
        task: {
          title: string;
          version: number;
          readiness: { requiredForReady: string[] };
          permittedTransitions: string[];
        };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: available!.version,
            leaseMinutes: 30,
          },
        }),
      );
      expect(claimed.task.title).toBe("End-to-end MCP workflow");
      expect(claimed.task.readiness.requiredForReady).toEqual([
        "researchPhase",
        "research",
      ]);
      expect(claimed.task.permittedTransitions).not.toContain("Ready");
      expect(
        (
          await prisma.agentTaskClaim.findUniqueOrThrow({
            where: { actionableId: task.id },
          })
        ).agentId,
      ).toBe(agentId);
      const credentials = {
        id: task.sourceOrdinal,
        claimToken: claimed.claim.claimToken,
      };

      const renewed = output<{
        version: number;
        claimLease: { renewedAt: string; leaseExpiresAt: string };
      }>(
        await client.callTool({
          name: "actionables.renew_task_claim",
          arguments: { ...credentials, leaseMinutes: 60 },
        }),
      );
      expect(renewed.version).toBe(claimed.task.version);
      expect(Date.parse(renewed.claimLease.leaseExpiresAt)).toBeGreaterThan(
        Date.parse(renewed.claimLease.renewedAt),
      );

      const skippedResearch = errorOutput(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: claimed.task.version,
            status: "Ready",
          },
        }),
      );
      expect(skippedResearch).toMatchObject({
        code: "RESEARCH_PHASE_REQUIRED",
        retryable: true,
        nextAction: expect.stringContaining("Researching"),
      });

      const researching = output<{ status: string; version: number }>(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: claimed.task.version,
            status: "Researching",
          },
        }),
      );
      expect(researching.status).toBe("Researching");
      expect(researching).toMatchObject({
        changedFields: ["status"],
        reconciliationFields: [],
        claimReleased: false,
      });

      const missingResearch = errorOutput(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: researching.version,
            status: "Ready",
          },
        }),
      );
      expect(missingResearch).toMatchObject({
        code: "READY_REQUIREMENTS_NOT_MET",
        retryMode: "after_state_change",
        recovery: { action: "resolve_state" },
        retryable: true,
        errors: { research: expect.any(Array) },
        nextAction: expect.stringContaining("appendResearch"),
      });

      const researched = output<{
        id: number;
        version: number;
        status: string;
        changedFields: string[];
        reconciliationFields: string[];
        counts: Array<{
          field: string;
          persisted: number;
          duplicatesIgnored: number;
        }>;
        lifecycleGuidance?: string;
      }>(
        await client.callTool({
          name: "actionables.update_task",
          arguments: {
            ...credentials,
            version: researching.version,
            appendResearch: [
              "The lifecycle authority is the correct boundary.",
            ],
          },
        }),
      );
      expect(researched).toMatchObject({
        id: task.sourceOrdinal,
        version: researching.version + 1,
        status: "Researching",
        changedFields: ["research"],
        reconciliationFields: ["research"],
        counts: [{ field: "research", persisted: 1, duplicatesIgnored: 0 }],
        readiness: { requiredForReady: [], blockers: [] },
        permittedTransitions: expect.arrayContaining(["Ready"]),
        lifecycleGuidance: expect.stringContaining("Ready is now permitted"),
      });

      const ready = output<{ status: string; version: number }>(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: researched.version,
            status: "Ready",
          },
        }),
      );
      expect(ready.status).toBe("Ready");
      expect(ready).toMatchObject({
        changedFields: ["status"],
        reconciliationFields: [],
        claimReleased: false,
      });

      let inProgress = output<{ status: string; version: number }>(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: ready.version,
            status: "In progress",
          },
        }),
      );
      expect(inProgress.status).toBe("In progress");

      const missingRollbackReason = errorOutput(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: inProgress.version,
            status: "Researching",
          },
        }),
      );
      expect(missingRollbackReason).toMatchObject({ code: "REASON_REQUIRED" });

      const rolledBack = output<{ status: string; version: number }>(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: inProgress.version,
            status: "Researching",
            reason: "Implementation uncovered a question requiring research.",
          },
        }),
      );
      expect(rolledBack.status).toBe("Researching");
      expect(
        await prisma.activityEvent.findFirstOrThrow({
          where: { actionableId: task.id, type: "research-reopened" },
        }),
      ).toMatchObject({
        summary: "Returned implementation to Researching",
        metadataJson: expect.objectContaining({
          reason: "Implementation uncovered a question requiring research.",
        }),
      });

      const readyAgain = output<{ status: string; version: number }>(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: rolledBack.version,
            status: "Ready",
          },
        }),
      );
      inProgress = output<{ status: string; version: number }>(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: readyAgain.version,
            status: "In progress",
          },
        }),
      );

      const missingResolution = errorOutput(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: inProgress.version,
            status: "Done",
          },
        }),
      );
      expect(missingResolution).toMatchObject({
        code: "RESOLUTION_REQUIRED",
        retryable: true,
        nextAction: expect.stringContaining("update_task"),
      });

      const updated = output<{
        changedFields: string[];
        reconciliationFields: string[];
        research: string[];
        version: number;
      }>(
        await client.callTool({
          name: "actionables.update_task",
          arguments: {
            ...credentials,
            version: inProgress.version,
            finding: "The official MCP client completed a real request.",
            resolution:
              "Completed the MCP request path and retained the existing claim lifecycle.",
          },
        }),
      );
      expect(updated).toMatchObject({
        changedFields: ["finding", "resolution"],
        reconciliationFields: ["finding"],
      });
      expect(
        await prisma.actionable.findUniqueOrThrow({ where: { id: task.id } }),
      ).toMatchObject({
        finding: "The official MCP client completed a real request.",
        resolution:
          "Completed the MCP request path and retained the existing claim lifecycle.",
      });

      const validated = output<{
        validation: {
          id: string;
          qualifiesForCompletion: boolean;
        };
        counts: Array<{ field: string; persisted: number }>;
        version: number;
      }>(
        await client.callTool({
          name: "actionables.record_task_validation",
          arguments: {
            ...credentials,
            version: updated.version,
            type: "Command",
            outcome: "Passed",
            notes: "Focused MCP workflow passed.",
            evidence:
              "Official SDK client calls returned valid structured results.",
          },
        }),
      );
      expect(validated.validation).toMatchObject({
        id: expect.any(String),
        qualifiesForCompletion: true,
      });
      expect(
        await prisma.validationRecord.findUniqueOrThrow({
          where: { id: validated.validation.id },
        }),
      ).toMatchObject({
        notesMd: "Focused MCP workflow passed.",
        evidenceMd:
          "Official SDK client calls returned valid structured results.",
      });
      expect(validated.counts).toEqual([
        expect.objectContaining({ field: "validationRecords", persisted: 1 }),
      ]);

      const released = output<{ version: number; claimReleased: boolean }>(
        await client.callTool({
          name: "actionables.release_task",
          arguments: credentials,
        }),
      );
      expect(released).toMatchObject({
        version: validated.version + 1,
        claimReleased: true,
      });
    } finally {
      await transport.close();
    }
  });

  it("recovers discarded credentials only for the owning Codex thread", async () => {
    const task = await createTask({
      status: "Ready",
      title: "Recover lost claim credentials",
    });
    const owner = await connectClient();
    const other = await connectClient(
      bearerToken,
      "019fa45f-581d-7bc0-afe3-a2b65171df68",
    );
    try {
      const claimed = output<{
        task: { version: number };
        claim: { claimToken: string; leaseExpiresAt: string };
      }>(
        await owner.client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: task.version,
          },
        }),
      );

      const repeatedClaim = errorOutput(
        await owner.client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: claimed.task.version,
          },
        }),
      );
      expect(repeatedClaim).toMatchObject({
        code: "OWN_CLAIM_ACTIVE",
        currentVersion: claimed.task.version,
        retryable: true,
        nextAction: expect.stringContaining("actionables.recover_task_claim"),
      });

      const mine = output<{
        items: Array<{ id: number; version: number }>;
      }>(
        await owner.client.callTool({
          name: "actionables.list_tasks",
          arguments: { view: "mine", workItemId: task.sourceOrdinal },
        }),
      );
      const current = mine.items.find((item) => item.id === task.sourceOrdinal);
      expect(current?.version).toBe(claimed.task.version);

      const wrongThread = errorOutput(
        await other.client.callTool({
          name: "actionables.recover_task_claim",
          arguments: {
            id: task.sourceOrdinal,
            version: current!.version,
          },
        }),
      );
      expect(wrongThread).toMatchObject({
        code: "CLAIM_OWNER_MISMATCH",
        retryMode: "after_state_change",
        recovery: {
          action: "resolve_state",
          retryAt: claimed.claim.leaseExpiresAt,
        },
        retryable: true,
      });

      const recovered = output<{
        task: { version: number };
        claim: { claimToken: string; claimedAt: string };
      }>(
        await owner.client.callTool({
          name: "actionables.recover_task_claim",
          arguments: {
            id: task.sourceOrdinal,
            version: current!.version,
            leaseMinutes: 60,
          },
        }),
      );
      expect(recovered.task.version).toBe(claimed.task.version + 1);
      expect(recovered.claim.claimToken).not.toBe(claimed.claim.claimToken);

      const superseded = errorOutput(
        await owner.client.callTool({
          name: "actionables.get_task",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: claimed.claim.claimToken,
          },
        }),
      );
      expect(superseded).toMatchObject({
        code: "INVALID_CLAIM_TOKEN",
        retryable: true,
        nextAction: expect.stringContaining("actionables.recover_task_claim"),
      });

      const updated = output<{
        changedFields: string[];
        reconciliationFields: string[];
      }>(
        await owner.client.callTool({
          name: "actionables.update_task",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: recovered.claim.claimToken,
            version: recovered.task.version,
            title: "Recovered credential completed a mutation",
          },
        }),
      );
      expect(updated).toMatchObject({
        changedFields: ["title"],
        reconciliationFields: [],
      });
      expect(
        (await prisma.actionable.findUniqueOrThrow({ where: { id: task.id } }))
          .title,
      ).toBe("Recovered credential completed a mutation");
    } finally {
      await other.transport.close();
      await owner.transport.close();
    }
  });

  it("atomically saves a handoff and releases the claim through the official client", async () => {
    const task = await createTask({
      status: "Ready",
      title: "Atomic MCP handoff",
    });
    await prisma.actionable.update({
      where: { id: task.id },
      data: { researchJson: json(["The handoff path was investigated."]) },
    });
    const { client, transport } = await connectClient();
    try {
      const claimed = output<{
        task: { version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: task.version,
          },
        }),
      );
      const credentials = {
        id: task.sourceOrdinal,
        claimToken: claimed.claim.claimToken,
      };
      const inProgress = output<{ version: number }>(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: claimed.task.version,
            status: "In progress",
          },
        }),
      );

      const handedOff = output<{
        claimReleased: true;
        changedFields: string[];
        reconciliationFields: string[];
        counts: Array<{
          field: string;
          persisted: number;
          duplicatesIgnored: number;
        }>;
        validation: { id: string; qualifiesForCompletion: boolean };
      }>(
        await client.callTool({
          name: "actionables.handoff_task",
          arguments: {
            ...credentials,
            version: inProgress.version,
            finding: "The atomic MCP handoff completed.",
            addFiles: [
              {
                path: "apps/api/src/agent-tasks.ts",
                symbol: "handoffClaimedAgentTask",
              },
              {
                path: "apps/api/src/agent-tasks.ts",
                symbol: "handoffClaimedAgentTask",
              },
            ],
            appendResearch: ["The transaction boundary is verified."],
            appendPlannedValidation: ["Run the atomic handoff test."],
            validation: {
              type: "Automated test",
              outcome: "Passed",
              notes: "Atomic handoff integration passed.",
              evidence: "The official MCP client received a valid result.",
            },
          },
        }),
      );
      expect(handedOff).toMatchObject({
        claimReleased: true,
        changedFields: [
          "finding",
          "research",
          "plannedValidation",
          "files",
          "validationRecords",
        ],
        reconciliationFields: [
          "finding",
          "research",
          "plannedValidation",
          "files",
        ],
      });
      expect(handedOff.validation).toMatchObject({
        id: expect.any(String),
        qualifiesForCompletion: true,
      });
      expect(
        await prisma.validationRecord.findUniqueOrThrow({
          where: { id: handedOff.validation.id },
        }),
      ).toMatchObject({ notesMd: "Atomic handoff integration passed." });
      expect(handedOff.counts).toEqual([
        { field: "research", persisted: 1, duplicatesIgnored: 0 },
        {
          field: "plannedValidation",
          persisted: 1,
          duplicatesIgnored: 0,
        },
        { field: "files", persisted: 1, duplicatesIgnored: 1 },
        {
          field: "validationRecords",
          persisted: 1,
          duplicatesIgnored: 0,
        },
      ]);
      expect(
        await prisma.actionable.findUniqueOrThrow({ where: { id: task.id } }),
      ).toMatchObject({
        finding: "The atomic MCP handoff completed.",
        researchJson: [
          "The handoff path was investigated.",
          "The transaction boundary is verified.",
        ],
        validationJson: [
          "Run the MCP integration test.",
          "Run the atomic handoff test.",
        ],
      });
      expect(
        await prisma.agentTaskClaim.findUnique({
          where: { actionableId: task.id },
        }),
      ).toBeNull();
    } finally {
      await transport.close();
    }
  });

  it("returns lean authoritative research receipts with conditional lifecycle guidance", async () => {
    const researchingTask = await createTask({
      status: "Researching",
      title: "Research receipt",
    });
    await prisma.actionable.update({
      where: { id: researchingTask.id },
      data: { finding: "", researchJson: json(["Existing note"]) },
    });
    const readyTask = await createTask({
      status: "Ready",
      title: "Ready research receipt",
    });
    const { client, transport } = await connectClient();
    try {
      const researchingClaim = output<{
        task: { version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: researchingTask.sourceOrdinal,
            workItemId: researchingTask.sourceOrdinal,
            version: researchingTask.version,
          },
        }),
      );
      const credentials = {
        id: researchingTask.sourceOrdinal,
        claimToken: researchingClaim.claim.claimToken,
      };

      const mixed = output<{
        id: number;
        version: number;
        status: string;
        changedFields: string[];
        reconciliationFields: string[];
        counts: Array<{
          field: string;
          persisted: number;
          duplicatesIgnored: number;
        }>;
        lifecycleGuidance?: string;
      }>(
        await client.callTool({
          name: "actionables.update_task",
          arguments: {
            ...credentials,
            version: researchingClaim.task.version,
            appendResearch: [
              "Existing note",
              "New note",
              "New note",
              "Another note",
            ],
            appendPlannedValidation: ["New check", "New check"],
            addUserSources: [
              { type: "Command", locator: "pnpm test" },
              { type: "Command", locator: "pnpm test" },
            ],
          },
        }),
      );
      expect(mixed).toMatchObject({
        id: researchingTask.sourceOrdinal,
        version: researchingClaim.task.version + 1,
        status: "Researching",
        changedFields: ["research", "plannedValidation", "userSources"],
        reconciliationFields: ["research", "plannedValidation", "userSources"],
        counts: [
          { field: "research", persisted: 2, duplicatesIgnored: 2 },
          {
            field: "plannedValidation",
            persisted: 2,
            duplicatesIgnored: 0,
          },
          { field: "userSources", persisted: 1, duplicatesIgnored: 1 },
        ],
        readiness: {
          requiredForReady: ["finding"],
          blockers: [expect.objectContaining({ field: "finding" })],
        },
        permittedTransitions: expect.not.arrayContaining(["Ready"]),
        lifecycleGuidance: expect.stringContaining("Ready remains unavailable"),
      });
      expect(mixed.lifecycleGuidance).toContain("Keep the task Researching");
      expect(mixed.lifecycleGuidance).toContain("finding");
      expect(
        (
          await prisma.actionable.findUniqueOrThrow({
            where: { id: researchingTask.id },
          })
        ).researchJson,
      ).toEqual(["Existing note", "New note", "Another note"]);

      const duplicatesOnly = output<Record<string, unknown>>(
        await client.callTool({
          name: "actionables.update_task",
          arguments: {
            ...credentials,
            version: mixed.version,
            appendResearch: ["Existing note", "New note"],
          },
        }),
      );
      expect(duplicatesOnly).toMatchObject({
        id: researchingTask.sourceOrdinal,
        version: mixed.version + 1,
        status: "Researching",
        changedFields: [],
        reconciliationFields: [],
        counts: [{ field: "research", persisted: 0, duplicatesIgnored: 2 }],
        readiness: {
          requiredForReady: ["finding"],
        },
        permittedTransitions: expect.not.arrayContaining(["Ready"]),
        lifecycleGuidance: expect.stringContaining("Ready remains unavailable"),
      });

      const readyClaim = output<{
        task: { version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: readyTask.sourceOrdinal,
            workItemId: readyTask.sourceOrdinal,
            version: readyTask.version,
          },
        }),
      );
      const readyReceipt = output<Record<string, unknown>>(
        await client.callTool({
          name: "actionables.update_task",
          arguments: {
            id: readyTask.sourceOrdinal,
            claimToken: readyClaim.claim.claimToken,
            version: readyClaim.task.version,
            appendResearch: ["Ready-state note"],
          },
        }),
      );
      expect(readyReceipt).toMatchObject({
        id: readyTask.sourceOrdinal,
        version: readyClaim.task.version + 1,
        status: "Ready",
        changedFields: ["research"],
        reconciliationFields: ["research"],
        counts: [{ field: "research", persisted: 1, duplicatesIgnored: 0 }],
        readiness: { requiredForReady: [], blockers: [] },
        permittedTransitions: expect.not.arrayContaining(["Ready"]),
      });
    } finally {
      await transport.close();
    }
  });

  it("keeps oversized task detail below the context budget and reports omissions", async () => {
    const finding = "f".repeat(100_000);
    const description = "d".repeat(100_000);
    const research = Array.from(
      { length: 12 },
      (_, index) => `research-${index}-${"r".repeat(1_000)}`,
    );
    const plannedValidation = Array.from(
      { length: 12 },
      (_, index) => `validation-${index}-${"p".repeat(1_000)}`,
    );
    const files = Array.from({ length: 12 }, (_, index) => ({
      path: `file-${index}-${"a".repeat(2_000)}`,
      lines: `line-${index}-${"1".repeat(500)}`,
    }));
    const userSources = Array.from({ length: 10 }, (_, index) => ({
      type: "URL",
      locator: `https://example.test/${index}/${"s".repeat(1_000)}`,
      label: `Source ${index} ${"l".repeat(150)}`,
    }));
    const parent = await createTask({
      title: `Parent ${"p".repeat(180)}`,
    });
    const task = await createTask({
      title: `Bounded detail ${"x".repeat(180)}`,
    });
    const related = await Promise.all(
      Array.from({ length: 36 }, (_, index) =>
        createTask({
          title: `Related ${index} ${"r".repeat(220)}`,
        }),
      ),
    );
    await prisma.hierarchyRelationship.create({
      data: {
        parentId: parent.id,
        childId: task.id,
        provenance: "test",
      },
    });
    await prisma.actionable.update({
      where: { id: task.id },
      data: {
        finding,
        description,
        resolution: "x".repeat(100_000),
        researchJson: json(research),
        validationJson: json(plannedValidation),
        tagsJson: json(
          Array.from({ length: 20 }, (_, index) => `tag-${index}`),
        ),
        filesJson: json(files),
      },
    });
    await prisma.userSourceReference.createMany({
      data: userSources.map((source, index) => ({
        actionableId: task.id,
        ...source,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      })),
    });
    await prisma.validationRecord.createMany({
      data: Array.from({ length: 10 }, () => ({
        actionableId: task.id,
        type: "Command",
        outcome: "Passed",
        notesMd: "n".repeat(2_000),
        evidenceMd: "e".repeat(2_000),
        origin: "o".repeat(200),
      })),
    });
    for (const [index, item] of related.entries()) {
      await prisma.hierarchyRelationship.create({
        data: {
          parentId: task.id,
          childId: item.id,
          provenance: "test",
        },
      });
      if (index < 18) {
        await prisma.dependencyRelationship.create({
          data: {
            dependentId: task.id,
            prerequisiteId: item.id,
            provenance: "test",
          },
        });
      } else {
        await prisma.dependencyRelationship.create({
          data: {
            dependentId: item.id,
            prerequisiteId: task.id,
            provenance: "test",
          },
        });
      }
    }

    const { client, transport } = await connectClient();
    try {
      const claimed = output<{
        task: {
          version: number;
          truncation: {
            truncatedFields: string[];
            omitted: Record<string, number>;
            reconciliationGuidance?: string;
          };
        };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: parent.sourceOrdinal,
            version: task.version,
            leaseMinutes: 30,
          },
        }),
      );
      const detail = claimed.task;

      expect(JSON.stringify(detail).length).toBeLessThan(30_000);
      expect(detail.truncation.truncatedFields).toEqual(
        expect.arrayContaining([
          "finding",
          "description",
          "resolution",
          "research",
          "plannedValidation",
          "files",
          "userSources",
          "validationRecords",
          "parent",
          "subtasks",
          "blockedBy",
          "blocks",
        ]),
      );
      expect(detail.truncation.omitted).toEqual({
        research: 6,
        plannedValidation: 6,
        tags: 10,
        files: 6,
        userSources: 5,
        validationRecords: 5,
        subtasks: 31,
        blockedBy: 13,
        blocks: 13,
      });
      expect(detail.truncation.reconciliationGuidance).toContain(
        "Do not move the task forward or edit files",
      );
      expect(detail.truncation.reconciliationGuidance).toContain(
        "actionables.get_task_detail",
      );
      expect(detail.truncation.reconciliationGuidance).toContain(
        "On VERSION_CONFLICT",
      );

      const reference = (item: (typeof related)[number]) => ({
        id: item.sourceOrdinal,
        title: item.title,
        status: item.status,
      });
      const expectedFields = {
        finding,
        description,
        research,
        plannedValidation,
        files,
        userSources,
        parent: reference(parent),
        subtasks: related.map(reference),
        blockedBy: related.slice(0, 18).map(reference),
      };
      const readField = async (field: keyof typeof expectedFields) => {
        type DetailPage = {
          id: number;
          version: number;
          field: string;
          offset: number;
          totalLength: number;
          contentHash: string;
          json: string;
          nextOffset: number | null;
        };
        const chunks: string[] = [];
        let offset = 0;
        let pages = 0;
        let totalLength: number | null = null;
        let contentHash: string | null = null;
        while (pages < 100) {
          const page: DetailPage = output<DetailPage>(
            await client.callTool({
              name: "actionables.get_task_detail",
              arguments: {
                id: task.sourceOrdinal,
                claimToken: claimed.claim.claimToken,
                version: claimed.task.version,
                field,
                offset,
                ...(contentHash ? { contentHash } : {}),
              },
            }),
          );
          expect(page).toMatchObject({
            id: task.sourceOrdinal,
            version: claimed.task.version,
            field,
            offset,
          });
          expect(page.json.length).toBeLessThanOrEqual(8_000);
          expect(JSON.stringify(page)).not.toContain(claimed.claim.claimToken);
          totalLength ??= page.totalLength;
          contentHash ??= page.contentHash;
          expect(page.totalLength).toBe(totalLength);
          expect(page.contentHash).toBe(contentHash);
          chunks.push(page.json);
          pages += 1;
          if (page.nextOffset === null) {
            const combined = chunks.join("");
            expect(combined.length).toBe(totalLength);
            return { value: JSON.parse(combined) as unknown, pages };
          }
          expect(page.nextOffset).toBe(offset + page.json.length);
          offset = page.nextOffset;
        }
        throw new Error(`Detail paging did not terminate for ${field}.`);
      };

      for (const [field, expected] of Object.entries(expectedFields)) {
        const result = await readField(field as keyof typeof expectedFields);
        expect(result.value).toEqual(expected);
        if (JSON.stringify(expected).length > 8_000) {
          expect(result.pages).toBeGreaterThan(1);
        }
      }

      const relationshipFirstPage = output<{
        contentHash: string;
        nextOffset: number;
      }>(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: claimed.claim.claimToken,
            version: claimed.task.version,
            field: "subtasks",
            offset: 0,
          },
        }),
      );
      expect(relationshipFirstPage.nextOffset).toBeGreaterThan(0);
      await prisma.actionable.update({
        where: { id: related[0]!.id },
        data: { title: "Changed related title" },
      });
      const changedRelationshipPage = errorOutput(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: claimed.claim.claimToken,
            version: claimed.task.version,
            field: "subtasks",
            offset: relationshipFirstPage.nextOffset,
            contentHash: relationshipFirstPage.contentHash,
          },
        }),
      );
      expect(changedRelationshipPage).toMatchObject({
        code: "VERSION_CONFLICT",
        currentVersion: claimed.task.version,
      });

      const firstPageArguments = {
        id: task.sourceOrdinal,
        claimToken: claimed.claim.claimToken,
        version: claimed.task.version,
        field: "finding",
        offset: 0,
      };
      const firstPage = output<{
        contentHash: string;
        nextOffset: number;
      }>(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: firstPageArguments,
        }),
      );
      const repeatedPage = output<Record<string, unknown>>(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: firstPageArguments,
        }),
      );
      expect(repeatedPage).toEqual(firstPage);

      const stale = errorOutput(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: {
            ...firstPageArguments,
            version: task.version,
          },
        }),
      );
      expect(stale).toMatchObject({
        code: "VERSION_CONFLICT",
        currentVersion: claimed.task.version,
      });
      const invalidOffset = errorOutput(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: {
            ...firstPageArguments,
            offset: 1_000_000,
            contentHash: firstPage.contentHash,
          },
        }),
      );
      expect(invalidOffset).toMatchObject({ code: "INVALID_REQUEST" });
      const missingContentHash = await client.callTool({
        name: "actionables.get_task_detail",
        arguments: {
          ...firstPageArguments,
          offset: firstPage.nextOffset,
        },
      });
      expect(validationErrorText(missingContentHash)).toContain("contentHash");

      const stored = await prisma.actionable.findUniqueOrThrow({
        where: { id: task.id },
      });
      expect(stored.version).toBe(claimed.task.version);
      expect(stored.researchJson).toEqual(research);
      expect(
        await prisma.userSourceReference.count({
          where: { actionableId: task.id, removedAt: null },
        }),
      ).toBe(userSources.length);
    } finally {
      await transport.close();
    }
  });

  it("names fields whose compact detail omits otherwise short values", async () => {
    const task = await createTask({ title: "Omission-only detail" });
    const related = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createTask({ title: `Short related ${index}` }),
      ),
    );
    await prisma.actionable.update({
      where: { id: task.id },
      data: {
        researchJson: json(
          Array.from({ length: 7 }, (_, index) => `Research ${index}`),
        ),
        validationJson: json(
          Array.from({ length: 7 }, (_, index) => `Validation ${index}`),
        ),
        filesJson: json(
          Array.from({ length: 7 }, (_, index) => ({
            path: `file-${index}.ts`,
          })),
        ),
      },
    });
    await prisma.userSourceReference.createMany({
      data: Array.from({ length: 6 }, (_, index) => ({
        actionableId: task.id,
        type: "URL",
        locator: `https://example.test/short/${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)),
      })),
    });
    await prisma.validationRecord.createMany({
      data: Array.from({ length: 6 }, () => ({
        actionableId: task.id,
        type: "Command",
        outcome: "Passed",
        notesMd: "Short note",
        evidenceMd: "Short evidence",
        origin: "test",
      })),
    });
    for (const [index, item] of related.entries()) {
      if (index < 6) {
        await prisma.hierarchyRelationship.create({
          data: {
            parentId: task.id,
            childId: item.id,
            provenance: "test",
          },
        });
        await prisma.dependencyRelationship.create({
          data: {
            dependentId: task.id,
            prerequisiteId: item.id,
            provenance: "test",
          },
        });
      } else {
        await prisma.dependencyRelationship.create({
          data: {
            dependentId: item.id,
            prerequisiteId: task.id,
            provenance: "test",
          },
        });
      }
    }

    const { client, transport } = await connectClient();
    try {
      const claimed = output<{
        task: {
          truncation: {
            truncatedFields: string[];
            reconciliationGuidance?: string;
          };
        };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: task.version,
          },
        }),
      );
      expect(claimed.task.truncation.truncatedFields).toEqual(
        expect.arrayContaining([
          "research",
          "plannedValidation",
          "files",
          "userSources",
          "validationRecords",
          "subtasks",
          "blockedBy",
          "blocks",
        ]),
      );
      expect(claimed.task.truncation.reconciliationGuidance).toContain(
        "actionables.get_task_detail",
      );
    } finally {
      await transport.close();
    }
  });

  it("keeps untruncated and noncritical detail loss on the normal path", async () => {
    const untruncatedTask = await createTask({ title: "Complete detail" });
    const noncriticalTask = await createTask({
      title: "Noncritical bounded detail",
    });
    const downstream = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        createTask({
          title: `Downstream ${index} ${"d".repeat(180)}`,
        }),
      ),
    );
    await prisma.actionable.update({
      where: { id: noncriticalTask.id },
      data: {
        resolution: "x".repeat(100_000),
        tagsJson: json(
          Array.from({ length: 12 }, (_, index) => `tag-${index}`),
        ),
      },
    });
    await prisma.userSourceReference.create({
      data: {
        actionableId: noncriticalTask.id,
        type: "URL",
        locator: "https://example.test/noncritical",
        label: "l".repeat(200),
      },
    });
    await prisma.validationRecord.createMany({
      data: Array.from({ length: 6 }, () => ({
        actionableId: noncriticalTask.id,
        type: "Command",
        outcome: "Passed",
        notesMd: "n".repeat(1_000),
        evidenceMd: "e".repeat(1_000),
        origin: "noncritical-history",
      })),
    });
    for (const item of downstream) {
      await prisma.dependencyRelationship.create({
        data: {
          dependentId: item.id,
          prerequisiteId: noncriticalTask.id,
          provenance: "test",
        },
      });
    }

    const { client, transport } = await connectClient();
    try {
      const untruncated = output<{
        task: {
          truncation: {
            truncatedFields: string[];
            omitted: Record<string, number>;
            reconciliationGuidance?: string;
          };
        };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: untruncatedTask.sourceOrdinal,
            workItemId: untruncatedTask.sourceOrdinal,
            version: untruncatedTask.version,
          },
        }),
      );
      expect(untruncated.task.truncation).toEqual({
        truncatedFields: [],
        omitted: {
          research: 0,
          plannedValidation: 0,
          tags: 0,
          files: 0,
          userSources: 0,
          validationRecords: 0,
          subtasks: 0,
          blockedBy: 0,
          blocks: 0,
        },
      });

      const noncritical = output<{
        task: {
          truncation: {
            truncatedFields: string[];
            omitted: Record<string, number>;
            reconciliationGuidance?: string;
          };
        };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: noncriticalTask.sourceOrdinal,
            workItemId: noncriticalTask.sourceOrdinal,
            version: noncriticalTask.version,
          },
        }),
      );
      expect(noncritical.task.truncation.truncatedFields).toEqual(
        expect.arrayContaining([
          "resolution",
          "userSources",
          "validationRecords",
          "blocks",
        ]),
      );
      expect(noncritical.task.truncation.omitted).toMatchObject({
        tags: 2,
        validationRecords: 1,
        blocks: 1,
      });
      expect(noncritical.task.truncation).not.toHaveProperty(
        "reconciliationGuidance",
      );
    } finally {
      await transport.close();
    }
  });

  it("supports scoped terminal list and exact reads without reopening work", async () => {
    const longFinding = `Terminal inspection ${"x".repeat(8_500)}`;
    const created = await createTask({
      status: "Ready",
      title: "Terminal inspection workflow",
    });
    const task = await prisma.actionable.update({
      where: { id: created.id },
      data: {
        finding: longFinding,
        researchJson: json(["Terminal inspection lifecycle was researched."]),
      },
    });
    const { client, transport } = await connectClient();
    try {
      const claimed = output<{
        task: { version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: task.version,
          },
        }),
      );
      const credentials = {
        id: task.sourceOrdinal,
        claimToken: claimed.claim.claimToken,
      };
      const inProgress = output<{ version: number }>(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: claimed.task.version,
            status: "In progress",
          },
        }),
      );
      const resolved = output<{ version: number }>(
        await client.callTool({
          name: "actionables.update_task",
          arguments: {
            ...credentials,
            version: inProgress.version,
            resolution:
              "Completed the work and retained a read-only historical record.",
          },
        }),
      );
      const validated = output<{ version: number }>(
        await client.callTool({
          name: "actionables.record_task_validation",
          arguments: {
            ...credentials,
            version: resolved.version,
            type: "Command",
            outcome: "Passed",
            notes: "Terminal inspection fixture passed.",
            evidence: "The fixture reached its intended final state.",
          },
        }),
      );
      const completed = output<{
        status: string;
        version: number;
      }>(
        await client.callTool({
          name: "actionables.transition_task",
          arguments: {
            ...credentials,
            version: validated.version,
            status: "Done",
          },
        }),
      );
      expect(completed).toMatchObject({
        status: "Done",
        changedFields: ["status"],
        reconciliationFields: [],
        claimReleased: true,
      });

      for (const view of ["mine", "available"] as const) {
        const listed = output<{
          items: unknown[];
          workItem: { id: number; status: string; terminal: boolean };
        }>(
          await client.callTool({
            name: "actionables.list_tasks",
            arguments: {
              view,
              workItemId: task.sourceOrdinal,
              limit: 100,
            },
          }),
        );
        expect(listed).toEqual({
          items: [],
          hasMore: false,
          workItem: {
            id: task.sourceOrdinal,
            status: "Done",
            terminal: true,
          },
        });
      }

      const beforeReads = await prisma.actionable.findUniqueOrThrow({
        where: { id: task.id },
        include: { agentTaskClaim: true, activityEvents: true },
      });
      const compact = output<{
        id: number;
        status: string;
        terminal: boolean;
        version: number;
      }>(
        await client.callTool({
          name: "actionables.get_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
          },
        }),
      );
      expect(compact).toMatchObject({
        id: task.sourceOrdinal,
        status: "Done",
        terminal: true,
        version: completed.version,
      });

      const firstPage = output<{
        json: string;
        contentHash: string;
        nextOffset: number | null;
      }>(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: compact.version,
            field: "finding",
          },
        }),
      );
      expect(firstPage.nextOffset).toBe(8_000);
      const secondPage = output<{ json: string; nextOffset: null }>(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: compact.version,
            field: "finding",
            offset: firstPage.nextOffset,
            contentHash: firstPage.contentHash,
          },
        }),
      );
      expect(JSON.parse(firstPage.json + secondPage.json)).toBe(longFinding);
      const afterReads = await prisma.actionable.findUniqueOrThrow({
        where: { id: task.id },
        include: { agentTaskClaim: true, activityEvents: true },
      });
      expect(afterReads.version).toBe(beforeReads.version);
      expect(afterReads.agentTaskClaim).toBeNull();
      expect(afterReads.activityEvents).toEqual(beforeReads.activityEvents);

      const terminalClaim = errorOutput(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: compact.version,
          },
        }),
      );
      expect(terminalClaim).toMatchObject({
        code: "TERMINAL",
        retryMode: "after_state_change",
        recovery: { action: "resolve_state" },
        retryable: true,
        nextAction: expect.stringContaining("read-only"),
      });
      const terminalChild = errorOutput(
        await client.callTool({
          name: "actionables.create_task",
          arguments: {
            idempotencyKey: randomUUID(),
            workItemId: task.sourceOrdinal,
            parentId: task.sourceOrdinal,
            title: "Must not be created under terminal work",
            priority: "Medium",
            description: "Terminal work stays closed.",
            effort: "S",
            plannedValidation: ["Verify rejection."],
            tags: ["terminal"],
          },
        }),
      );
      expect(terminalChild.code).toBe("TERMINAL");

      const dismissed = await createTask({ status: "Dismissed" });
      const dismissedList = output<{
        items: unknown[];
        workItem: { status: string; terminal: boolean };
      }>(
        await client.callTool({
          name: "actionables.list_tasks",
          arguments: {
            view: "available",
            workItemId: dismissed.sourceOrdinal,
          },
        }),
      );
      expect(dismissedList).toMatchObject({
        items: [],
        workItem: { status: "Dismissed", terminal: true },
      });
      expect(
        output<{ status: string; terminal: boolean }>(
          await client.callTool({
            name: "actionables.get_task",
            arguments: {
              id: dismissed.sourceOrdinal,
              workItemId: dismissed.sourceOrdinal,
            },
          }),
        ),
      ).toMatchObject({ status: "Dismissed", terminal: true });

      const active = await createTask({ status: "Ready" });
      expect(
        errorOutput(
          await client.callTool({
            name: "actionables.get_task",
            arguments: {
              id: active.sourceOrdinal,
              workItemId: active.sourceOrdinal,
            },
          }),
        ).code,
      ).toBe("INVALID_REQUEST");
      const archived = await createTask({ status: "Done" });
      await prisma.actionable.update({
        where: { id: archived.id },
        data: { archivedAt: new Date() },
      });
      const archivedRead = errorOutput(
        await client.callTool({
          name: "actionables.get_task",
          arguments: {
            id: archived.sourceOrdinal,
            workItemId: archived.sourceOrdinal,
          },
        }),
      );
      expect(archivedRead).toMatchObject({
        code: "ARCHIVED",
        nextAction: expect.stringContaining("Restore"),
      });
      const missingRead = errorOutput(
        await client.callTool({
          name: "actionables.get_task",
          arguments: {
            id: 999_999,
            workItemId: task.sourceOrdinal,
          },
        }),
      );
      expect(missingRead).toMatchObject({
        code: "NOT_FOUND",
        nextAction: expect.stringContaining("Verify"),
      });

      const conflictCreated = await createTask({ status: "Done" });
      const conflictTask = await prisma.actionable.update({
        where: { id: conflictCreated.id },
        data: { finding: longFinding },
      });
      const conflictFirstPage = output<{
        contentHash: string;
        nextOffset: number;
      }>(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: {
            id: conflictTask.sourceOrdinal,
            workItemId: conflictTask.sourceOrdinal,
            version: conflictTask.version,
            field: "finding",
          },
        }),
      );
      await prisma.actionable.update({
        where: { id: conflictTask.id },
        data: { status: "Ready", version: { increment: 1 } },
      });
      const conflict = errorOutput(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: {
            id: conflictTask.sourceOrdinal,
            workItemId: conflictTask.sourceOrdinal,
            version: conflictTask.version,
            field: "finding",
            offset: conflictFirstPage.nextOffset,
            contentHash: conflictFirstPage.contentHash,
          },
        }),
      );
      expect(conflict).toMatchObject({
        code: "TERMINAL_READ_INVALIDATED",
        retryMode: "never",
        recovery: { action: "stop" },
        retryable: false,
        nextAction: expect.stringMatching(/stop terminal inspection/i),
        currentVersion: conflictTask.version + 1,
      });
    } finally {
      await transport.close();
    }
  });

  it("returns self-correcting errors for invalid, stale, wrong, and expired claims", async () => {
    const task = await createTask({ title: "MCP error task" });
    const detailTask = await createTask({ title: "MCP detail error task" });
    const { client, transport } = await connectClient();
    try {
      const invalid = await client.callTool({
        name: "actionables.list_tasks",
        arguments: {
          view: "available",
          workItemId: task.sourceOrdinal,
          limit: 101,
        },
      });
      expect(invalid.isError).toBe(true);

      const claimed = output<{
        task: { version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: task.sourceOrdinal,
            workItemId: task.sourceOrdinal,
            version: task.version,
            leaseMinutes: 30,
          },
        }),
      );
      const detailClaimed = output<{
        task: { version: number };
        claim: { claimToken: string };
      }>(
        await client.callTool({
          name: "actionables.claim_task",
          arguments: {
            id: detailTask.sourceOrdinal,
            workItemId: detailTask.sourceOrdinal,
            version: detailTask.version,
            leaseMinutes: 30,
          },
        }),
      );
      const wrongToken = errorOutput(
        await client.callTool({
          name: "actionables.get_task",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: "x".repeat(43),
          },
        }),
      );
      expect(wrongToken.code).toBe("INVALID_CLAIM_TOKEN");
      expect(wrongToken).toMatchObject({
        retryable: true,
        nextAction: expect.stringContaining("Discard the token"),
      });
      const wrongDetailToken = errorOutput(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: "x".repeat(43),
            version: claimed.task.version,
            field: "finding",
          },
        }),
      );
      expect(wrongDetailToken).toMatchObject({
        code: "INVALID_CLAIM_TOKEN",
        retryable: true,
      });
      const crossTaskToken = errorOutput(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: detailClaimed.claim.claimToken,
            version: claimed.task.version,
            field: "finding",
          },
        }),
      );
      expect(crossTaskToken.code).toBe("INVALID_CLAIM_TOKEN");
      const missingDetailToken = await client.callTool({
        name: "actionables.get_task_detail",
        arguments: {
          id: task.sourceOrdinal,
          version: claimed.task.version,
          field: "finding",
        },
      });
      expect(missingDetailToken.isError).toBe(true);

      const otherThread = await connectClient(
        bearerToken,
        "019fa45f-581d-7bc0-afe3-a2b65171df69",
      );
      try {
        const compactFromOtherThread = output<{ version: number }>(
          await otherThread.client.callTool({
            name: "actionables.get_task",
            arguments: {
              id: task.sourceOrdinal,
              claimToken: claimed.claim.claimToken,
            },
          }),
        );
        const detailFromOtherThread = output<{ version: number }>(
          await otherThread.client.callTool({
            name: "actionables.get_task_detail",
            arguments: {
              id: task.sourceOrdinal,
              claimToken: claimed.claim.claimToken,
              version: claimed.task.version,
              field: "finding",
            },
          }),
        );
        expect(detailFromOtherThread.version).toBe(
          compactFromOtherThread.version,
        );
      } finally {
        await otherThread.transport.close();
      }

      const stale = errorOutput(
        await client.callTool({
          name: "actionables.update_task",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: claimed.claim.claimToken,
            version: task.version,
            title: "Must not save",
          },
        }),
      );
      expect(stale).toMatchObject({
        code: "VERSION_CONFLICT",
        currentVersion: claimed.task.version,
        retryable: true,
        nextAction: expect.stringContaining("current version"),
      });

      await prisma.agentTaskClaim.update({
        where: { actionableId: detailTask.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      const expiredDetail = errorOutput(
        await client.callTool({
          name: "actionables.get_task_detail",
          arguments: {
            id: detailTask.sourceOrdinal,
            claimToken: detailClaimed.claim.claimToken,
            version: detailClaimed.task.version,
            field: "finding",
          },
        }),
      );
      expect(expiredDetail).toMatchObject({
        code: "CLAIM_EXPIRED",
        retryable: true,
      });

      await prisma.agentTaskClaim.update({
        where: { actionableId: task.id },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      const expired = errorOutput(
        await client.callTool({
          name: "actionables.get_task",
          arguments: {
            id: task.sourceOrdinal,
            claimToken: claimed.claim.claimToken,
          },
        }),
      );
      expect(expired).toMatchObject({
        code: "CLAIM_EXPIRED",
        retryable: true,
        nextAction: expect.stringContaining("same work item"),
      });
    } finally {
      await transport.close();
    }
  });

  it("rejects unauthenticated and non-loopback requests and disables GET/DELETE", async () => {
    const endpoint = `${address}/mcp`;
    const initialization = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "security-test", version: "1.0.0" },
      },
    };
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(initialization),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { ...headers, authorization: "Bearer wrong" },
          body: JSON.stringify(initialization),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/mcp",
          headers: {
            ...headers,
            host: "attacker.example",
            authorization: `Bearer ${bearerToken}`,
          },
          payload: initialization,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            ...headers,
            authorization: `Bearer ${bearerToken}`,
            origin: "https://attacker.example",
          },
          body: JSON.stringify(initialization),
        })
      ).status,
    ).toBe(403);

    const correlated = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...headers,
        authorization: `Bearer ${bearerToken}`,
        origin: address,
        "x-correlation-id": "safe-mcp-correlation",
      },
      body: JSON.stringify(initialization),
    });
    expect(correlated.status).toBe(200);
    expect(correlated.headers.get("x-correlation-id")).toBe(
      "safe-mcp-correlation",
    );

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(endpoint, {
        method,
        headers: { authorization: `Bearer ${bearerToken}` },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }

    const disabled = buildApp({ prisma });
    expect(
      (await disabled.inject({ method: "POST", url: "/mcp" })).statusCode,
    ).toBe(404);
    await disabled.close();
  });
});
