import { realpath, stat } from "node:fs/promises";
import { win32 } from "node:path";
import { repositoryProjectRootSchema } from "@actionables/contracts";

/** Compare complete Windows path segments, including drive and UNC boundaries. */
export function isWithinCheckout(checkout: string, directory: string): boolean {
  const relative = win32.relative(checkout, directory);
  return (
    !win32.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith("..\\")
  );
}

/** Resolve configured scope lexically; invalid metadata never falls back to root. */
export function projectWorkspacePath(
  checkout: string | null,
  projectRoot: string | null,
): string | null {
  if (!projectRoot) return checkout;
  const parsed = repositoryProjectRootSchema.safeParse(projectRoot);
  if (
    !parsed.success ||
    !parsed.data ||
    !checkout ||
    !/^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(checkout)
  )
    return null;
  const resolved = win32.resolve(checkout, parsed.data);
  return resolved.length <= 4_096 ? resolved : null;
}

/** Validate a configured project on disk before offering a launch into it. */
export async function resolveProjectWorkspace(
  checkout: string | null,
  projectRoot: string | null,
): Promise<string | null> {
  if (!projectRoot) return checkout;
  const path = projectWorkspacePath(checkout, projectRoot);
  if (!path)
    throw new Error(
      "The project directory or checkout path is invalid. Correct it in Repository projects settings.",
    );
  let canonicalCheckout: string;
  let canonicalProject: string;
  try {
    [canonicalCheckout, canonicalProject] = await Promise.all([
      realpath(checkout!),
      realpath(path),
    ]);
    if (!(await stat(canonicalProject)).isDirectory())
      throw new Error("Not a directory");
  } catch {
    throw new Error(
      "The configured project directory is missing or inaccessible. Restore it or correct Repository projects settings, then retry.",
    );
  }
  if (
    !isWithinCheckout(canonicalCheckout, canonicalProject) ||
    win32.relative(canonicalCheckout, canonicalProject) === ""
  )
    throw new Error(
      "The project directory resolves outside its selected checkout or back to the checkout root. Correct Repository projects settings.",
    );
  return canonicalProject;
}
