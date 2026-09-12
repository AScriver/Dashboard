import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("saves, applies, overrides and clears a default scope while preserving neutral creation", async ({
  page,
}) => {
  const before = await (await page.request.get("/api/scopes")).json();
  const first = before.projects.find(
    (project: { archivedAt: string | null }) => !project.archivedAt,
  );
  const created = await page.request.post("/api/repositories", {
    data: {
      projectMode: "new",
      projectName: `Preferred project ${Date.now()}`,
      name: "Preferred repository",
      localPath: `C:\\repos\\default-scope-${Date.now()}`,
    },
  });
  expect(created.ok()).toBe(true);
  const preferred = await created.json();
  await page.goto("/settings");
  const section = page.getByRole("region", {
    name: "Default actionable scope",
  });
  const selector = section.getByRole("combobox", {
    name: "Default scope",
    exact: true,
  });
  await selector.selectOption(preferred.worktreeId);
  await selector.press("Tab");
  await expect(
    section.getByRole("button", { name: "Save default scope" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(section.getByRole("status")).toHaveText(
    "Default scope saved for this browser.",
  );
  await page.reload();
  await expect(selector).toHaveValue(preferred.worktreeId);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto("/");
  await page.getByRole("button", { name: "New actionable" }).click();
  const dialog = page.getByRole("dialog", { name: "New actionable" });
  await expect(
    dialog.getByRole("combobox", { name: "Project", exact: true }),
  ).toHaveValue(preferred.projectId);
  await expect(
    dialog.getByRole("combobox", { name: "Repository", exact: true }),
  ).toHaveValue(preferred.repositoryId);
  await expect(
    dialog.getByRole("combobox", { name: "Worktree", exact: true }),
  ).toHaveValue(preferred.worktreeId);
  await expect(dialog.getByRole("combobox", { name: /^Priority/ })).toHaveValue(
    "Unset",
  );
  await expect(
    dialog.getByRole("combobox", { name: /^Likely effort/ }),
  ).toHaveValue("Unknown");
  await dialog.getByLabel("Title").fill("Default scope neutral creation");
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/actionables") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create actionable" }).click();
  const saved = (await (await response).json()).item;
  expect(saved).toMatchObject({
    status: "Inbox",
    priority: "Unset",
    effort: "Unknown",
    evidenceState: "Unclassified",
    scope: {
      projectId: preferred.projectId,
      repositoryId: preferred.repositoryId,
      worktreeId: preferred.worktreeId,
    },
  });

  await page.goto(`/?project=${first.id}`);
  await page.getByRole("button", { name: "New actionable" }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Project", exact: true }),
  ).toHaveValue(first.id);
  await dialog.getByRole("button", { name: "Close actionable form" }).click();

  const archived = await page.request.post(
    `/api/scopes/worktree/${preferred.worktreeId}/archive`,
    { data: { version: 1 } },
  );
  expect(archived.ok()).toBe(true);
  await page.goto("/settings");
  await expect(
    section.getByText("Saved scope is unavailable.", { exact: false }),
  ).toBeVisible();
  await page.goto("/");
  await page.getByRole("button", { name: "New actionable" }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Worktree", exact: true }),
  ).not.toHaveValue(preferred.worktreeId);
  await expect(
    dialog.getByRole("combobox", { name: "Worktree", exact: true }),
  ).not.toHaveValue("");
  await dialog.getByRole("button", { name: "Close actionable form" }).click();
  await page.goto("/settings");
  await section.getByRole("button", { name: "Clear default scope" }).click();
  await expect(section.getByRole("status")).toHaveText(
    "Default scope cleared.",
  );
  await page.reload();
  await expect(selector).toHaveValue("");
});

test("reports unavailable browser storage without claiming a preference was saved", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "actionables-default-creation-worktree")
        throw new Error("Storage denied for fixture");
      setItem.call(this, key, value);
    };
  });
  await page.goto("/settings");
  const section = page.getByRole("region", {
    name: "Default actionable scope",
  });
  const select = section.getByRole("combobox", {
    name: "Default scope",
    exact: true,
  });
  await select.selectOption({ index: 1 });
  await section.getByRole("button", { name: "Save default scope" }).click();
  await expect(section.getByRole("alert")).toContainText(
    "Could not save the default scope",
  );
  await expect(section.getByRole("status")).toHaveCount(0);
  await page.reload();
  await expect(select).toHaveValue("");
});
