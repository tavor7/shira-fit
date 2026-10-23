import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Supabase's Supavisor pooler terminates TLS with a certificate chain rooted at Supabase's own
// private CA ("Supabase Root 2021 CA") -- NOT a publicly trusted root, so it is never present in
// an OS's default trust store (confirmed directly: sslrootcert=system produced "SSL error:
// certificate verify failed" against the real pooler, and probing the pooler's actual cert chain
// pre-auth showed a self-signed Supabase root, not a public CA). This file is that root
// certificate, fetched directly from the real pooler and independently verified with `openssl
// s_client -starttls postgres -CAfile <this file> -verify_hostname <host>` (returned "Verify
// return code: 0 (ok)" for the full chain AND hostname). It is a PUBLIC certificate -- its only
// purpose is to be distributed so clients can verify the server, never a secret.
const SUPABASE_ROOT_CA_PATH = path.join(here, "..", "certs", "supabase-root-2021-ca.pem");

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
    // If the child exits early (e.g. ON_ERROR_STOP on a bad statement) while a large `input` is
    // still being flushed to its stdin, the write fails with EPIPE. Without this handler that's an
    // unhandled 'error' event on the stdin stream -- it crashes the whole process before the
    // `close` handler below gets a chance to report the real exit code/stderr, which is what
    // actually matters here. The close handler is always what decides success/failure.
    child.stdin.on("error", () => {});
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

// Forces full TLS certificate-chain + hostname verification on every REAL connection this tool
// makes (production backup's pg_dump/psql, restore.js, verify.js, check-connection.js) --
// unconditionally, overriding anything weaker the connection string itself specifies, so this can
// never be silently satisfied by "require" (encrypts but accepts any certificate) or "prefer"
// (may not encrypt at all). sslrootcert points at SUPABASE_ROOT_CA_PATH -- NOT "system" -- since
// Supabase's pooler uses its own private CA, absent from any OS's default trust store (see above).
//
// Skipped ONLY when PG_TOOLS_VIA_DOCKER=1 -- that flag exclusively targets a disposable local
// `postgres:17` Docker container with no TLS configured at all, used for local development/CI-
// free testing against synthetic data. It never touches Supabase, production, or real financial
// data, so forcing TLS there would make local testing impossible without buying any real
// security -- see dockerizeConnectionString below, which is the only other place a connection
// string is rewritten for that same local-only case.
export function withEnforcedTls(connStr) {
  if (viaDocker()) return connStr;
  const url = new URL(connStr);
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", SUPABASE_ROOT_CA_PATH);
  return url.toString();
}

// host.docker.internal only resolves FROM inside a docker container TO the host -- when running
// the docker-wrapped tool, rewrite a localhost/127.0.0.1 connection string to point there instead.
export function dockerizeConnectionString(connStr) {
  const enforced = withEnforcedTls(connStr);
  if (!viaDocker()) return enforced;
  return enforced.replace(/(127\.0\.0\.1|localhost)/, "host.docker.internal");
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

  // Runs a single-row, single-column query in the SAME session that exported the snapshot --
  // still inside that one REPEATABLE READ transaction, so the result is guaranteed consistent
  // with `snapshotId` (the exact same MVCC view pg_dump attaches to via --snapshot=), not a
  // separately-timed query that could race a concurrent write. Used to capture per-table row
  // counts at snapshot time (see dump.js) -- the source-of-truth a later verification compares
  // the restored row counts against, rather than against whatever the live database looks like
  // by the time someone gets around to checking.
  async query(sql) {
    this._write(sql);
    const line = await this._readLine();
    return line.trim();
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
