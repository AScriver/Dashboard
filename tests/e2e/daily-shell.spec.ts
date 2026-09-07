import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("dashboard queues open the equivalent URL-backed actionable list", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByLabel("Actionable totals")).toContainText("total");
  await page.setViewportSize({ width: 1586, height: 990 });
  await page.screenshot({
    path: "output/playwright/t005-dashboard-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({
    path: "output/playwright/t005-dashboard-laptop.png",
    fullPage: true,
  });
  const queue = page.getByRole("button", { name: /Inbox requiring triage/ });
  await expect(queue).toBeVisible();
  await queue.click();
  await expect(page).toHaveURL(/status=Inbox/);
  await expect(
    page.getByRole("heading", { name: /Actionables/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /status: Inbox/ }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/playwright/t005-actionables-laptop.png",
    fullPage: true,
  });

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "output/playwright/t005-dashboard-mobile.png",
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});

test("desktop sidebar collapses to an accessible navigation rail without losing scope", async ({
  page,
}) => {
  const scopes = await (await page.request.get("/api/scopes")).json();
  const project = scopes.projects.find(
    (candidate: {
      archivedAt: string | null;
      repositories: Array<{
        archivedAt: string | null;
        worktrees: Array<{ archivedAt: string | null }>;
      }>;
    }) =>
      !candidate.archivedAt &&
      candidate.repositories.some(
        (repository) =>
          !repository.archivedAt &&
          repository.worktrees.some((worktree) => !worktree.archivedAt),
      ),
  );
  const repository = project?.repositories.find(
    (candidate: {
      archivedAt: string | null;
      worktrees: Array<{ archivedAt: string | null }>;
    }) =>
      !candidate.archivedAt &&
      candidate.worktrees.some((worktree) => !worktree.archivedAt),
  );
  const worktree = repository?.worktrees.find(
    (candidate: { archivedAt: string | null }) => !candidate.archivedAt,
  );
  expect(project).toBeTruthy();
  expect(repository).toBeTruthy();
  expect(worktree).toBeTruthy();
  if (!project || !repository || !worktree) return;

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    `/?project=${project.id}&repository=${repository.id}&worktree=${worktree.id}`,
  );
  await expect(
    page.getByRole("heading", { name: /^Actionables \d+$/ }),
  ).toBeVisible();

  const shell = page.locator(".app-shell");
  const sidebar = page.getByRole("complementary", {
    name: "Repositories and worktrees",
  });
  const primaryNavigation = sidebar.getByRole("navigation", {
    name: "Primary",
  });
  const projectTree = sidebar.locator(".project-tree");
  const selectedWorktree = projectTree.locator(".worktree-row.is-selected");
  const navigationNames = ["Dashboard", "Actionables", "Done", "Archive"];
  const settings = sidebar
    .locator(".sidebar-status")
    .getByRole("button", { name: "Settings", exact: true });
  await expect(
    primaryNavigation.getByRole("button", { name: "Settings", exact: true }),
  ).toHaveCount(0);

  await expect(selectedWorktree).toHaveClass(/is-selected/);
  await expect(selectedWorktree).toContainText(worktree.name);
  const collapse = sidebar.getByRole("button", {
    name: "Collapse left sidebar",
  });
  await expect(collapse).toBeVisible();
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await collapse.press("Enter");

  await expect(shell).toHaveClass(/sidebar-collapsed/);
  const expand = sidebar.getByRole("button", {
    name: "Expand left sidebar",
  });
  await expect(expand).toBeVisible();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(projectTree).toBeHidden();
  await expect(settings).toBeVisible();
  await expect(settings.locator(".primary-navigation-label")).toHaveClass(
    /sr-only/,
  );
  await expect(selectedWorktree).toHaveClass(/is-selected/);

  const collapsedGeometry = await shell.evaluate((element) => {
    const sidebar = element.querySelector<HTMLElement>(".sidebar")!;
    return {
      columns: getComputedStyle(element).gridTemplateColumns,
      sidebarWidth: sidebar.getBoundingClientRect().width,
    };
  });
  expect(collapsedGeometry.sidebarWidth).toBe(52);
  expect(collapsedGeometry.columns.startsWith("52px ")).toBe(true);

  for (const name of navigationNames) {
    const button = primaryNavigation.getByRole("button", {
      name,
      exact: true,
    });
    await expect(button).toBeVisible();
    await expect(button.locator(".primary-navigation-label")).toHaveClass(
      /sr-only/,
    );
  }

  const assertScopePreserved = () => {
    const current = new URL(page.url());
    expect(current.searchParams.get("project")).toBe(project.id);
    expect(current.searchParams.get("repository")).toBe(repository.id);
    expect(current.searchParams.get("worktree")).toBe(worktree.id);
  };
  assertScopePreserved();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await primaryNavigation
    .getByRole("button", { name: "Dashboard", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard\?/);
  assertScopePreserved();

  await expand.press("Space");
  await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  await expect(projectTree).toBeVisible();
  await expect(selectedWorktree).toBeVisible();
  await expect(selectedWorktree).toHaveClass(/is-selected/);
  for (const name of navigationNames) {
    await expect(
      primaryNavigation
        .getByRole("button", { name, exact: true })
        .locator(".primary-navigation-label"),
    ).not.toHaveClass(/sr-only/);
  }
  await expect(settings.locator(".primary-navigation-label")).not.toHaveClass(
    /sr-only/,
  );

  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/");
  const mobileOpen = page
    .getByRole("banner")
    .getByRole("button", { name: "Open project navigation" });
  await expect(mobileOpen).toBeVisible();
  const responsiveGeometry = await shell.evaluate((element) => ({
    columns: getComputedStyle(element).gridTemplateColumns,
  }));
  expect(responsiveGeometry.columns.startsWith("0px ")).toBe(true);
  await expect(sidebar).toHaveCSS("opacity", "0");

  await mobileOpen.click();
  await expect(primaryNavigation).toBeVisible();
  await expect(projectTree).toBeVisible();
});

