import type { ScopeOptionsResponse } from "@actionables/contracts";

export const defaultCreationWorktreeStorageKey =
  "actionables-default-creation-worktree";
export type CreationScope = {
  projectId: string;
  repositoryId: string;
  worktreeId: string;
};

/** List complete active scopes, deriving current ownership from the server. */
export function availableCreationScopes(scopes: ScopeOptionsResponse) {
  return scopes.projects
    .filter((project) => !project.archiveState.isArchived)
    .flatMap((project) =>
      project.repositories
        .filter((repository) => !repository.archiveState.isArchived)
        .flatMap((repository) =>
          repository.worktrees
            .filter((worktree) => !worktree.archiveState.isArchived)
            .map((worktree) => ({
              projectId: project.id,
              repositoryId: repository.id,
              worktreeId: worktree.id,
              label: `${project.name} / ${repository.name} / ${worktree.name}`,
            })),
        ),
    );
}

/** Prefer a coherent current selection, then the saved worktree, then an active scope. */
export function resolveCreationScope(
  scopes: ScopeOptionsResponse,
  current: Partial<CreationScope> = {},
  savedWorktreeId: string | null = null,
): CreationScope | undefined {
  const available = availableCreationScopes(scopes);
  return (
    available.find(
      (scope) =>
        scope.worktreeId === current.worktreeId &&
        (!current.repositoryId ||
          scope.repositoryId === current.repositoryId) &&
        (!current.projectId || scope.projectId === current.projectId),
    ) ??
    available.find(
      (scope) =>
        scope.repositoryId === current.repositoryId &&
        (!current.projectId || scope.projectId === current.projectId),
    ) ??
    available.find((scope) => scope.projectId === current.projectId) ??
    available.find((scope) => scope.worktreeId === savedWorktreeId) ??
    available[0]
  );
}

/** Browser storage may be unavailable; creation can still use the active scopes. */
export function readDefaultCreationWorktree(): string | null {
  try {
    return localStorage.getItem(defaultCreationWorktreeStorageKey) || null;
  } catch {
    return null;
  }
}
