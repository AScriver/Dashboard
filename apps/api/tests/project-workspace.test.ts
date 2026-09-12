import Database from "better-sqlite3";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { repositoryProjectRootSchema } from "@actionables/contracts";
import {
  isWithinCheckout,
  projectWorkspacePath,
  resolveProjectWorkspace,
} from "../src/project-workspace.js";

it("accepts only relative child paths and preserves legacy checkout behavior", async () => {
  for (const value of [
    ".",
    "..",
    "apps/../other",
    "C:\\apps",
    "\\\\server\\share",
    "/apps",
    "apps//web",
    "apps/web.",
    "apps /web",
    "apps/a:b",
  ]) {
    expect(repositoryProjectRootSchema.safeParse(value).success, value).toBe(
      false,
    );
  }
  expect(repositoryProjectRootSchema.parse(" apps\\web ")).toBe("apps/web");
  expect(repositoryProjectRootSchema.parse("")).toBeNull();
  expect(projectWorkspacePath("C:\\repo", "apps/web")).toBe(
    "C:\\repo\\apps\\web",
  );
  expect(projectWorkspacePath("\\\\server\\share\\repo", "apps/web")).toBe(
    "\\\\server\\share\\repo\\apps\\web",
  );
  expect(projectWorkspacePath("relative", "apps/web")).toBeNull();
  expect(projectWorkspacePath("C:\\repo", "../outside")).toBeNull();
  expect(isWithinCheckout("C:\\repo", "C:\\repository")).toBe(false);
  expect(isWithinCheckout("C:\\repo", "D:\\repo")).toBe(false);
  expect(await resolveProjectWorkspace(null, null)).toBeNull();
  expect(await resolveProjectWorkspace("C:\\legacy-missing", null)).toBe(
    "C:\\legacy-missing",
  );
});

it("checks real directories and rejects junctions outside or back to the checkout", async () => {
  const directory = await mkdtemp(
    resolve(tmpdir(), "actionables-project-root-"),
  );
  const checkout = resolve(directory, "checkout");
  const outside = resolve(directory, "outside");
  try {
    await mkdir(resolve(checkout, "apps", "web"), { recursive: true });
    await mkdir(outside);
    await writeFile(resolve(checkout, "file"), "not a directory");
    await symlink(outside, resolve(checkout, "escape"), "junction");
    await symlink(checkout, resolve(checkout, "broad"), "junction");
    await symlink(
      resolve(checkout, "apps", "web"),
      resolve(checkout, "inside"),
      "junction",
    );
    expect(await resolveProjectWorkspace(checkout, "apps/web")).toBe(
      await realpath(resolve(checkout, "apps", "web")),
    );
    expect(await resolveProjectWorkspace(checkout, "inside")).toBe(
      await realpath(resolve(checkout, "apps", "web")),
    );
    for (const root of ["missing", "file"])
      await expect(resolveProjectWorkspace(checkout, root)).rejects.toThrow(
        "missing or inaccessible",
      );
    for (const root of ["escape", "broad"])
      await expect(resolveProjectWorkspace(checkout, root)).rejects.toThrow(
        "outside its selected checkout",
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("adds project roots without changing a populated repository", async () => {
  const migrations = new URL("../../../prisma/migrations/", import.meta.url);
  const target = "20260911235100_repository_project_roots";
  const database = new Database(":memory:");
  try {
    for (const name of (await readdir(migrations))
      .filter((name) => /^\d/.test(name) && name < target)
      .sort())
      database.exec(
        await readFile(new URL(`${name}/migration.sql`, migrations), "utf8"),
      );
    database.exec(`INSERT INTO "Project" ("id", "externalKey", "name", "updatedAt") VALUES ('p', 'p', 'Project', CURRENT_TIMESTAMP);
      INSERT INTO "Repository" ("id", "externalKey", "name", "projectId", "localPath", "version", "updatedAt") VALUES ('r', 'r', 'Repository', 'p', 'C:\\repo', 7, CURRENT_TIMESTAMP);`);
    const before = database.prepare('SELECT * FROM "Repository"').get();
    database.exec(
      await readFile(new URL(`${target}/migration.sql`, migrations), "utf8"),
    );
    expect(database.prepare('SELECT * FROM "Repository"').get()).toEqual({
      ...(before as object),
      projectRoot: null,
    });
  } finally {
    database.close();
  }
});
