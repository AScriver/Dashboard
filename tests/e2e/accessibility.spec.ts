import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

test.setTimeout(120_000);

async function expectNoAxeViolations(page: Page, state: string) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations,
    `${state}: ${results.violations
      .map(
        (violation) =>
          `${violation.id} (${violation.impact ?? "unknown"}): ${violation.nodes
            .map((node) => node.target.join(" "))
            .join(", ")}`,
      )
      .join("; ")}`,
  ).toEqual([]);
}

test("@a11y representative dashboard, list, detail, form, lifecycle, validation, relationship, filter, and archive states pass axe", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expectNoAxeViolations(page, "dashboard");

  await page.goto("/");
  await expect(
    page.getByRole("table", { name: "Actionable findings" }),
  ).toBeVisible();
  await expectNoAxeViolations(page, "actionable list and inspector");

  await page.getByRole("button", { name: /Filters/ }).click();
  await expectNoAxeViolations(page, "filters");
  await page.getByRole("button", { name: /Filters/ }).click();

  await page.getByRole("button", { name: "New actionable" }).click();
  await expect(
    page.getByRole("dialog", { name: "New actionable" }),
  ).toBeVisible();
  await expectNoAxeViolations(page, "create form");
  await page.getByRole("button", { name: "Close actionable form" }).click();

  await page.getByRole("button", { name: "Add repository" }).click();
  const repositoryDialog = page.getByRole("dialog", {
    name: "Add repository",
  });
  await expectNoAxeViolations(page, "add repository with existing project");
  await repositoryDialog.getByRole("radio", { name: "New project" }).check();
  await expectNoAxeViolations(page, "add repository with new project");
  await repositoryDialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("row").nth(1).press("Enter");
  await page.getByRole("button", { name: "Edit actionable" }).click();
  await expectNoAxeViolations(page, "edit form");
  await page.getByRole("button", { name: "Close actionable form" }).click();

  const inspector = page.getByRole("complementary", {
    name: "Selected actionable",
  });
  await inspector
    .getByRole("button", { name: "Researching", exact: true })
    .click();
  await expectNoAxeViolations(page, "lifecycle confirmation");
  await inspector.getByRole("button", { name: "Cancel" }).click();

  await inspector.getByRole("tab", { name: "Validation" }).click();
  await inspector.getByRole("button", { name: "Record result" }).click();
  await expectNoAxeViolations(page, "validation form");
  await inspector.getByRole("button", { name: "Cancel" }).click();

  await inspector.getByRole("tab", { name: "Relationships" }).click();
  await expectNoAxeViolations(page, "subtasks and dependencies");

  await inspector.getByRole("tab", { name: "Activity" }).click();
  await expectNoAxeViolations(page, "activity timeline");

  const archiveButton = inspector.getByRole("button", {
    name: "Archive actionable",
  });
  await archiveButton.click();
  const archiveDialog = page.getByRole("dialog");
  await expect(archiveDialog).toBeVisible();
  await expectNoAxeViolations(page, "archive confirmation");
  const confirmArchive = archiveDialog.getByRole("button", {
    name: /^Archive /,
  });
  const cancelArchive = archiveDialog.getByRole("button", { name: "Cancel" });
  await expect(confirmArchive).toBeEnabled();
  await confirmArchive.focus();
  await page.keyboard.press("Tab");
  await expect(cancelArchive).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirmArchive).toBeFocused();
  await archiveDialog.press("Escape");
  await expect(archiveButton).toBeFocused();
});

test("@a11y import preview, success, empty, error, mobile navigation, and reflow states pass axe", async ({
  page,
  request,
}, testInfo) => {
  const exportResponse = await request.get("/api/data/export");
  expect(exportResponse.ok()).toBe(true);
  const portable = await exportResponse.json();
  portable.metadata.sourceName = "Accessibility preview";
  const importPath = testInfo.outputPath("accessibility-import.json");
  await writeFile(importPath, `${JSON.stringify(portable, null, 2)}\n`, "utf8");

  await page.goto("/data");
  await expectNoAxeViolations(page, "data initial");
  await page.locator('input[type="file"]').setInputFiles(importPath);
  await expect(page.getByRole("heading", { name: "2. Preview" })).toBeVisible();
  await expectNoAxeViolations(
    page,
    "import preview and conflict/error presentation",
  );
  await page.getByRole("button", { name: "Review selections" }).click();
  await page.getByRole("button", { name: "Commit reviewed import" }).click();
  await expect(page.getByText("Import committed")).toBeVisible();
  await expectNoAxeViolations(page, "import success");

  await page.goto("/?q=axe-no-results-4d8bc761");
  await expect(page.getByText(/No results match these filters/)).toBeVisible();
  await expectNoAxeViolations(page, "empty and no-results");

  await page.route("**/api/actionables*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        type: "https://actionables.local/problems/test",
        title: "Fixture API failure",
        status: 500,
        code: "FIXTURE_FAILURE",
        requestId: "axe-request-id",
      }),
    });
  });
  await page.goto("/?q=axe-error-fixture");
  await expect(
    page.getByRole("cell").filter({ hasText: "Fixture API failure" }),
  ).toBeVisible();
  await expectNoAxeViolations(page, "API error and retry");

  await page.unroute("**/api/actionables*");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expectNoAxeViolations(page, "mobile navigation and list");
  await page.getByRole("row").nth(1).press("Enter");
  await expectNoAxeViolations(page, "mobile detail");

  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto("/");
  await expectNoAxeViolations(page, "200 percent equivalent reflow");
});

