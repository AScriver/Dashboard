import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, createServer as createViteServer, preview } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startActionables,
  superviseChildren,
} from "../../../scripts/start-actionables.mjs";

const resources = [];

function track(dispose) {
  resources.push(dispose);
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function listenTcp(port) {
  const server = createTcpServer((socket) => socket.destroy());
  server.unref();
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      resolvePromise(server),
    );
  });
}

async function occupyIfFree(port) {
  try {
    const server = await listenTcp(port);
    track(() => closeServer(server));
    return server;
  } catch (error) {
    if (error?.code === "EADDRINUSE") return null;
    throw error;
  }
}

function canConnect(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (connected) => {
      socket.destroy();
      resolvePromise(connected);
    };
    socket.setTimeout(2_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
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

async function startHealthApi(port, marker) {
  const server = createHttpServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", marker }));
      return;
    }
    response.writeHead(404).end();
  });
  server.unref();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, resolvePromise);
  });
  track(() => closeServer(server));
  return server;
}

function useRuntimeEnvironment(runtimeConfig) {
  const previousWebPort = process.env.WEB_PORT;
  const previousApiPort = process.env.API_PORT;
  process.env.WEB_PORT = String(runtimeConfig.webPort);
  process.env.API_PORT = String(runtimeConfig.apiPort);
  track(() => {
    if (previousWebPort === undefined) delete process.env.WEB_PORT;
    else process.env.WEB_PORT = previousWebPort;
    if (previousApiPort === undefined) delete process.env.API_PORT;
    else process.env.API_PORT = previousApiPort;
  });
}

async function startVite(mode, directory) {
  if (mode === "development") {
    const server = await createViteServer({
      configFile: resolve("vite.config.ts"),
      logLevel: "silent",
      server: { hmr: false },
    });
    await server.listen();
    track(() => server.close());
    return server;
  }

  const outDir = join(directory, "dist");
  await build({
    configFile: resolve("vite.config.ts"),
    logLevel: "silent",
    build: { outDir },
  });
  const server = await preview({
    configFile: resolve("vite.config.ts"),
    logLevel: "silent",
    build: { outDir },
  });
  track(() => server.close());
  return server;
}

afterEach(async () => {
  await Promise.allSettled(
    resources
      .splice(0)
      .reverse()
      .map((dispose) => dispose()),
  );
});

