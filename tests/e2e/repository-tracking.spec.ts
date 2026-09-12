import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("registers a monorepo project and opens its checked directory with recoverable errors", async ({
  page,
}) => {
  const checkout = await mkdtemp(
    resolve(tmpdir(), "actionables-browser-monorepo-"),
  );
  const name = `Monorepo alpha ${Date.now()}`;
  await mkdir(resolve(checkout, "apps/alpha"), { recursive: true });
  await mkdir(resolve(checkout, "apps/beta"), { recursive: true });
  await writeFile(resolve(checkout, "AGENTS.md"), "Root guidance");
  await writeFile(resolve(checkout, "apps/alpha/AGENTS.md"), "Alpha guidance");
  await writeFile(resolve(checkout, "apps/beta/AGENTS.md"), "Beta guidance");
  try {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Add repository", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Add repository" });
    await dialog.getByLabel("Repository name").fill(name);
    await dialog.getByLabel("Local path").fill(checkout);
    await dialog
      .getByLabel("Project directory", { exact: true })
      .fill("apps/alpha");
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/repositories") &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Add repository", exact: true })
      .click();
    const registration = await (await response).json();
    await expect(dialog).toHaveCount(0);
    const created = await page.request.post("/api/actionables", {
      data: {
        projectId: registration.projectId,
        repositoryId: registration.repositoryId,
        worktreeId: registration.worktreeId,
        title: "Monorepo browser launch",
        priority: "Medium",
        effort: "S",
        evidenceState: "Unclassified",
        finding: "",
        description: "",
        research: [],
        validation: [],
        tags: [],
        userSources: [],
      },
    });
    expect(created.ok()).toBe(true);
    const task = (await created.json()).item;
    await page.goto(`/actionables/${task.id}`);
    const link = page.getByRole("link", { name: "Open in Codex", exact: true });
    await expect(link).toBeVisible();
    expect(
      new URL((await link.getAttribute("href"))!).searchParams.get("path"),
    ).toBe(await realpath(resolve(checkout, "apps/alpha")));
    await page.goto("/settings");
    const directory = page.getByLabel(`Project directory for ${name}`, {
      exact: true,
    });
    await expect(directory).toHaveValue("apps/alpha");
    await directory.fill("../outside");
    const assignment = page.getByRole("form", {
      name: `Project assignment for ${name}`,
    });
    await assignment.getByRole("button", { name: "Save assignment" }).click();
    await expect(page.getByRole("alert")).toContainText("relative directory");
    await directory.fill("apps/beta");
    await assignment.getByRole("button", { name: "Save assignment" }).click();
    await expect(
      page
        .getByRole("region", { name: "Repository projects" })
        .getByRole("status"),
    ).toContainText("assignment saved");
    await page.reload();
    await expect(directory).toHaveValue("apps/beta");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await rename(
      resolve(checkout, "apps/beta"),
      resolve(checkout, "apps/moved"),
    );
    await page.goto(`/actionables/${task.id}`);
    await expect(page.getByRole("alert")).toContainText(
      "missing or inaccessible",
    );
    await expect(link).toHaveCount(0);
    await rename(
      resolve(checkout, "apps/moved"),
      resolve(checkout, "apps/beta"),
    );
    await page.getByRole("button", { name: "Retry project directory" }).click();
    await expect(link).toBeVisible();
    expect(
      new URL((await link.getAttribute("href"))!).searchParams.get("path"),
    ).toBe(await realpath(resolve(checkout, "apps/beta")));
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
});

