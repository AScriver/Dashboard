import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DataImportService, PortableImportError } from "../src/data-import.js";
import { createPrismaClient, type AppPrismaClient } from "../src/database.js";
import { readSampleSeed } from "../src/import-seed.js";
import { updateRepositoryProject } from "../src/repository.js";
import {
  exportPortableDocument,
  sampleSeedToPortable,
  semanticPortableSnapshot,
} from "../src/portable-format.js";
import type {
  ImportPreviewResponse,
  PortableDocument,
} from "@actionables/contracts";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const prismaCli = resolve(repoRoot, "node_modules/prisma/build/index.js");
const databases: Array<{ path: string; prisma: AppPrismaClient }> = [];

async function freshDatabase() {
  const databaseName = `import-test-${randomUUID()}.db`;
  const path = resolve(repoRoot, "data", databaseName);
  const url = `file:./data/${databaseName}`;
  const file = await open(path, "a");
  await file.close();
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  const prisma = createPrismaClient(url);
  databases.push({ path, prisma });
  return prisma;
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async ({ path, prisma }) => {
      await prisma.$disconnect();
      await Promise.all(
        ["", "-journal", "-shm", "-wal"].map((suffix) =>
          rm(`${path}${suffix}`, { force: true }),
        ),
      );
    }),
  );
});

function conflictSelections(preview: ImportPreviewResponse) {
  return Object.fromEntries(
    preview.items
      .filter((item) => item.classification === "conflict")
      .map((item) => [item.id, "skip" as const]),
  );
}

async function commitPreview(
  service: DataImportService,
  preview: ImportPreviewResponse,
  acceptedSuggestionIds: string[] = [],
) {
  const prepared = service.prepare(preview.previewToken, {
    contentDigest: preview.contentDigest,
    conflictResolutions: conflictSelections(preview),
    acceptedSuggestionIds,
  });
  return service.commit(preview.previewToken, {
    contentDigest: preview.contentDigest,
    commitToken: prepared.commitToken,
    selectionsDigest: prepared.selectionsDigest,
  });
}

async function seedDocument() {
  return sampleSeedToPortable(await readSampleSeed());
}

it("preserves repository reassignment when the same seed is imported again", async () => {
  const prisma = await freshDatabase();
  const service = new DataImportService(prisma);
  const document = await seedDocument();
  await commitPreview(service, await service.preview(document));
  const repository = await prisma.repository.findFirstOrThrow();
  const removed = await updateRepositoryProject(prisma, repository.id, {
    version: repository.version,
    projectId: null,
  });
  const unassigned = removed!.projects.find((project) => project.isUnassigned)!;
  const exported = await exportPortableDocument(prisma);
  const preview = await service.preview(document);
  expect(preview.canCommit).toBe(true);
  await commitPreview(service, preview);
  expect(
    await prisma.repository.findUniqueOrThrow({ where: { id: repository.id } }),
  ).toMatchObject({ projectId: unassigned.id });
  expect(
    await prisma.worktree.count({
      where: { repositoryId: repository.id, projectId: { not: unassigned.id } },
    }),
  ).toBe(0);
  expect(
    await prisma.actionable.count({
      where: { repositoryId: repository.id, projectId: { not: unassigned.id } },
    }),
  ).toBe(0);
  expect(
    semanticPortableSnapshot(await exportPortableDocument(prisma)),
  ).toEqual(semanticPortableSnapshot(exported));
});

function actionableClassification(
  preview: ImportPreviewResponse,
  portableId: string,
) {
  return preview.items.find(
    (item) =>
      item.recordType === "actionable" && item.portableId === portableId,
  );
}

