import { spawn } from "node:child_process";

// Thin wrapper around pg_dump/pg_restore/psql. In CI (GitHub Actions), these are installed
// directly on the runner (`apt-get install postgresql-client`) and called as-is. For local
// development where they aren't on PATH, set PG_TOOLS_VIA_DOCKER=1 to run them inside the
// postgres:17 Docker image instead (reaching the local stack via host.docker.internal) -- same
// binaries, same behavior, just sourced differently.

function viaDocker() {
  return process.env.PG_TOOLS_VIA_DOCKER === "1";
}

export function runPgTool(tool, args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    let cmd = tool;
    let finalArgs = args;
    if (viaDocker()) {
      cmd = "docker";
      finalArgs = ["run", "--rm", "-i", "--add-host=host.docker.internal:host-gateway", "postgres:17", tool, ...args];
    }
    const child = spawn(cmd, finalArgs, { env: { ...process.env, ...env } });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (d) => stdoutChunks.push(d));
    child.stderr.on("data", (d) => stderrChunks.push(d));
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(new Error(`${tool} exited ${code}: ${stderr.slice(0, 2000)}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// host.docker.internal only resolves FROM inside a docker container TO the host -- when running
// the docker-wrapped tool, rewrite a localhost/127.0.0.1 connection string to point there instead.
export function dockerizeConnectionString(connStr) {
  if (!viaDocker()) return connStr;
  return connStr.replace(/(127\.0\.0\.1|localhost)/, "host.docker.internal");
}