test("adds an additional repository and makes it immediately selectable", async ({
  page,
}) => {
  const suffix = Date.now();
  const repositoryName = `Tracked browser repo ${suffix}`;
  const localPath = `C:\\repos\\TrackedBrowserRepo-${suffix}`;

  await page.goto("/");
  await page.getByRole("button", { name: "Add repository" }).click();

  const dialog = page.getByRole("dialog", { name: "Add repository" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("group", { name: "Project assignment" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: "Existing project" }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("radio", { name: "New project" }),
  ).not.toBeChecked();
  await dialog.getByLabel("Repository name").fill(repositoryName);
  await dialog.getByLabel("Local path").fill(localPath);
  await dialog
    .getByRole("button", { name: "Add repository", exact: true })
    .click();

  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: repositoryName, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".repository-group")
      .filter({
        has: page.getByRole("button", { name: repositoryName, exact: true }),
      })
      .getByRole("button", { name: /^Default/ }),
  ).toBeVisible();
  await expect(page).toHaveURL(/repository=/);
  await expect(page).toHaveURL(/worktree=/);

  await page.getByRole("button", { name: "New actionable" }).click();
  const actionableDialog = page.getByRole("dialog", {
    name: "New actionable",
  });
  await expect(
    actionableDialog.getByLabel("Repository").locator("option:checked"),
  ).toHaveText(repositoryName);
  await expect(
    actionableDialog.getByLabel("Worktree").locator("option:checked"),
  ).toHaveText("Default");
  await expect(
    actionableDialog.getByLabel("Repository").getByRole("option", {
      name: repositoryName,
    }),
  ).toHaveCount(1);
  await actionableDialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Add repository" }).click();
  const duplicateDialog = page.getByRole("dialog", { name: "Add repository" });
  await duplicateDialog.getByLabel("Repository name").fill(repositoryName);
  await duplicateDialog.getByLabel("Local path").fill(localPath);
  await duplicateDialog
    .getByRole("button", { name: "Add repository", exact: true })
    .click();

  await expect(duplicateDialog.getByRole("alert")).toContainText(
    "already tracked",
  );
  await expect(
    duplicateDialog.getByText(/repository with this name/i),
  ).toBeVisible();
  await expect(
    duplicateDialog.getByText(/path is already tracked/i),
  ).toBeVisible();
});

