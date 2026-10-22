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

// Never let a connection-string password end up in a thrown error or log line.
export function redactConnectionString(str) {
  return str.replace(/postgresql:\/\/([^:]+):([^@]+)@/g, "postgresql://$1:***@");
}

const SNAPSHOT_MARKER = "===SNAPSHOT===";

/**
 * Holds one long-lived `psql` session open across the whole backup run, inside a single
 * REPEATABLE READ transaction, and exports its snapshot so separate pg_dump processes can each
 * attach to the exact same MVCC view via --snapshot=<id>. This is what makes the schema dump and
 * the data dump (two separate pg_dump invocations) actually consistent with each other, rather
 * than each silently seeing whatever the database looks like at the moment it happens to run.
 */
export class PgSnapshotSession {
  constructor(connStr) {
    this.connStr = dockerizeConnectionString(connStr);
    this.snapshotId = null;
    this.child = null;
    this._buf = "";
    this._waiters = [];
  }

  async open() {
    const tool = "psql";
    const baseArgs = [this.connStr, "-Atq"];
    const { cmd, args } = viaDocker()
      ? { cmd: "docker", args: ["run", "--rm", "-i", "--add-host=host.docker.internal:host-gateway", "postgres:17", tool, ...baseArgs] }
      : { cmd: tool, args: baseArgs };

    this.child = spawn(cmd, args);
    this.child.stdout.on("data", (d) => this._onData(d));
    this.child.stderr.on("data", () => {}); // psql notices; ignored unless a command fails outright.
    this._exited = new Promise((resolve) => this.child.on("close", resolve));

    this._write("BEGIN ISOLATION LEVEL REPEATABLE READ;");
    this._write(`SELECT '${SNAPSHOT_MARKER}' || pg_export_snapshot();`);
    const line = await this._readLine();
    this.snapshotId = line.replace(SNAPSHOT_MARKER, "").trim();
    if (!this.snapshotId) throw new Error("Failed to export a Postgres snapshot for the backup run");
    return this.snapshotId;
  }

  _write(sql) {
    this.child.stdin.write(sql + "\n");
  }

  _onData(chunk) {
    this._buf += chunk.toString("utf8");
    let idx;
    while ((idx = this._buf.indexOf("\n")) !== -1) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      const waiter = this._waiters.shift();
      if (waiter) waiter(line);
    }
  }

  _readLine() {
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  async close() {
    this._write("COMMIT;");
    this._write("\\q");
    this.child.stdin.end();
    await this._exited;
  }
}