describe("internal seed reconciliation", () => {
  it("routes the generic 32-item sample seed through one idempotent order-independent preview and commit pipeline", async () => {
    const prisma = await freshDatabase();
    const service = new DataImportService(prisma);
    const document = await seedDocument();

    expect(document.projects).toEqual([
      expect.objectContaining({
        portableId: "project-sample-web-app",
        name: "Sample Web App",
      }),
    ]);
    expect(
      document.actionables.every((actionable) =>
        actionable.portableId.startsWith("sample-review-"),
      ),
    ).toBe(true);
    expect(JSON.stringify(document)).not.toMatch(
      /[a-z]:[\\/]|codex:\/\/threads\/[0-9a-f]{8}-[0-9a-f-]{27,}/i,
    );
    expect(
      document.actionables
        .flatMap((actionable) => actionable.files)
        .every((file) => !/^[a-z]:[\\/]/i.test(file.path)),
    ).toBe(true);

    const first = await service.preview(document);
    expect(first.canCommit).toBe(true);
    expect(first.totalsByRecordType.actionable).toMatchObject({
      creates: 32,
      conflicts: 0,
      invalid: 0,
    });
    expect(first.totalsByRecordType.hierarchy.creates).toBe(4);
    expect(first.totals.suggestions).toBe(8);
    await commitPreview(service, first);

    expect(await prisma.actionable.count()).toBe(32);
    expect(
      await prisma.hierarchyRelationship.count({
        where: { detachedAt: null },
      }),
    ).toBe(4);
    expect(await prisma.dependencyRelationship.count()).toBe(0);
    expect(
      await prisma.actionable.count({
        where: { hierarchyAsChild: { none: { detachedAt: null } } },
      }),
    ).toBe(28);

    const second = await service.preview(document);
    expect(second.totalsByRecordType.actionable).toMatchObject({
      noOps: 32,
      creates: 0,
      safeUpdates: 0,
      conflicts: 0,
    });
    const legacyWithoutResolution = structuredClone(document);
    delete (
      legacyWithoutResolution.actionables[0] as {
        resolution?: string;
      }
    ).resolution;
    const legacyPreview = await service.preview(legacyWithoutResolution);
    expect(legacyPreview.totalsByRecordType.actionable.noOps).toBe(32);

    const reordered = structuredClone(document);
    reordered.actionables.reverse();
    reordered.projects.reverse();
    reordered.hierarchy.reverse();
    reordered.relationshipSuggestions.reverse();
    const reorderedPreview = await service.preview(reordered);
    expect(reorderedPreview.contentDigest).toBe(second.contentDigest);
    expect(reorderedPreview.totalsByRecordType.actionable.noOps).toBe(32);

    const firstItem = await prisma.actionable.findUniqueOrThrow({
      where: { externalKey: document.actionables[0]!.portableId },
    });
    expect(firstItem).toMatchObject({
      title: document.actionables[0]!.title,
      finding: document.actionables[0]!.finding,
      description: document.actionables[0]!.description,
      resolution: "",
      importProvider: "CODEX",
      sourceThread: document.actionables[0]!.importedEvidence.threadUrl,
    });
    expect(firstItem.rawFragmentJson).toEqual(
      document.actionables[0]!.importedEvidence.rawFragment,
    );

    const confirmable = await service.preview(document);
    const suggestion = confirmable.items.find(
      (item) => item.classification === "suggestion",
    )!;
    await commitPreview(service, confirmable, [suggestion.portableId]);
    expect(
      await prisma.dependencyRelationship.findUniqueOrThrow({
        where: { id: suggestion.portableId },
      }),
    ).toMatchObject({
      provenance: expect.stringContaining("confirmed suggestion"),
    });
    const afterConfirmation = await service.preview(document);
    expect(
      afterConfirmation.items.find(
        (item) => item.portableId === suggestion.portableId,
      ),
    ).toMatchObject({ classification: "no-op" });
  }, 30_000);

  it("applies safe source changes but preserves local edits with field-level conflicts", async () => {
    const prisma = await freshDatabase();
    const service = new DataImportService(prisma);
    const original = await seedDocument();
    await commitPreview(service, await service.preview(original));
    const portableId = original.actionables[0]!.portableId;

    const changedSource = structuredClone(original);
    changedSource.actionables[0]!.title = "Source revision one";
    const safe = await service.preview(changedSource);
    expect(actionableClassification(safe, portableId)).toMatchObject({
      classification: "safe-update",
      changes: [expect.objectContaining({ field: "title" })],
    });
    await commitPreview(service, safe);
    expect(
      (
        await prisma.actionable.findUniqueOrThrow({
          where: { externalKey: portableId },
        })
      ).title,
    ).toBe("Source revision one");

    await prisma.actionable.update({
      where: { externalKey: portableId },
      data: { title: "Local user wording", version: { increment: 1 } },
    });
    const divergedSource = structuredClone(changedSource);
    divergedSource.actionables[0]!.title = "Source revision two";
    const conflict = await service.preview(divergedSource);
    expect(actionableClassification(conflict, portableId)).toMatchObject({
      classification: "conflict",
      changes: [
        expect.objectContaining({
          field: "title",
          reason: expect.stringContaining("both the source and local"),
        }),
      ],
    });
    expect(() =>
      service.prepare(conflict.previewToken, {
        contentDigest: conflict.contentDigest,
        conflictResolutions: {},
        acceptedSuggestionIds: [],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFLICT_SELECTION_MISMATCH",
      }),
    );
    await commitPreview(service, conflict);
    expect(
      (
        await prisma.actionable.findUniqueOrThrow({
          where: { externalKey: portableId },
        })
      ).title,
    ).toBe("Local user wording");

    const sourceUnchanged = await service.preview(changedSource);
    expect(actionableClassification(sourceUnchanged, portableId)).toMatchObject(
      {
        classification: "no-op",
        changes: [
          expect.objectContaining({
            field: "title",
            reason: expect.stringContaining("local user edit is preserved"),
          }),
        ],
      },
    );
  }, 30_000);

  it("binds content and selections, rejects stale state, expiry, and replay", async () => {
    const prisma = await freshDatabase();
    const service = new DataImportService(prisma);
    const document = await seedDocument();
    const preview = await service.preview(document);

    expect(() =>
      service.prepare(preview.previewToken, {
        contentDigest: "0".repeat(64),
        conflictResolutions: {},
        acceptedSuggestionIds: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "DOCUMENT_CHANGED" }));
    expect(() =>
      service.prepare(preview.previewToken, {
        contentDigest: preview.contentDigest,
        conflictResolutions: {},
        acceptedSuggestionIds: ["not-a-previewed-suggestion"],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_SUGGESTION_SELECTION" }),
    );

    const prepared = service.prepare(preview.previewToken, {
      contentDigest: preview.contentDigest,
      conflictResolutions: {},
      acceptedSuggestionIds: [],
    });
    await prisma.project.create({
      data: { externalKey: "concurrent-project", name: "Concurrent edit" },
    });
    await expect(
      service.commit(preview.previewToken, {
        contentDigest: preview.contentDigest,
        commitToken: prepared.commitToken,
        selectionsDigest: prepared.selectionsDigest,
      }),
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(await prisma.actionable.count()).toBe(0);

    const current = await service.preview(document);
    const committed = await commitPreview(service, current);
    expect(committed.summary.creates).toBeGreaterThan(0);

    const successfulPreview = await service.preview(document);
    const successfulAuthorization = service.prepare(
      successfulPreview.previewToken,
      {
        contentDigest: successfulPreview.contentDigest,
        conflictResolutions: {},
        acceptedSuggestionIds: [],
      },
    );
    const request = {
      contentDigest: successfulPreview.contentDigest,
      commitToken: successfulAuthorization.commitToken,
      selectionsDigest: successfulAuthorization.selectionsDigest,
    };
    await service.commit(successfulPreview.previewToken, request);
    await expect(
      service.commit(successfulPreview.previewToken, request),
    ).rejects.toMatchObject({
      code: "COMMIT_REPLAYED",
    });

    const expiring = new DataImportService(prisma, 0);
    const expired = await expiring.preview(document);
    expect(() =>
      expiring.prepare(expired.previewToken, {
        contentDigest: expired.contentDigest,
        conflictResolutions: {},
        acceptedSuggestionIds: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "PREVIEW_EXPIRED" }));
  }, 30_000);

  it("reports unsupported, duplicate, missing, unsafe, nested, and graph-invalid input without mutation", async () => {
    const prisma = await freshDatabase();
    const service = new DataImportService(prisma);
    const document = await seedDocument();

    await expect(
      service.preview({ ...document, schemaVersion: 2 }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_SCHEMA_VERSION",
    });
    await expect(
      service.preview({ ...document, format: "unknown" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });

    const duplicate = structuredClone(document);
    duplicate.actionables.push(structuredClone(duplicate.actionables[0]!));
    expect((await service.preview(duplicate)).totals.invalid).toBeGreaterThan(
      0,
    );

    const invalidEnum = structuredClone(document) as PortableDocument;
    (invalidEnum.actionables[0] as { status: string }).status = "Future";
    expect((await service.preview(invalidEnum)).totals.invalid).toBeGreaterThan(
      0,
    );

    const invalidTimestamp = structuredClone(document);
    invalidTimestamp.exportedAt = "not-a-timestamp";
    expect(
      (await service.preview(invalidTimestamp)).totals.invalid,
    ).toBeGreaterThan(0);

    const missing = structuredClone(document);
    missing.actionables[0]!.projectId = "missing-project";
    expect(
      (await service.preview(missing)).totals.missingReferences,
    ).toBeGreaterThan(0);

    const unsafe = structuredClone(document);
    unsafe.userSources.push({
      portableId: "unsafe-source",
      actionableId: unsafe.actionables[0]!.portableId,
      type: "URL",
      locator: "javascript:alert(1)",
      label: null,
      provenance: "user-added",
      createdAt: "2026-07-25T00:00:00.000Z",
      removedAt: null,
    });
    const unsafePreview = await service.preview(unsafe);
    expect(unsafePreview.canCommit).toBe(true);
    expect(unsafePreview.items).toContainEqual(
      expect.objectContaining({
        recordType: "user-source",
        portableId: "unsafe-source",
        classification: "create",
      }),
    );

    const polluted = structuredClone(document) as PortableDocument & {
      injected?: unknown;
    };
    Object.defineProperty(polluted.actionables[0]!, "__proto__", {
      value: { polluted: true },
      enumerable: true,
    });
    expect((await service.preview(polluted)).totals.invalid).toBeGreaterThan(0);

    const nested = structuredClone(document);
    type NestedJson = { next?: NestedJson };
    let value: NestedJson = {};
    nested.actionables[0]!.importedEvidence.rawFragment = value;
    for (let index = 0; index < 45; index += 1) {
      value.next = {};
      value = value.next;
    }
    expect((await service.preview(nested)).totals.invalid).toBeGreaterThan(0);

    const selfDependency = structuredClone(document);
    selfDependency.dependencies.push({
      portableId: "self-dependency",
      dependentId: selfDependency.actionables[0]!.portableId,
      prerequisiteId: selfDependency.actionables[0]!.portableId,
      createdAt: "2026-07-25T00:00:00.000Z",
      waivedAt: null,
      waiverReason: null,
      removedAt: null,
      provenance: "test",
    });
    expect(
      (await service.preview(selfDependency)).totals.integrityFailures,
    ).toBeGreaterThan(0);

    const cycle = structuredClone(document);
    cycle.dependencies.push(
      {
        portableId: "cycle-a",
        dependentId: cycle.actionables[0]!.portableId,
        prerequisiteId: cycle.actionables[1]!.portableId,
        createdAt: "2026-07-25T00:00:00.000Z",
        waivedAt: null,
        waiverReason: null,
        removedAt: null,
        provenance: "test",
      },
      {
        portableId: "cycle-b",
        dependentId: cycle.actionables[1]!.portableId,
        prerequisiteId: cycle.actionables[0]!.portableId,
        createdAt: "2026-07-25T00:00:00.000Z",
        waivedAt: null,
        waiverReason: null,
        removedAt: null,
        provenance: "test",
      },
    );
    expect(
      (await service.preview(cycle)).totals.integrityFailures,
    ).toBeGreaterThan(0);

    const duplicateRelationship = structuredClone(document);
    duplicateRelationship.dependencies.push(
      {
        portableId: "duplicate-dependency-a",
        dependentId: duplicateRelationship.actionables[0]!.portableId,
        prerequisiteId: duplicateRelationship.actionables[1]!.portableId,
        createdAt: "2026-07-25T00:00:00.000Z",
        waivedAt: null,
        waiverReason: null,
        removedAt: null,
        provenance: "test",
      },
      {
        portableId: "duplicate-dependency-b",
        dependentId: duplicateRelationship.actionables[0]!.portableId,
        prerequisiteId: duplicateRelationship.actionables[1]!.portableId,
        createdAt: "2026-07-25T00:00:00.000Z",
        waivedAt: null,
        waiverReason: null,
        removedAt: null,
        provenance: "test",
      },
    );
    expect(
      (await service.preview(duplicateRelationship)).totals.integrityFailures,
    ).toBeGreaterThan(0);

    const excessiveDepth = structuredClone(document);
    excessiveDepth.hierarchy.push({
      portableId: "excessive-depth",
      parentId: excessiveDepth.actionables.find(
        (item) => item.portableId === excessiveDepth.hierarchy[0]!.childId,
      )!.portableId,
      childId: excessiveDepth.actionables[1]!.portableId,
      createdAt: "2026-07-25T00:00:00.000Z",
      detachedAt: null,
      provenance: "test",
    });
    expect(
      (await service.preview(excessiveDepth)).totals.integrityFailures,
    ).toBeGreaterThan(0);
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.importRun.count()).toBe(0);
  }, 30_000);

  it("rolls back every write when the transaction fails and consumes the authorization", async () => {
    const prisma = await freshDatabase();
    const service = new DataImportService(prisma);
    const preview = await service.preview(await seedDocument());
    const prepared = service.prepare(preview.previewToken, {
      contentDigest: preview.contentDigest,
      conflictResolutions: {},
      acceptedSuggestionIds: [],
    });
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "test_abort_actionable"
      BEFORE INSERT ON "Actionable"
      BEGIN
        SELECT RAISE(ABORT, 'forced import failure');
      END;
    `);
    const request = {
      contentDigest: preview.contentDigest,
      commitToken: prepared.commitToken,
      selectionsDigest: prepared.selectionsDigest,
    };
    await expect(
      service.commit(preview.previewToken, request),
    ).rejects.toThrow();
    expect(await prisma.project.count()).toBe(0);
    expect(await prisma.repository.count()).toBe(0);
    expect(await prisma.worktree.count()).toBe(0);
    expect(await prisma.actionable.count()).toBe(0);
    expect(await prisma.importRun.count()).toBe(0);
    await expect(
      service.commit(preview.previewToken, request),
    ).rejects.toMatchObject({
      code: "COMMIT_REPLAYED",
    });
  }, 30_000);

  it("restores a full representative database to a canonical semantic equivalent", async () => {
    const source = await freshDatabase();
    const seedService = new DataImportService(source);
    await commitPreview(
      seedService,
      await seedService.preview(await seedDocument()),
    );
    const seedAction = await source.actionable.findFirstOrThrow({
      orderBy: { sourceOrdinal: "asc" },
    });
    const project = await source.project.create({
      data: {
        externalKey: "project-user",
        name: "User project",
        archivedAt: new Date("2026-07-25T01:00:00.000Z"),
      },
    });
    const repository = await source.repository.create({
      data: {
        externalKey: "repository-user",
        projectId: project.id,
        name: "User repository",
        localPath: "C:\\sensitive\\user-repository",
      },
    });
    const worktree = await source.worktree.create({
      data: {
        externalKey: "worktree-user",
        projectId: project.id,
        repositoryId: repository.id,
        name: "Feature worktree",
        localPath: "C:\\sensitive\\user-repository\\feature",
      },
    });
    const manual = await source.actionable.create({
      data: {
        id: "db-local-manual-id",
        externalKey: "manual-portable-actionable",
        sourceOrdinal: 33,
        title: "Representative user-authored work",
        priority: "High",
        status: "Done",
        statusProvenance: "Created by the user.",
        effort: "M",
        evidenceState: "Confirmed",
        archivedAt: new Date("2026-07-25T02:00:00.000Z"),
        updatedLabel: "just now",
        completionOverrideMd: "Accepted after documented review.",
        finding: "User-authored **Markdown** remains exact.",
        description: "Restore every supported field.",
        resolution:
          "Completed the portable round trip and preserved field ownership.",
        researchJson: ["Research note"],
        validationJson: ["Run the integration suite"],
        filesJson: [{ path: "src/user.ts", lines: "1-5", symbol: "userWork" }],
        tagsJson: ["user", "roundtrip"],
        userSourcesJson: [],
        blockedByOrdinalsJson: [],
        blocksOrdinalsJson: [],
        childOrdinalsJson: [],
        importProvider: "MANUAL",
        sourceContainerId: "",
        sourceThread: "",
        contentHash: "",
        rawFragmentJson: { kind: "manual" },
        fieldOwnershipJson: { title: "user-authored" },
        projectId: project.id,
        repositoryId: repository.id,
        worktreeId: worktree.id,
        createdAt: new Date("2026-07-25T00:30:00.000Z"),
        updatedAt: new Date("2026-07-25T02:00:00.000Z"),
      },
    });
    await source.actionableStatusHistory.createMany({
      data: [
        {
          id: "history-01",
          actionableId: manual.id,
          previousStatus: null,
          newStatus: "Inbox",
          origin: "manual-create",
          occurredAt: new Date("2026-07-25T00:30:00.000Z"),
        },
        {
          id: "history-02",
          actionableId: manual.id,
          previousStatus: "In progress",
          newStatus: "Done",
          origin: "user",
          occurredAt: new Date("2026-07-25T02:00:00.000Z"),
        },
      ],
    });
    await source.validationRecord.create({
      data: {
        id: "validation-01",
        actionableId: manual.id,
        type: "Command",
        outcome: "Failed",
        notesMd: "Initial run",
        evidenceMd: "failure",
        origin: "user",
        recordedAt: new Date("2026-07-25T01:20:00.000Z"),
      },
    });
    await source.validationRecord.create({
      data: {
        id: "validation-02",
        actionableId: manual.id,
        type: "Command",
        outcome: "Passed",
        notesMd: "Correction",
        evidenceMd: "pass",
        origin: "user",
        supersedesId: "validation-01",
        recordedAt: new Date("2026-07-25T01:40:00.000Z"),
      },
    });
    await source.userSourceReference.create({
      data: {
        id: "source-01",
        actionableId: manual.id,
        type: "URL",
        locator: "https://example.com/evidence",
        label: "Evidence",
        provenance: "agent-added",
        createdAt: new Date("2026-07-25T01:10:00.000Z"),
      },
    });
    await source.dependencyRelationship.create({
      data: {
        id: "dependency-cross-scope",
        dependentId: manual.id,
        prerequisiteId: seedAction.id,
        waivedAt: new Date("2026-07-25T01:50:00.000Z"),
        waiverReason: "Reviewed and accepted.",
        provenance: "user",
        createdAt: new Date("2026-07-25T01:30:00.000Z"),
      },
    });
    await source.activityEvent.create({
      data: {
        id: "activity-01",
        actionableId: manual.id,
        type: "dependency-waived",
        summary: "Waived cross-scope dependency",
        metadataJson: {
          dependencyRelationshipId: "dependency-cross-scope",
          prerequisiteActionableId: seedAction.externalKey,
          reason: "Reviewed and accepted.",
        },
        occurredAt: new Date("2026-07-25T01:50:00.000Z"),
      },
    });
    await source.actionable.update({
      where: { id: seedAction.id },
      data: {
        tagsJson: ["security", "backend", "locally-edited"],
        version: { increment: 1 },
      },
    });

    const exported = await exportPortableDocument(source, {
      exportedAt: new Date("2026-07-25T03:00:00.000Z"),
    });
    const restored = await freshDatabase();
    const restoreService = new DataImportService(restored);
    const restorePreview = await restoreService.preview(exported);
    expect(restorePreview.canCommit).toBe(true);
    await commitPreview(restoreService, restorePreview);
    const reexported = await exportPortableDocument(restored, {
      exportedAt: new Date("2026-07-25T04:00:00.000Z"),
    });

    expect(semanticPortableSnapshot(reexported)).toBe(
      semanticPortableSnapshot(exported),
    );
    expect(await restored.validationRecord.count()).toBe(
      exported.validationRecords.length,
    );
    expect(
      await restored.userSourceReference.findUniqueOrThrow({
        where: { id: "source-01" },
        select: { provenance: true },
      }),
    ).toEqual({ provenance: "agent-added" });
    expect(
      await restored.dependencyRelationship.findUniqueOrThrow({
        where: { id: "dependency-cross-scope" },
      }),
    ).toMatchObject({
      waiverReason: "Reviewed and accepted.",
      provenance: "user",
    });
  }, 30_000);
});
