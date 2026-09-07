import type {
  ActionableDetail,
  CreateRepositoryResponse,
  ScopeOptionsResponse,
} from "@actionables/contracts";
import { expect, test, type APIRequestContext } from "@playwright/test";

async function createScopedFixture(request: APIRequestContext, name: string) {
  const repositoryResponse = await request.post("/api/repositories", {
    data: {
      projectMode: "new",
      projectName: `${name} project`,
      name: `${name} repository`,
      localPath: `C:\\repos\\${name}`,
    },
  });
  expect(repositoryResponse.ok()).toBeTruthy();
  const scope: CreateRepositoryResponse = await repositoryResponse.json();
  const actionableResponse = await request.post("/api/actionables", {
    data: {
      title: name,
      projectId: scope.projectId,
      repositoryId: scope.repositoryId,
      worktreeId: scope.worktreeId,
      priority: "Medium",
      effort: "S",
      evidenceState: "Confirmed",
      finding: "Exercise sidebar navigation with isolated fixture data.",
      description: "Verify scope filters and archival behavior.",
      research: [],
      validation: [],
      tags: ["sidebar-regression"],
      userSources: [],
    },
  });
  expect(actionableResponse.ok()).toBeTruthy();
  const { item }: { item: ActionableDetail } = await actionableResponse.json();
  return { scope, item };
}

test("repositories render as independent parents with selectable worktree children", async ({
  page,
}) => {
  const initialScopes: ScopeOptionsResponse = await (
    await page.request.get("/api/scopes")
  ).json();
  const project = initialScopes.projects.find(
    (candidate) => !candidate.archivedAt,
  )!;
  const siblingName = `Sidebar sibling ${Date.now()}`;
  const added = await page.request.post("/api/repositories", {
    data: {
      projectMode: "existing",
      projectId: project.id,
      name: siblingName,
      localPath: `C:\\repos\\SidebarSibling-${Date.now()}`,
    },
  });
  expect(added.ok()).toBeTruthy();
  const scopes: ScopeOptionsResponse = await (
    await page.request.get("/api/scopes")
  ).json();
  const repositories = scopes.projects
    .filter((candidate) => !candidate.archivedAt)
    .flatMap((candidate) => candidate.repositories);
  const repository = project.repositories.find(
    (candidate) => !candidate.archivedAt && candidate.worktrees.length > 0,
  )!;
  const worktree = repository.worktrees[0]!;

  await page.goto(`/dashboard?project=${project.id}`);
  const sidebar = page.getByRole("complementary", {
    name: "Repositories and worktrees",
  });
  const tree = sidebar.locator(".project-tree");
  await expect(tree.locator(".project-row")).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: /^Archive repository / }),
  ).toHaveCount(0);
  await expect(tree.locator(":scope > .repository-group")).toHaveCount(
    repositories.length,
  );
  const group = tree.locator(".repository-group").filter({
    has: page.getByRole("button", { name: repository.name, exact: true }),
  });
  await expect(group.locator(".worktree-row")).toHaveCount(
    repository.worktrees.length,
  );
  const repositoryButton = group.getByRole("button", {
    name: repository.name,
    exact: true,
  });
  await repositoryButton.click();
  await expect(repositoryButton).toHaveAttribute("aria-current", "page");
  let location = new URL(page.url());
  expect(location.pathname).toBe("/");
  expect(location.searchParams.get("project")).toBe(project.id);
  expect(location.searchParams.get("repository")).toBe(repository.id);
  expect(location.searchParams.has("worktree")).toBe(false);

  const worktreeButton = group
    .locator(".worktree-row")
    .filter({ hasText: worktree.name });
  await worktreeButton.click();
  await expect(worktreeButton).toHaveClass(/is-selected/);
  await expect(repositoryButton).not.toHaveAttribute("aria-current", "page");
  location = new URL(page.url());
  expect(location.searchParams.get("worktree")).toBe(worktree.id);
  const scopedUrl = page.url();

  const expander = group.locator(".repository-expander");
  await expect(expander).toHaveAccessibleName(
    `Collapse repository ${repository.name}`,
  );
  await expander.press("Enter");
  await expect(expander).toHaveAttribute("aria-expanded", "false");
  await expect(worktreeButton).toBeHidden();
  await expect(page).toHaveURL(scopedUrl);
  await expect(
    tree
      .locator(".repository-group")
      .filter({
        has: page.getByRole("button", { name: siblingName, exact: true }),
      })
      .locator(".worktree-row")
      .first(),
  ).toBeVisible();
  await expander.press("Space");
  await expect(worktreeButton).toBeVisible();
  await expect(worktreeButton).toHaveClass(/is-selected/);
  await expect(page).toHaveURL(scopedUrl);

  await page.goBack();
  await expect(repositoryButton).toHaveAttribute("aria-current", "page");
  await expect(worktreeButton).not.toHaveClass(/is-selected/);
  await page.goForward();
  await expect(worktreeButton).toHaveClass(/is-selected/);
  await page.reload();
  await expect(worktreeButton).toHaveClass(/is-selected/);
  await page
    .getByRole("banner")
    .getByRole("button", { name: project.name, exact: true })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: project.name, exact: true }),
  ).toBeVisible();
});

test("repository archival and restoration remain available outside the sidebar", async ({
  page,
}) => {
  const { scope, item } = await createScopedFixture(
    page.request,
    `Sidebar archive ${Date.now()}`,
  );
  const repository = scope.scopes.projects.find(
    (project) => project.id === scope.projectId,
  )!.repositories[0]!;
  const archived = await page.request.post(
    `/api/scopes/repository/${repository.id}/archive`,
    {
      data: { version: repository.version },
    },
  );
  expect(archived.ok()).toBeTruthy();
  const archivedScopes: ScopeOptionsResponse = await archived.json();
  const archivedRepository = archivedScopes.projects.find(
    (project) => project.id === scope.projectId,
  )!.repositories[0]!;
  expect(archivedRepository.archivedAt).not.toBeNull();
  const inherited = (
    await (await page.request.get(`/api/actionables/${item.id}`)).json()
  ).item;
  expect(inherited.status).toBe(item.status);
  expect(inherited.archiveState).toMatchObject({
    isArchived: true,
    directlyArchived: false,
  });
  await page.goto(`/archive?q=${encodeURIComponent(item.title)}`);
  await expect(page.locator(`[data-actionable-id="${item.id}"]`)).toBeVisible();
  await expect(
    page
      .locator(".sidebar")
      .getByRole("button", { name: /^(Archive|Restore) repository / }),
  ).toHaveCount(0);

  const restored = await page.request.post(
    `/api/scopes/repository/${repository.id}/restore`,
    {
      data: { version: archivedRepository.version },
    },
  );
  expect(restored.ok()).toBeTruthy();
  const restoredItem = (
    await (await page.request.get(`/api/actionables/${item.id}`)).json()
  ).item;
  expect(restoredItem.status).toBe(item.status);
  expect(restoredItem.archiveState.isArchived).toBe(false);
  await page.goto(`/?q=${encodeURIComponent(item.title)}`);
  await expect(page.locator(`[data-actionable-id="${item.id}"]`)).toBeVisible();
});
