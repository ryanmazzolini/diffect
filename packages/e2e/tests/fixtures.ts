import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";

interface FixtureProcess {
  url: string;
  stderr: () => string;
  close: () => Promise<void>;
}

interface TestFixtures {
  fixtureServer: FixtureProcess;
}

const fixtureServerScript = fileURLToPath(new URL("../fixture-server.mjs", import.meta.url));

async function startFixtureProcess(multi: boolean): Promise<FixtureProcess> {
  const child = spawn(process.execPath, [fixtureServerScript], {
    env: {
      ...process.env,
      PORT: "0",
      ...(multi ? { FIXTURE_MULTI: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const url = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (result: { url: string } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if ("url" in result) resolve(result.url);
      else reject(result.error);
    };
    const timeout = setTimeout(() => {
      finish(new Error(`fixture server did not start within 30s\n${stderr}`));
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/fixture diffectd ready (http:\/\/\S+)/);
      if (match?.[1]) finish({ url: match[1] });
    });
    child.once("error", (error) => finish({ error }));
    child.once("exit", (code, signal) => {
      finish(new Error(`fixture server exited before startup (${signal ?? code})\n${stderr}`));
    });
  }).catch((error) => {
    child.kill("SIGKILL");
    throw error;
  });

  return {
    url,
    stderr: () => stderr,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => child.kill("SIGKILL"), 2_500);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
}

export const test = base.extend<TestFixtures>({
  fixtureServer: async ({}, use, testInfo) => {
    const server = await startFixtureProcess(testInfo.project.name === "chromium-multi");
    try {
      await use(server);
    } finally {
      await server.close();
      if (testInfo.status !== testInfo.expectedStatus && server.stderr()) {
        await testInfo.attach("fixture-server.stderr", {
          body: Buffer.from(server.stderr()),
          contentType: "text/plain",
        });
      }
    }
  },
  baseURL: async ({ fixtureServer }, use) => {
    await use(fixtureServer.url);
  },
});

export { expect };
export type { Locator, Page } from "@playwright/test";
