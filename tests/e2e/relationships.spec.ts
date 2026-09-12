import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("relationships remain compact, navigable, responsive, and derived-blocking is explicit", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const scopes = await (await page.request.get("/api/scopes")).json();
  const project = scopes.projects[0];
  const repository = project.repositories[0];
  const worktree = repository.worktrees[0];
  const create = async (title: string) => {
    const response = await page.request.post("/api/actionables", {
      data: {
        title,
        priority: "Unset",
        effort: "Unknown",
        evidenceState: "Unclassified",
        projectId: project.id,
        repositoryId: repository.id,
        worktreeId: worktree.id,
        finding: "Relationship browser verification",
        description: "Exercise the compact relationship workflow.",
        research: [],
        validation: ["Verify the relationship state"],
        tags: [],
        userSources: [],
      },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).item;
  };
  const dependent = await create("T-003 browser dependent");
  const prerequisite = await create("T-003 browser prerequisite");

  await page.goto(`/actionables/${dependent.id}`);
  const inspector = page.getByRole("complementary", {
    name: "Selected actionable",
  });
  await expect(
    inspector.getByRole("heading", { name: /Blocked by/ }),
  ).toHaveCount(0);
  await inspector.getByRole("tab", { name: "Relationships" }).click();
  await page
    .getByLabel("Prerequisite actionable")
    .selectOption(String(prerequisite.id));
  await page
    .getByLabel("Prerequisite actionable")
    .locator("..")
    .getByRole("button", { name: "Add" })
    .click();
  await expect(
    page.getByRole("heading", { name: /Blocked by 1/ }),
  ).toBeVisible();
  await expect(page.getByText("unresolved", { exact: true })).toBeVisible();
  await expect(
    page.getByTitle("Derived block: 1 unresolved prerequisite").first(),
  ).toBeVisible();

  await page.getByLabel("New subtask name").fill("T-003 browser subtask");
  await page
    .getByLabel("New subtask name")
    .locator("..")
    .getByRole("button", { name: "Create" })
    .click();
  await expect(page.getByRole("heading", { name: /Subtasks 1/ })).toBeVisible();
  const progress = page.getByRole("region", { name: "Work-item progress" });
  await expect(progress).toBeVisible();
  await expect(
    progress
      .locator("div")
      .filter({ has: page.getByText("Open", { exact: true }) }),
  ).toHaveText("Open1");
  await expect(
    progress
      .locator("div")
      .filter({ has: page.getByText("Unclaimed", { exact: true }) }),
  ).toHaveText("Unclaimed1");
  await expect(
    page.getByRole("button", { name: /T-003 browser subtask/ }),
  ).toBeVisible();
  await page.getByLabel("Task breakdown template").selectOption("feature");
  await page.getByRole("button", { name: "Apply template" }).click();
  await expect(page.getByRole("heading", { name: /Subtasks 5/ })).toBeVisible();
  await expect(
    progress
      .locator("div")
      .filter({ has: page.getByText("Completed", { exact: true }) }),
  ).toHaveText("Completed0 / 5");
  await expect(
    progress
      .locator("div")
      .filter({ has: page.getByText("Open", { exact: true }) }),
  ).toHaveText("Open5");
  await expect(
    progress
      .locator("div")
      .filter({ has: page.getByText("Validation ready", { exact: true }) }),
  ).toHaveText("Validation ready0");
  await expect(
    page.getByRole("button", { name: /Define acceptance criteria/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Validate the end-to-end flow/ }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("T003-relationships-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await inspector.getByRole("tab", { name: "Relationships" }).click();
  await expect(progress).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await expect(
    page.getByRole("heading", { name: /Blocked by 1/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /T-003 browser prerequisite/ }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("T003-relationships-mobile.png"),
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});
