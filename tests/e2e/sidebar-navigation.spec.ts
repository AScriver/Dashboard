import type { ScopeOptionsResponse } from "@actionables/contracts";
import { expect, test } from "@playwright/test";

test("repositories render as independent parents with selectable worktree children", async ({
  page,
}) => {
  const initialScopes: ScopeOptionsResponse = await (
    await page.request.get("/api/scopes")
  ).json();
  const project = initialScopes.projects.find(
    (candidate) => !candidate.archivedAt,
  )!;
  const added = await page.request.post("/api/repositories", {
    data: {
      projectMode: "existing",
      projectId: project.id,
      name: `Sidebar sibling ${Date.now()}`,
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
    tree.locator(".repository-group").last().locator(".worktree-row").first(),
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
