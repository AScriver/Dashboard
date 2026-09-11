import { spawn } from "node:child_process";
import process from "node:process";
import { selectAndPersistRuntimePorts } from "./runtime-ports.mjs";

function childSpecs(mode) {
  if (mode === "development") {
    return [
      {
        label: "API",
        args: [
          "node_modules/tsx/dist/cli.mjs",
          "watch",
          "apps/api/src/server.ts",
        ],
      },
      {
        label: "Web",
        args: ["node_modules/vite/bin/vite.js"],
      },
    ];
  }
  if (mode === "production") {
    return [
      {
        label: "API",
        args: ["apps/api/dist/server.js"],
      },
      {
        label: "Web",
        args: ["node_modules/vite/bin/vite.js", "preview"],
      },
    ];
  }
  throw new Error(`Unsupported Actionables launch mode: ${mode}`);
}

function displayError(error) {
  if (!(error instanceof Error)) return String(error);
  const messages = [error.message];
  let cause = error.cause;
  while (cause instanceof Error) {
    messages.push(cause.message);
    cause = cause.cause;
  }
  return messages.join("\nCaused by: ");
}

/** Select shared runtime ports and launch the requested service pair. */
export async function startActionables(
  mode,
  { environment = process.env, spawnProcess = spawn, output = console } = {},
) {
  const selection = await selectAndPersistRuntimePorts({
    webPort: environment.WEB_PORT,
    apiPort: environment.API_PORT,
    environment,
    warn: (message) => output.warn(message),
  });
  const {
    ACTIONABLES_PREVIOUS_API_PORT: _ignoredPreviousApiPort,
    ...baseEnvironment
  } = environment;
  const runtimeEnvironment = {
    ...baseEnvironment,
    WEB_PORT: String(selection.pair.webPort),
    API_PORT: String(selection.pair.apiPort),
  };
  if (
    selection.previousPair &&
    selection.previousPair.apiPort !== selection.pair.apiPort
  ) {
    runtimeEnvironment.ACTIONABLES_PREVIOUS_API_PORT = String(
      selection.previousPair.apiPort,
    );
  }

  output.log(
    [
      `Actionables selected web/API ports ${selection.pair.webPort}/${selection.pair.apiPort} (${selection.source}); saved to ${selection.statePath}.`,
      `Web: ${selection.runtimeConfig.webOrigin}`,
      `API: ${selection.runtimeConfig.apiOrigin}`,
      `Health: ${selection.runtimeConfig.healthEndpoint}`,
      `MCP: ${selection.runtimeConfig.mcpEndpoint}`,
    ].join("\n"),
  );

  try {
    await selection.reservations.releaseAll();
  } catch (error) {
    throw new Error("Unable to release startup port reservations.", {
      cause: error,
    });
  }

  try {
    return {
      runtimeConfig: selection.runtimeConfig,
      statePath: selection.statePath,
      ...superviseChildren(childSpecs(mode), {
        environment: runtimeEnvironment,
        spawnProcess,
        output,
      }),
    };
  } catch (error) {
    throw new Error(`Unable to start Actionables in ${mode} mode.`, {
      cause: error,
    });
  }
}

/** Start Node services with sibling shutdown and an idempotent stop function. */
export function superviseChildren(
  specs,
  { environment = process.env, spawnProcess = spawn, output = console } = {},
) {
  const children = [];
  try {
    for (const spec of specs) {
      children.push({
        ...spec,
        process: spawnProcess(process.execPath, spec.args, {
          stdio: "inherit",
          env: environment,
        }),
      });
    }
  } catch (error) {
    for (const child of children) {
      if (child.process.exitCode === null) child.process.kill();
    }
    throw error;
  }

  let stopping;
  const stop = (exitCode = 0) => {
    if (stopping) return stopping;
    stopping = Promise.all(
      children.map(
        (child) =>
          new Promise((resolvePromise) => {
            if (
              child.process.exitCode !== null ||
              child.process.signalCode !== null
            ) {
              resolvePromise();
              return;
            }
            child.process.once("close", resolvePromise);
            child.process.kill();
          }),
      ),
    ).finally(() => {
      process.off("SIGINT", stopForSignal);
      process.off("SIGTERM", stopForSignal);
      process.exitCode = exitCode;
    });
    return stopping;
  };
  const stopForSignal = () => {
    void stop(0);
  };

  for (const child of children) {
    child.process.once("error", (error) => {
      output.error(`${child.label} failed to start.\n${displayError(error)}`);
      void stop(1);
    });
    child.process.once("exit", (code, signal) => {
      if (!stopping) {
        output.error(
          `${child.label} exited unexpectedly (${signal ?? code ?? "unknown"}).`,
        );
        void stop(code || 1);
      }
    });
  }

  process.once("SIGINT", stopForSignal);
  process.once("SIGTERM", stopForSignal);

  return {
    children: children.map((child) => child.process),
    stop,
  };
}

export async function runActionables(mode) {
  try {
    await startActionables(mode);
  } catch (error) {
    console.error(displayError(error));
    process.exitCode = 1;
  }
}