test("bulk Inbox triage surfaces partial outcomes without reporting success", async ({
  page,
}) => {
  let requestPayload: unknown;
  await page.route("**/api/assistant/inbox-triage", async (route) => {
    requestPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "partial",
        requestedLimit: 5,
        selectedCount: 2,
        triagedCount: 1,
        skippedCount: 0,
        failedCount: 1,
        results: [
          {
            id: 1,
            title: "Triaged task",
            outcome: "triaged",
            message: "Moved to Researching with gpt-5.6-terra.",
          },
          {
            id: 2,
            title: "Failed task",
            outcome: "failed",
            message: "Local Codex failed while triaging this task.",
          },
        ],
      }),
    });
  });

  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Triage up to 5" }).click();
  const result = page.getByRole("alert");
  await expect(result).toContainText("Partial triage: 1 of 2 tasks completed.");
  await expect(result).toContainText("#1 · Triaged task");
  await expect(result).toContainText("#2 · Failed task");
  expect(requestPayload).toEqual({});
  await expect(page.getByText(/Inbox triage was partial:/)).toBeVisible();
});

test("Done navigation separates completed work and preserves other filters", async ({
  page,
}) => {
  const scopes = await (await page.request.get("/api/scopes")).json();
  const project = scopes.projects[0];
  const repository = project.repositories[0];
  const worktree = repository.worktrees[0];
  let response = await page.request.post("/api/actionables", {
    data: {
      title: `T-005 Done navigation ${Date.now()}`,
      priority: "Low",
      effort: "S",
      evidenceState: "Confirmed",
      projectId: project.id,
      repositoryId: repository.id,
      worktreeId: worktree.id,
      finding: "Done work needs a direct, separate view.",
      description: "Verify the completed-work navigation.",
      resolution: "Created the completed-work fixture for navigation checks.",
      research: ["The existing exact Done query is sufficient."],
      validation: ["Exercise the Done and Actionables navigation."],
      tags: ["done-navigation-e2e"],
      userSources: [],
    },
  });
  expect(response.ok()).toBe(true);
  let completed = (await response.json()).item;
  for (const status of ["Researching", "Ready", "In progress"]) {
    response = await page.request.post(
      `/api/actionables/${completed.id}/status-transitions`,
      {
        data: { version: completed.version, status },
      },
    );
    expect(response.ok()).toBe(true);
    completed = (await response.json()).item;
  }
  response = await page.request.post(
    `/api/actionables/${completed.id}/validation-records`,
    {
      data: {
        version: completed.version,
        type: "Automated test",
        outcome: "Passed",
        notes: "Done navigation fixture is ready.",
        evidence: "Created through the public lifecycle API.",
      },
    },
  );
  expect(response.ok()).toBe(true);
  completed = (await response.json()).item;
  response = await page.request.post(
    `/api/actionables/${completed.id}/status-transitions`,
    {
      data: { version: completed.version, status: "Done" },
    },
  );
  expect(response.ok()).toBe(true);

  const doneResponse = await page.request.get(
    "/api/actionables?status=Done&sort=updated-desc",
  );
  expect(doneResponse.ok()).toBe(true);
  const done = await doneResponse.json();
  expect(done.items.length).toBeGreaterThan(0);

  await page.goto("/?sort=updated-desc");
  const actionablesButton = page.getByRole("button", {
    name: "Actionables",
    exact: true,
  });
  const doneButton = page.getByRole("button", {
    name: "Done",
    exact: true,
  });
  await expect(actionablesButton).toHaveClass(/is-selected/);
  await expect(
    page.locator(".finding-row").getByText("Done", { exact: true }),
  ).toHaveCount(0);

  await doneButton.click();
  await expect(page).toHaveURL(/status=Done/);
  await expect(page).toHaveURL(/sort=updated-desc/);
  await expect(page.getByRole("heading", { name: /^Done \d+$/ })).toBeVisible();
  await expect(doneButton).toHaveClass(/is-selected/);
  await expect(actionablesButton).not.toHaveClass(/is-selected/);
  await expect(page.locator(".finding-row")).toHaveCount(done.items.length);
  for (const item of done.items as Array<{ id: number }>) {
    const row = page.locator(`[data-actionable-id="${item.id}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByText("Done", { exact: true })).toBeVisible();
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: /^Done \d+$/ })).toBeVisible();
  await page.getByRole("button", { name: "Open project navigation" }).click();
  await expect(doneButton).toBeVisible();
  await expect(doneButton).toHaveClass(/is-selected/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await actionablesButton.click();
  await expect(page).not.toHaveURL(/status=/);
  await expect(page).toHaveURL(/sort=updated-desc/);
  await expect(
    page.getByRole("heading", { name: /^Actionables \d+$/ }),
  ).toBeVisible();
  await expect(actionablesButton).toHaveClass(/is-selected/);
  await expect(
    page.locator(".finding-row").getByText("Done", { exact: true }),
  ).toHaveCount(0);
});

test("filters, search, sort, selection, refresh, and history are URL-backed", async ({
  page,
}) => {
  await page.goto("/?priority=urgent&sort=random&q=downloads.ts");
  await expect(page).toHaveURL(/\/\?q=downloads\.ts$/);
  await expect(page.getByLabel("Search actionables")).toHaveValue(
    "downloads.ts",
  );
  await expect(
    page.getByRole("row", {
      name: /Require authentication for private file downloads/,
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Filters/ }).click();
  const status = page.getByLabel("Status");
  await expect(status).toHaveValue("active");
  await status.selectOption("all");
  await expect(page).toHaveURL(/status=all/);
  await status.selectOption("active");
  await expect(page).not.toHaveURL(/status=/);
  await page.getByLabel("Priority").selectOption("Critical");
  await expect(page).toHaveURL(/priority=Critical/);

  const priorityFilter = page.locator(".filter-field").filter({
    has: page.getByText("Priority", { exact: true }),
  });
  const priorityMode = priorityFilter.getByRole("button", {
    name: "Include",
  });
  await priorityMode.click();
  await expect(page).toHaveURL(/exclude=priority/);
  await expect(
    page.getByRole("button", { name: /Exclude priority: Critical/ }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await expect(
    page.getByRole("row", {
      name: /Require authentication for private file downloads/,
    }),
  ).toHaveCount(0);

  await page.goBack();
  await expect(page).not.toHaveURL(/exclude=/);
  await expect(
    page.getByRole("row", {
      name: /Require authentication for private file downloads/,
    }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/exclude=priority/);
  await page.reload();
  await expect(page).toHaveURL(/exclude=priority/);
  await page.getByRole("button", { name: /Filters/ }).click();
  await page
    .locator(".filter-field")
    .filter({ has: page.getByText("Priority", { exact: true }) })
    .getByRole("button", { name: "Exclude" })
    .click();
  await expect(page).not.toHaveURL(/exclude=/);

  const row = page.getByRole("row", {
    name: /Require authentication for private file downloads/,
  });
  await row.press("Enter");
  await expect(page).toHaveURL(/\/actionables\/1\?/);
  const deepLink = page.url();
  await page.reload();
  await expect(page).toHaveURL(deepLink);
  await expect(
    page.getByRole("heading", {
      name: "Require authentication for private file downloads",
    }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/priority=Critical/);
  await expect(page.getByLabel("Search actionables")).toHaveValue(
    "downloads.ts",
  );
  await page.goForward();
  await expect(page).toHaveURL(deepLink);
});

test("actionable archive and restore preserve status and support archived deep links", async ({
  page,
}) => {
  const scopes = await (await page.request.get("/api/scopes")).json();
  const project = scopes.projects[0];
  const repository = project.repositories[0];
  const worktree = repository.worktrees[0];
  const title = `T-005 archive browser ${Date.now()}`;
  const createdResponse = await page.request.post("/api/actionables", {
    data: {
      title,
      priority: "Low",
      effort: "S",
      evidenceState: "Confirmed",
      projectId: project.id,
      repositoryId: repository.id,
      worktreeId: worktree.id,
      finding: "Archive visibility must not change workflow state.",
      description: "Verify archive and restore through the daily shell.",
      research: [],
      validation: ["Confirm the status and deep link after restore"],
      tags: ["archive-e2e"],
      userSources: [],
    },
  });
  expect(createdResponse.status()).toBe(201);
  const created = (await createdResponse.json()).item;

  await page.goto(`/actionables/${created.id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const archiveButton = page.getByRole("button", {
    name: "Archive actionable",
  });
  await archiveButton.focus();
  await archiveButton.press("Enter");
  const archiveDialog = page.getByRole("dialog", { name: `Archive ${title}?` });
  await expect(archiveDialog).toContainText(
    "Workflow status and relationships are preserved",
  );
  await archiveDialog.press("Escape");
  await expect(archiveButton).toBeFocused();
  await archiveButton.press("Enter");
  await archiveDialog.getByRole("button", { name: `Archive ${title}` }).focus();
  await page.keyboard.press("Enter");
  const banner = page.getByText("Archived actionable").locator("..");
  await expect(banner).toContainText("Restore preserves workflow");
  await expect(page.getByLabel(/^Inbox\./)).toBeVisible();

  await page.goto("/archive");
  await expect(page.getByRole("heading", { name: /Archive/ })).toBeVisible();
  await page.getByRole("row", { name: new RegExp(title) }).press("Enter");
  await expect(page).toHaveURL(new RegExp(`/actionables/${created.id}`));
  await expect(page.getByText("Archived actionable")).toBeVisible();
  await page
    .locator(".archived-banner")
    .getByRole("button", { name: "Restore" })
    .click();
  const restoreDialog = page.getByRole("dialog", { name: `Restore ${title}?` });
  await restoreDialog.getByRole("button", { name: `Restore ${title}` }).click();
  await expect(page.getByText("Archived actionable")).toHaveCount(0);
  await expect(page.getByLabel(/^Inbox\./)).toBeVisible();
});

test("loading and API failure states preserve a retry path", async ({
  page,
}) => {
  await page.route("**/api/actionables*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        type: "https://actionables.local/problems/test",
        title: "Fixture API failure",
        status: 500,
        code: "FIXTURE_FAILURE",
        requestId: "e2e-request-id",
      }),
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("cell").filter({ hasText: "Could not load actionables" }),
  ).toBeVisible();
  await expect(page.getByText(/e2e-request-id/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
