import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { reconcileCodexMcpConfigAtStartup } from "../src/agent-integration.js";
import { startActionables } from "../../../scripts/start-actionables.mjs";

function listen(port = 0) {
  const server = createServer();
  server.unref();
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      resolvePromise(server),
    );
  });
}

function close(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit("close", 0, null);
  };
  return child;
}

it.each(["development", "production"])(
  "propagates an unavailable saved API port and reconciles its managed Codex endpoint in %s mode",
  async (mode) => {
    const directory = await mkdtemp(
      join(tmpdir(), "actionables-startup-reconciliation-"),
    );
    const home = join(directory, "home");
    const statePath = join(directory, "runtime-ports.json");
    const configPath = join(home, ".codex", "config.toml");
    const occupiedApi = await listen();
    const savedApiPort = occupiedApi.address().port;
    const savedWebProbe = await listen();
    const savedWebPort = savedWebProbe.address().port;
    await close(savedWebProbe);
    const sensitiveValue = ["startup", "credential", "fixture"].join("-");
    const originalConfig = [
      "# Preserve this prefix and its line endings",
      "[mcp_servers.actionables]",
      `url = "http://127.0.0.1:${savedApiPort}/mcp"`,
      'bearer_token_env_var = "ACTIONABLES_MCP_TOKEN"',
      "enabled = true",
      "required = false",
      "",
      "[features]",
      "web_search = true",
      "",
    ].join("\r\n");
    const childEnvironments = [];
    const outputMessages = [];
    let running;

    try {
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(configPath, originalConfig, "utf8");
      await writeFile(
        statePath,
        `${JSON.stringify({
          version: 1,
          webPort: savedWebPort,
          apiPort: savedApiPort,
        })}\n`,
        "utf8",
      );

      running = await startActionables(mode, {
        environment: {
          ...process.env,
          ACTIONABLES_AGENT_HOME: home,
          ACTIONABLES_MCP_TOKEN: sensitiveValue,
          ACTIONABLES_PREVIOUS_API_PORT: "1",
          ACTIONABLES_RUNTIME_PORT_STATE_PATH: statePath,
          API_PORT: undefined,
          WEB_PORT: undefined,
        },
        output: {
          error(message) {
            outputMessages.push(message);
          },
          log(message) {
            outputMessages.push(message);
          },
          warn(message) {
            outputMessages.push(message);
          },
        },
        spawnProcess(_executable, _args, options) {
          childEnvironments.push(options.env);
          return fakeChild();
        },
      });

      expect(childEnvironments).toHaveLength(2);
      for (const childEnvironment of childEnvironments) {
        expect(childEnvironment.ACTIONABLES_PREVIOUS_API_PORT).toBe(
          String(savedApiPort),
        );
        expect(childEnvironment.API_PORT).not.toBe(String(savedApiPort));
        expect(childEnvironment.WEB_PORT).toBe(
          String(running.runtimeConfig.webPort),
        );
        expect(childEnvironment.API_PORT).toBe(
          String(running.runtimeConfig.apiPort),
        );
      }
      expect(outputMessages.join("\n")).toContain(
        running.runtimeConfig.webOrigin,
      );
      expect(outputMessages.join("\n")).toContain(
        running.runtimeConfig.apiOrigin,
      );
      expect(outputMessages.join("\n")).toContain(
        running.runtimeConfig.healthEndpoint,
      );
      expect(outputMessages.join("\n")).toContain(
        running.runtimeConfig.mcpEndpoint,
      );
      expect(outputMessages.join("\n")).not.toContain(sensitiveValue);

      const reconciliation = await reconcileCodexMcpConfigAtStartup({
        environment: childEnvironments[0],
        homeDirectory: home,
        runtimeConfig: running.runtimeConfig,
      });

      expect(reconciliation).toMatchObject({
        outcome: "updated",
        message: expect.stringContaining("Restart Codex"),
      });
      await expect(readFile(configPath, "utf8")).resolves.toBe(
        originalConfig.replace(
          `"http://127.0.0.1:${savedApiPort}/mcp"`,
          JSON.stringify(running.runtimeConfig.mcpEndpoint),
        ),
      );
    } finally {
      if (running) await running.stop();
      await close(occupiedApi);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("removes a stale previous-port handoff when startup has no saved endpoint", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "actionables-startup-no-previous-port-"),
  );
  const statePath = join(directory, "runtime-ports.json");
  let running;

  try {
    let childEnvironment;
    running = await startActionables("development", {
      environment: {
        ...process.env,
        ACTIONABLES_PREVIOUS_API_PORT: "1",
        ACTIONABLES_RUNTIME_PORT_STATE_PATH: statePath,
        API_PORT: undefined,
        WEB_PORT: undefined,
      },
      output: {
        error() {},
        log() {},
        warn() {},
      },
      spawnProcess(_executable, _args, options) {
        childEnvironment = options.env;
        return fakeChild();
      },
    });

    expect(childEnvironment).not.toHaveProperty(
      "ACTIONABLES_PREVIOUS_API_PORT",
    );
  } finally {
    if (running) await running.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
