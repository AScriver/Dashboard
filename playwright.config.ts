import { defineConfig, devices } from "@playwright/test";

const node = JSON.stringify(process.execPath);
const reuseExistingServer =
  process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1";
// Reuse must never silently attach mutating tests to the installed app.
if (
  reuseExistingServer &&
  (!process.env.WEB_PORT ||
    !process.env.API_PORT ||
    process.env.WEB_PORT === "4173" ||
    process.env.API_PORT === "4174" ||
    !process.env.DATABASE_URL ||
    /(?:^|[/\\])actionables\.db$/i.test(process.env.DATABASE_URL))
) {
  throw new Error(
    "Reusing a test server requires explicit nondefault WEB_PORT/API_PORT and an isolated DATABASE_URL. Verify the running server uses that database before testing.",
  );
}
const webPort = process.env.WEB_PORT ?? "4173";
const apiPort = process.env.API_PORT ?? "4174";
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  use: {
    baseURL,
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: [
            {
              name: "actionables-agent-integration-setup-dismissed-v1",
              value: "dismissed",
            },
          ],
        },
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.PLAYWRIGHT_CHANNEL
          ? {
              channel: process.env.PLAYWRIGHT_CHANNEL as "chrome" | "msedge",
            }
          : {}),
      },
    },
  ],
  webServer: {
    command: `${node} scripts/start-e2e.mjs`,
    url: `${baseURL}/api/health`,
    reuseExistingServer,
    timeout: 120_000,
    env: {
      DATABASE_URL: "file:./data/actionables-e2e.db",
      API_PORT: apiPort,
      WEB_PORT: webPort,
    },
  },
});