test("@a11y loading, offline, background refresh, archive error, invalid import, and archived states pass axe", async ({
  page,
  request,
}, testInfo) => {
  let releaseListRequest = () => {};
  const listRequestGate = new Promise<void>((resolve) => {
    releaseListRequest = resolve;
  });
  await page.route("**/api/actionables", async (route) => {
    await listRequestGate;
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByText("Loading actionables")).toBeVisible();
  await expectNoAxeViolations(page, "initial loading");
  releaseListRequest();
  await expect(page.getByRole("row").nth(1)).toBeVisible();
  await page.unroute("**/api/actionables");

  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByText("Local API unreachable")).toBeVisible();
  await expectNoAxeViolations(page, "offline with preserved results");
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  await page.getByRole("row").nth(1).press("Enter");
  const archiveButton = page.getByRole("button", {
    name: "Archive actionable",
  });
  let releaseImpactRequest = () => {};
  const impactRequestGate = new Promise<void>((resolve) => {
    releaseImpactRequest = resolve;
  });
  await page.route("**/api/archive-impact/actionable/*", async (route) => {
    await impactRequestGate;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        type: "https://actionables.local/problems/test",
        title: "Fixture archive impact failure",
        status: 500,
        code: "FIXTURE_FAILURE",
        requestId: "axe-archive-request-id",
      }),
    });
  });
  await archiveButton.click();
  const archiveDialog = page.getByRole("dialog");
  await expect(archiveDialog.getByText("Checking impact…")).toBeVisible();
  await expectNoAxeViolations(page, "archive impact loading");
  releaseImpactRequest();
  await expect(
    archiveDialog.getByText(/Fixture archive impact failure/),
  ).toBeVisible();
  await expectNoAxeViolations(page, "archive impact error");
  await archiveDialog.press("Escape");
  await page.unroute("**/api/archive-impact/actionable/*");

  const invalidImportPath = testInfo.outputPath("invalid-import.json");
  await writeFile(invalidImportPath, "{not valid JSON}\n", "utf8");
  await page.goto("/data");
  await page.locator('input[type="file"]').setInputFiles(invalidImportPath);
  await expect(page.getByRole("alert")).toContainText("valid JSON");
  await expectNoAxeViolations(page, "invalid import error");

  const scopesResponse = await request.get("/api/scopes");
  expect(scopesResponse.ok()).toBe(true);
  const scopes = await scopesResponse.json();
  const project = scopes.projects[0];
  const repository = project.repositories[0];
  const worktree = repository.worktrees[0];
  const title = `Accessibility archived state ${Date.now()}`;
  const createResponse = await request.post("/api/actionables", {
    data: {
      title,
      priority: "Low",
      effort: "S",
      evidenceState: "Confirmed",
      projectId: project.id,
      repositoryId: repository.id,
      worktreeId: worktree.id,
      finding: "The archived presentation needs representative axe coverage.",
      description: "Disposable release-verification fixture.",
      research: [],
      validation: ["Inspect the archived state"],
      tags: ["a11y"],
      userSources: [],
    },
  });
  expect(createResponse.status()).toBe(201);
  const created = (await createResponse.json()).item;
  const archiveResponse = await request.post(
    `/api/actionables/${created.id}/archive`,
    { data: { version: created.version } },
  );
  expect(archiveResponse.ok()).toBe(true);
  const archived = (await archiveResponse.json()).item;

  await page.goto(`/actionables/${archived.id}`);
  await expect(page.getByText("Archived actionable")).toBeVisible();
  await expectNoAxeViolations(page, "archived actionable detail");

  await page
    .locator(".archived-banner")
    .getByRole("button", { name: "Restore" })
    .click();
  const restoreDialog = page.getByRole("dialog", {
    name: `Restore ${title}?`,
  });
  await expect(
    restoreDialog.getByRole("button", { name: `Restore ${title}` }),
  ).toBeEnabled();

  let releaseRefreshRequest = () => {};
  const refreshRequestGate = new Promise<void>((resolve) => {
    releaseRefreshRequest = resolve;
  });
  await page.route("**/api/actionables", async (route) => {
    await refreshRequestGate;
    await route.continue();
  });
  await restoreDialog.getByRole("button", { name: `Restore ${title}` }).click();
  await expect(page.getByText("Refreshing results…")).toBeVisible();
  await expectNoAxeViolations(page, "background refresh after restore");
  releaseRefreshRequest();
  await expect(page.getByText("Refreshing results…")).toBeHidden();
  await page.unroute("**/api/actionables");
});
