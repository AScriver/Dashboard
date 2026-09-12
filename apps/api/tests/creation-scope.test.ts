import { afterEach, expect, it, vi } from "vitest";
import { scopeOptionsResponseSchema } from "@actionables/contracts";
import {
  availableCreationScopes,
  defaultCreationWorktreeStorageKey,
  readDefaultCreationWorktree,
  resolveCreationScope,
} from "../../../src/creation-scope.js";

const active = {
  isArchived: false,
  directlyArchived: false,
  archivedAt: null,
  inheritedFrom: [],
};
function scopes() {
  return scopeOptionsResponseSchema.parse({
    projects: ["first", "preferred"].map((id) => ({
      id,
      name: id,
      version: 1,
      archivedAt: null,
      archiveState: active,
      repositories: [
        {
          id: `${id}-repo`,
          name: "repo",
          version: 1,
          archivedAt: null,
          archiveState: active,
          worktrees: ["main", "branch"].map((name) => ({
            id: `${id}-${name}`,
            name,
            version: 1,
            archivedAt: null,
            archiveState: active,
          })),
        },
      ],
    })),
  });
}
afterEach(() => vi.unstubAllGlobals());

it("uses saved defaults only after coherent current worktree, repository and project selections", () => {
  const data = scopes();
  const resolve = (current = {}, saved: string | null = "preferred-branch") =>
    resolveCreationScope(data, current, saved)?.worktreeId;
  expect(resolve()).toBe("preferred-branch");
  expect(resolve({ projectId: "first" })).toBe("first-main");
  expect(resolve({ repositoryId: "first-repo" })).toBe("first-main");
  expect(resolve({ worktreeId: "first-branch" })).toBe("first-branch");
  expect(resolve({ projectId: "first", worktreeId: "preferred-branch" })).toBe(
    "first-main",
  );
  expect(
    resolve({
      projectId: "first",
      repositoryId: "missing",
      worktreeId: "missing",
    }),
  ).toBe("first-main");
  expect(resolve({ projectId: "missing" })).toBe("preferred-branch");
  expect(resolve({}, "removed")).toBe("first-main");
  expect(resolve({}, null)).toBe("first-main");
});

it("skips archived ancestors and missing worktrees and follows reassigned worktree ownership", () => {
  for (const level of ["project", "repository", "worktree"]) {
    const data = scopes();
    const project = data.projects[1]!;
    const target =
      level === "project"
        ? project
        : level === "repository"
          ? project.repositories[0]!
          : project.repositories[0]!.worktrees[1]!;
    target.archiveState.isArchived = true;
    expect(resolveCreationScope(data, {}, "preferred-branch")?.worktreeId).toBe(
      "first-main",
    );
  }
  const data = scopes();
  const moved = data.projects[1]!.repositories.pop()!;
  data.projects[0]!.repositories.push(moved);
  expect(resolveCreationScope(data, {}, "preferred-branch")).toMatchObject({
    projectId: "first",
    repositoryId: "preferred-repo",
    worktreeId: "preferred-branch",
  });
  data.projects[0]!.archiveState.isArchived = true;
  expect(resolveCreationScope(data)).toBeUndefined();
  expect(availableCreationScopes(data)).toEqual([]);
});

it("reads browser preferences defensively without requiring storage", () => {
  const getItem = vi.fn().mockReturnValue("preferred-branch");
  vi.stubGlobal("localStorage", { getItem });
  expect(readDefaultCreationWorktree()).toBe("preferred-branch");
  expect(getItem).toHaveBeenCalledWith(defaultCreationWorktreeStorageKey);
  getItem.mockReturnValue(null);
  expect(readDefaultCreationWorktree()).toBeNull();
  getItem.mockReturnValue("not-a-current-scope");
  expect(
    resolveCreationScope(scopes(), {}, readDefaultCreationWorktree())
      ?.worktreeId,
  ).toBe("first-main");
  getItem.mockImplementation(() => {
    throw new Error("Storage denied");
  });
  expect(readDefaultCreationWorktree()).toBeNull();
});