describe.sequential("startup launcher proxy integration", () => {
  it.each(["stop", "exit", "error"])(
    "shuts down supervised services and removes signal handlers after %s",
    async (trigger) => {
      const children = [fakeChild(), fakeChild()];
      const kills = children.map((child) => vi.spyOn(child, "kill"));
      const signalCounts = ["SIGINT", "SIGTERM"].map((signal) =>
        process.listenerCount(signal),
      );
      const previousExitCode = process.exitCode;
      const errors = [];
      let childIndex = 0;
      const running = superviseChildren(
        [
          { label: "API", args: [] },
          { label: "Web", args: [] },
        ],
        {
          spawnProcess: () => children[childIndex++],
          output: { error: (message) => errors.push(message) },
        },
      );
      try {
        if (trigger === "exit") {
          children[0].exitCode = 2;
          children[0].emit("exit", 2, null);
        } else if (trigger === "error") {
          children[0].emit("error", new Error("spawn failed"));
        }

        const stopped = running.stop();
        expect(running.stop()).toBe(stopped);
        await stopped;
        expect(kills[0]).toHaveBeenCalledTimes(trigger === "exit" ? 0 : 1);
        expect(kills[1]).toHaveBeenCalledTimes(1);
        expect(process.exitCode).toBe(
          trigger === "exit" ? 2 : trigger === "error" ? 1 : 0,
        );
        expect(errors).toEqual(
          trigger === "exit"
            ? ["API exited unexpectedly (2)."]
            : trigger === "error"
              ? ["API failed to start.\nspawn failed"]
              : [],
        );
        expect(
          ["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal)),
        ).toEqual(signalCounts);
      } finally {
        await running.stop();
        process.exitCode = previousExitCode;
      }
    },
  );

  it.each(["development", "production"])(
    "propagates one fallback pair through the real Vite %s proxy",
    async (mode) => {
      const directory = await mkdtemp(
        join(tmpdir(), "actionables-startup-proxy-"),
      );
      track(() => rm(directory, { recursive: true, force: true }));
      const statePath = join(directory, "runtime-ports.json");
      const defaultWebListener = await occupyIfFree(4173);
      const defaultApiListener = await occupyIfFree(4174);
      expect(await canConnect(4173)).toBe(true);
      expect(await canConnect(4174)).toBe(true);

      const spawned = [];
      const output = [];
      const running = await startActionables(mode, {
        environment: {
          ...process.env,
          ACTIONABLES_RUNTIME_PORT_STATE_PATH: statePath,
          API_PORT: undefined,
          WEB_PORT: undefined,
        },
        output: {
          error(message) {
            output.push(message);
          },
          log(message) {
            output.push(message);
          },
          warn(message) {
            output.push(message);
          },
        },
        spawnProcess(_executable, args, options) {
          spawned.push({ args, environment: options.env });
          return fakeChild();
        },
      });
      track(() => running.stop());

      expect(running.runtimeConfig).toMatchObject({
        webHost: "127.0.0.1",
        apiHost: "127.0.0.1",
      });
      expect(running.runtimeConfig.webPort).not.toBe(4173);
      expect(running.runtimeConfig.apiPort).not.toBe(4174);
      expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
        version: 1,
        webPort: running.runtimeConfig.webPort,
        apiPort: running.runtimeConfig.apiPort,
      });
      expect(spawned).toHaveLength(2);
      for (const child of spawned) {
        expect(child.environment.WEB_PORT).toBe(
          String(running.runtimeConfig.webPort),
        );
        expect(child.environment.API_PORT).toBe(
          String(running.runtimeConfig.apiPort),
        );
      }
      expect(output.join("\n")).toContain(running.runtimeConfig.webOrigin);
      expect(output.join("\n")).toContain(running.runtimeConfig.apiOrigin);
      expect(output.join("\n")).toContain(running.runtimeConfig.healthEndpoint);
      expect(output.join("\n")).toContain(running.runtimeConfig.mcpEndpoint);

      useRuntimeEnvironment(running.runtimeConfig);
      const marker = `${mode}-${running.runtimeConfig.apiPort}`;
      const api = await startHealthApi(running.runtimeConfig.apiPort, marker);
      const vite = await startVite(mode, directory);

      expect(api.address()).toMatchObject({
        address: "127.0.0.1",
        port: running.runtimeConfig.apiPort,
      });
      expect(vite.httpServer.address()).toMatchObject({
        address: "127.0.0.1",
        port: running.runtimeConfig.webPort,
      });

      const healthResponse = await fetch(running.runtimeConfig.healthEndpoint);
      expect(healthResponse.status).toBe(200);
      await expect(healthResponse.json()).resolves.toEqual({
        status: "ok",
        marker,
      });
      const webResponse = await fetch(running.runtimeConfig.webOrigin);
      expect(webResponse.status).toBe(200);
      expect(await webResponse.text()).toContain('id="root"');
      expect(running.runtimeConfig.mcpEndpoint).toBe(
        `${running.runtimeConfig.apiOrigin}/mcp`,
      );

      expect(defaultWebListener?.listening ?? (await canConnect(4173))).toBe(
        true,
      );
      expect(defaultApiListener?.listening ?? (await canConnect(4174))).toBe(
        true,
      );
    },
    30_000,
  );

  it("fails clearly if a selected API port is taken after reservations release", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "actionables-startup-race-"),
    );
    track(() => rm(directory, { recursive: true, force: true }));
    const statePath = join(directory, "runtime-ports.json");
    const errors = [];
    let collision;
    let collisionStarted;

    const running = await startActionables("production", {
      environment: {
        ...process.env,
        ACTIONABLES_RUNTIME_PORT_STATE_PATH: statePath,
        API_PORT: undefined,
        WEB_PORT: undefined,
      },
      output: {
        error(message) {
          errors.push(message);
        },
        log() {},
        warn() {},
      },
      spawnProcess(_executable, args, options) {
        const child = fakeChild();
        if (args[0] === "apps/api/dist/server.js") {
          collisionStarted = listenTcp(Number(options.env.API_PORT)).then(
            (server) => {
              collision = server;
              child.exitCode = 1;
              child.emit("exit", 1, null);
            },
          );
        }
        return child;
      },
    });
    track(() => running.stop());

    await collisionStarted;
    track(() => closeServer(collision));
    await vi.waitFor(() => {
      expect(errors).toContain("API exited unexpectedly (1).");
    });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      webPort: running.runtimeConfig.webPort,
      apiPort: running.runtimeConfig.apiPort,
    });
    expect(collision.address()).toMatchObject({
      address: "127.0.0.1",
      port: running.runtimeConfig.apiPort,
    });
  });
});
