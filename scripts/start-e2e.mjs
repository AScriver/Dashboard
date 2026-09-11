import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import process from "node:process";

const databasePath = "data/actionables-e2e.db";
const webPort = process.env.WEB_PORT ?? "4173";
for (const suffix of ["", "-journal", "-shm", "-wal"]) {
  await rm(`${databasePath}${suffix}`, { force: true });
}

const setupCommands = [
  ["node_modules/typescript/bin/tsc", "-p", "packages/contracts/tsconfig.json"],
  ["node_modules/prisma/build/index.js", "generate"],
  ["node_modules/tsx/dist/cli.mjs", "scripts/ensure-database-file.ts"],
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  ["node_modules/tsx/dist/cli.mjs", "apps/api/src/seed.ts"],
];

for (const args of setupCommands) {
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The launcher imports contracts, so load it after setup builds that package.
const { superviseChildren } = await import("./start-actionables.mjs");
superviseChildren([
  {
    label: "API",
    args: ["node_modules/tsx/dist/cli.mjs", "apps/api/src/server.ts"],
  },
  {
    label: "Web",
    args: [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      webPort,
    ],
  },
]);