test("browses for a repository folder and handles cancellation and failure", async ({
  page,
}) => {
  let pickerRequest = 0;
  await page.route("**/api/repositories/folder-picker", async (route) => {
    pickerRequest += 1;
    if (pickerRequest === 1) {
      await route.fulfill({ json: { path: "C:\\repos\\Selected project" } });
      return;
    }
    if (pickerRequest === 2) {
      await route.fulfill({ json: { path: null } });
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        type: "https://actionables.local/problems/folder_picker_failed",
        title: "The folder picker could not be opened.",
        status: 503,
        code: "FOLDER_PICKER_FAILED",
        requestId: "folder-picker-fixture",
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Add repository" }).click();
  const dialog = page.getByRole("dialog", { name: "Add repository" });
  const localPath = dialog.getByLabel("Local path");
  const browse = dialog.getByRole("button", {
    name: "Browse for a local repository folder",
  });

  await localPath.fill("C:\\repos\\Manual fallback");
  await localPath.press("Tab");
  await expect(browse).toBeFocused();
  await expect(browse).toHaveCSS("outline-style", "solid");
  await expect(browse).toHaveCSS("outline-width", "2px");
  await browse.press("Enter");
  await expect(localPath).toHaveValue("C:\\repos\\Selected project");

  await localPath.fill("C:\\repos\\Keep this value");
  await browse.press("Enter");
  await expect(localPath).toHaveValue("C:\\repos\\Keep this value");
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  await browse.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText(
    "The folder picker could not be opened.",
  );
  await expect(localPath).toHaveValue("C:\\repos\\Keep this value");
});

test("creates a project with its repository and rolls back failed attempts", async ({
  page,
}) => {
  const suffix = Date.now();
  const projectName = `Browser project ${suffix}`;
  const repositoryName = `Browser project repo ${suffix}`;
  const localPath = `C:\\repos\\BrowserProjectRepo-${suffix}`;
  const cancelledProjectName = `Cancelled project ${suffix}`;
  const scopesBefore = await (await page.request.get("/api/scopes")).json();

  await page.goto("/");
  await page.getByRole("button", { name: "Add repository" }).click();

  let dialog = page.getByRole("dialog", { name: "Add repository" });
  const existingProject = dialog.getByRole("radio", {
    name: "Existing project",
  });
  await existingProject.focus();
  await existingProject.press("ArrowRight");
  await expect(
    dialog.getByRole("radio", { name: "New project" }),
  ).toBeChecked();
  await expect(dialog.getByLabel("Project", { exact: true })).toHaveCount(0);
  await dialog.getByLabel("Project name").fill(cancelledProjectName);
  await dialog.getByLabel("Repository name").fill("Cancelled repository");
  await dialog.getByLabel("Local path").fill(`C:\\repos\\Cancelled-${suffix}`);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const scopesAfterCancel = await (
    await page.request.get("/api/scopes")
  ).json();
  expect(scopesAfterCancel.projects).toHaveLength(scopesBefore.projects.length);
  expect(
    scopesAfterCancel.projects.some(
      (project: { name: string }) => project.name === cancelledProjectName,
    ),
  ).toBe(false);

  await page.getByRole("button", { name: "Add repository" }).click();
  dialog = page.getByRole("dialog", { name: "Add repository" });
  await dialog.getByRole("radio", { name: "New project" }).check();
  await dialog.getByLabel("Project name").fill(projectName);
  await dialog.getByLabel("Repository name").fill(repositoryName);
  await dialog.getByLabel("Local path").fill(localPath);
  await dialog
    .getByRole("button", { name: "Add repository", exact: true })
    .click();

  await expect(dialog).toHaveCount(0);
  const projectTree = page.locator(".project-tree");
  await expect(
    projectTree.getByRole("button", { name: projectName, exact: true }),
  ).toHaveCount(0);
  await expect(
    projectTree.getByRole("button", { name: repositoryName, exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/project=/);
  await expect(page).toHaveURL(/repository=/);
  await expect(page).toHaveURL(/worktree=/);

  const scopesAfterCreate = await (
    await page.request.get("/api/scopes")
  ).json();
  const createdProject = scopesAfterCreate.projects.find(
    (project: { name: string }) => project.name === projectName,
  );
  expect(createdProject?.repositories).toEqual([
    expect.objectContaining({
      name: repositoryName,
      worktrees: [expect.objectContaining({ name: "Default" })],
    }),
  ]);

  const rolledBackProjectName = `Rolled back project ${suffix}`;
  await page.getByRole("button", { name: "Add repository" }).click();
  dialog = page.getByRole("dialog", { name: "Add repository" });
  await dialog.getByRole("radio", { name: "New project" }).check();
  await dialog.getByLabel("Project name").fill(rolledBackProjectName);
  await dialog.getByLabel("Repository name").fill("Duplicate path repository");
  await dialog.getByLabel("Local path").fill(localPath);
  await dialog
    .getByRole("button", { name: "Add repository", exact: true })
    .click();

  await expect(dialog.getByRole("alert")).toContainText("already tracked");
  await expect(dialog.getByText(/path is already tracked/i)).toBeVisible();
  const scopesAfterFailure = await (
    await page.request.get("/api/scopes")
  ).json();
  expect(scopesAfterFailure.projects).toHaveLength(
    scopesAfterCreate.projects.length,
  );
  expect(
    scopesAfterFailure.projects.some(
      (project: { name: string }) => project.name === rolledBackProjectName,
    ),
  ).toBe(false);

  await expect(
    dialog.getByRole("button", { name: "Add repository", exact: true }),
  ).toBeEnabled();
  await dialog.getByLabel("Project name").focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("keeps Add repository available when there are no active projects", async ({
  page,
}) => {
  const scopes = await (await page.request.get("/api/scopes")).json();
  const activeProjects = scopes.projects.filter(
    (project: { archivedAt: string | null }) => !project.archivedAt,
  );

  try {
    for (const project of activeProjects) {
      const archived = await page.request.post(
        `/api/scopes/project/${project.id}/archive`,
        { data: { version: project.version } },
      );
      expect(archived.ok()).toBeTruthy();
    }

    await page.goto("/");
    const addRepository = page.getByRole("button", {
      name: "Add repository",
    });
    await expect(addRepository).toBeEnabled();
    await addRepository.click();

    const dialog = page.getByRole("dialog", { name: "Add repository" });
    await expect(
      dialog.getByRole("radio", { name: "New project" }),
    ).toBeChecked();
    await expect(
      dialog.getByRole("radio", { name: "Existing project" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("radio", { name: "New project" }),
    ).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    const choices = await dialog
      .locator(".repository-project-choice label")
      .evaluateAll((labels) =>
        labels.map((label) => {
          const rect = label.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        }),
      );
    expect(choices[1]!.top).toBeGreaterThan(choices[0]!.bottom);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  } finally {
    const currentScopes = await (await page.request.get("/api/scopes")).json();
    for (const project of currentScopes.projects.filter(
      (candidate: { id: string }) =>
        activeProjects.some(
          (original: { id: string }) => original.id === candidate.id,
        ),
    )) {
      if (!project.archivedAt) continue;
      const restored = await page.request.post(
        `/api/scopes/project/${project.id}/restore`,
        { data: { version: project.version } },
      );
      expect(restored.ok()).toBeTruthy();
    }
  }
});

test("hides archived projects from the sidebar after refresh", async ({
  page,
}) => {
  const scopesResponse = await page.request.get("/api/scopes");
  expect(scopesResponse.ok()).toBeTruthy();
  const scopes = await scopesResponse.json();
  const project = scopes.projects.find(
    (candidate: { archivedAt: string | null }) => !candidate.archivedAt,
  );
  expect(project).toBeTruthy();
  if (!project) return;

  const sidebar = page.locator("aside.sidebar");

  try {
    await page.goto("/");
    for (const repository of project.repositories) {
      await expect(
        sidebar.getByRole("button", { name: repository.name, exact: true }),
      ).toBeVisible();
    }

    const archived = await page.request.post(
      `/api/scopes/project/${project.id}/archive`,
      { data: { version: project.version } },
    );
    expect(archived.ok()).toBeTruthy();
    await page.reload();

    await expect(
      sidebar.getByRole("button", { name: project.name, exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("button", {
        name: `Restore project ${project.name}`,
      }),
    ).toHaveCount(0);

    await page.reload();

    for (const repository of project.repositories) {
      await expect(
        sidebar.getByRole("button", { name: repository.name, exact: true }),
      ).toHaveCount(0);
    }

    await expect(
      sidebar.getByRole("button", { name: project.name, exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar.getByRole("button", {
        name: `Restore project ${project.name}`,
      }),
    ).toHaveCount(0);
  } finally {
    const currentScopes = await (await page.request.get("/api/scopes")).json();
    const currentProject = currentScopes.projects.find(
      (candidate: { id: string }) => candidate.id === project.id,
    );
    if (currentProject?.archivedAt) {
      const restored = await page.request.post(
        `/api/scopes/project/${project.id}/restore`,
        { data: { version: currentProject.version } },
      );
      expect(restored.ok()).toBeTruthy();
    }
  }
});

test("removes and restores project assignment in Settings while retaining usable repository work", async ({
  page,
}) => {
  const suffix = Date.now();
  const name = `Reassign browser repo ${suffix}`;
  const scopes = await (await page.request.get("/api/scopes")).json();
  const project = scopes.projects.find(
    (item: { archivedAt: string | null; isUnassigned: boolean }) =>
      !item.archivedAt && !item.isUnassigned,
  );
  const created = await (
    await page.request.post("/api/repositories", {
      data: {
        projectMode: "existing",
        projectId: project.id,
        name,
        localPath: `C:\\repos\\Reassign-${suffix}`,
      },
    })
  ).json();
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Repository projects" });
  const form = section.getByRole("form", {
    name: `Project assignment for ${name}`,
  });
  const select = form.getByRole("combobox", { name, exact: true });
  await expect(select).toHaveValue(project.id);
  await select.selectOption("");
  await select.press("Tab");
  await expect(
    form.getByLabel(`Project directory for ${name}`, { exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    form.getByRole("button", { name: "Save assignment" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(section.getByRole("status")).toHaveText(
    "Repository project assignment saved.",
  );
  await page.reload();
  await expect(select).toHaveValue("");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await select.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Expand left sidebar" }).click();
  await page
    .locator("aside.sidebar")
    .getByRole("button", { name, exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`repository=${created.repositoryId}`),
  );
  await page.getByRole("button", { name: "New actionable" }).click();
  const dialog = page.getByRole("dialog", { name: "New actionable" });
  await expect(
    dialog
      .getByRole("combobox", { name: "Project", exact: true })
      .locator("option:checked"),
  ).toHaveText("No project");
  await expect(
    dialog
      .getByRole("combobox", { name: "Repository", exact: true })
      .locator("option:checked"),
  ).toHaveText(name);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.goto("/settings");
  await select.selectOption(project.id);
  let fail = true;
  await page.route(
    `**/api/repositories/${created.repositoryId}/project`,
    async (route) => {
      if (!fail) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 409,
        json: {
          type: "https://actionables.local/problems/version_conflict",
          title: "This scope record has a newer saved version.",
          status: 409,
          code: "VERSION_CONFLICT",
          requestId: "assignment-conflict",
        },
      });
    },
  );
  await form.getByRole("button", { name: "Save assignment" }).click();
  await expect(section.getByRole("alert")).toContainText("newer saved version");
  await expect(select).toHaveValue("");
  fail = false;
  await select.selectOption(project.id);
  await form.getByRole("button", { name: "Save assignment" }).click();
  await expect(section.getByRole("status")).toHaveText(
    "Repository project assignment saved.",
  );
  await page.reload();
  await expect(select).toHaveValue(project.id);
  const after = await (await page.request.get("/api/scopes")).json();
  const restored = after.projects
    .find((item: { id: string }) => item.id === project.id)
    .repositories.find(
      (item: { id: string }) => item.id === created.repositoryId,
    );
  expect(restored.worktrees[0].id).toBe(created.worktreeId);
});
