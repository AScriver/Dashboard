import Database from "better-sqlite3";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  codexPromptTemplateSchema,
  defaultCodexImplementationPrompt,
  defaultCodexResearchPrompt,
  renderCodexStartPrompt,
} from "@actionables/contracts";

const templates = {
  codexResearchPrompt: defaultCodexResearchPrompt,
  codexImplementationPrompt: defaultCodexImplementationPrompt,
};
const task = {
  id: 47,
  parentId: 42,
  title: "Literal {{taskId}} & $&\n日本語",
  status: "Inbox",
  relationships: { subtasks: [] },
};

describe("Codex prompt templates", () => {
  it.each([
    ["Inbox", "begin the Researching phase"],
    ["Researching", "resume the Researching phase"],
    ["Ready", "continue from Ready"],
    ["In progress", "resume implementation from In progress"],
  ])("preserves the default %s start and governing IDs", (status, phase) => {
    const prompt = renderCodexStartPrompt({ ...task, status }, templates);
    expect(prompt).toContain(
      `Use Actionables work item #42. Claim task #47 and ${phase}.`,
    );
    expect(prompt).not.toContain(task.title);
    expect(prompt).toContain("inspect `isError`");
    expect(prompt).toContain("task.truncation.reconciliationGuidance");
  });

  it("replaces every listed variable once without interpreting inserted title text", () => {
    const custom =
      "{{workItemId}}|{{taskId}}|{{taskTitle}}|{{phaseAction}}|{{splitInstructions}}|{{implementationInstructions}}";
    const prompt = renderCodexStartPrompt(
      { ...task, status: "Ready" },
      { ...templates, codexImplementationPrompt: custom },
    );
    expect(prompt).toContain(`42|47|${task.title}|continue from Ready|`);
    expect(prompt).toContain("sibling direct tasks under work item #42");
    expect(prompt).toContain("do not create children under #47");
    expect(prompt).toContain(
      "Before requesting Ready or moving Ready to In progress",
    );
    expect(prompt).toContain(
      "Confirm the scope, then move the task to In progress before editing",
    );
  });

  it("preserves root splitting and coordination finalization", () => {
    const root = { ...task, parentId: undefined };
    expect(renderCodexStartPrompt(root, templates)).toContain(
      "use #47 as both `workItemId` and `parentId`",
    );
    const coordination = {
      ...root,
      status: "Ready",
      relationships: { subtasks: [{}] },
    };
    expect(renderCodexStartPrompt(coordination, templates)).toContain(
      "do not implement or duplicate any direct task's scope",
    );
    expect(renderCodexStartPrompt(coordination, templates)).toContain(
      "move the root to In progress before finalizing it",
    );
    const resumed = renderCodexStartPrompt(
      { ...coordination, status: "In progress" },
      templates,
    );
    expect(resumed).toContain("Otherwise finalize the root");
    expect(resumed).not.toContain("Before requesting Ready");
  });

  it.each(["Done", "Dismissed", "Blocked"])(
    "does not generate a start for %s",
    (status) => {
      expect(renderCodexStartPrompt({ ...task, status }, templates)).toBeNull();
    },
  );

  it.each([
    "{{workItemId}} {{taskId}} {{unknown}}",
    "{{workItemId}} {{taskId}} {{__proto__}}",
    "{{workItemId}} {{taskId}} {{constructor}}",
    "{{workItemId}} {{taskId}} {{taskTitle",
    "{{workItemId}} {{taskId}} taskTitle}}",
    "{{workItemId}} {{taskId}} {{{taskTitle}}}",
    "{{workItemId}} {{taskId}} {{taskId + 1}}",
    "{{workItemId}} {{taskId}} {{}}",
    "{{workItemId}}",
    "{{taskId}}",
    " ",
    "{{workItemId}} {{taskId}}" + "x".repeat(20_000),
  ])("rejects invalid or incomplete templates", (template) => {
    expect(codexPromptTemplateSchema.safeParse(template).success).toBe(false);
    expect(() =>
      renderCodexStartPrompt(task, {
        ...templates,
        codexResearchPrompt: template,
      }),
    ).toThrow();
  });

  it("keeps ordinary braces and code as literal template text", () => {
    const template =
      '{{workItemId}} {{taskId}} {"example": true} ${process.exit()}';
    expect(
      renderCodexStartPrompt(task, {
        ...templates,
        codexResearchPrompt: template,
      }),
    ).toBe('42 47 {"example": true} ${process.exit()}');
  });

  it("adds nullable fields without altering a populated older settings row", async () => {
    const directory = new URL("../../../prisma/migrations/", import.meta.url);
    const target = "20260911230000_codex_start_prompts";
    const database = new Database(":memory:");
    try {
      const migrations = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name < target)
        .map((entry) => entry.name)
        .sort();
      for (const migration of migrations) {
        database.exec(
          await readFile(
            new URL(`${migration}/migration.sql`, directory),
            "utf8",
          ),
        );
      }
      database
        .prepare(
          `INSERT INTO "HelperAgentSettings" ("id", "inboxTriagerPrompt", "noteGroomerPrompt", "relationshipAuditorPrompt", "version", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "helper-agents",
          "Keep triage",
          "Keep notes",
          "Keep relationships",
          9,
          "2026-09-11T00:00:00.000Z",
        );
      const before = database
        .prepare('SELECT * FROM "HelperAgentSettings"')
        .get();
      database.exec(
        await readFile(new URL(`${target}/migration.sql`, directory), "utf8"),
      );
      expect(
        database.prepare('SELECT * FROM "HelperAgentSettings"').get(),
      ).toEqual({
        ...(before as object),
        codexResearchPrompt: null,
        codexImplementationPrompt: null,
      });
    } finally {
      database.close();
    }
  });
});
