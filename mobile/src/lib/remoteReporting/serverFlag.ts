/**
 * Server-controlled activation gate for remote technical reporting (monitoring completion pass).
 *
 * Replaces the old design where the ONLY control was the hardcoded REMOTE_TECHNICAL_REPORTING_ENABLED
 * build-time constant (turning reporting on/off in production required a new app build). The release-
 * ready build now ships the full reporting capability wired up; the sole authoritative switch is the
 * server's system_monitoring_config.client_ingest_enabled, read through the system_client_reporting_enabled()
 * RPC (mobile/.../supabase/migrations/20261020150000_system_client_reporting_flag.sql).
 *
 * Contract:
 *   - Disabled by default: the cache starts at false and nothing is ever reported before a successful read.
 *   - Fails closed: a read that errors, times out, or has never succeeded leaves (or sets) the cache to
 *     false. A transient network blip during a refresh does not keep a previously-true value alive -
 *     this trades a few missed reports during that blip for never silently reporting on stale authority.
 *   - No unnecessary requests: callers check isEnabled() (a plain in-memory read) before doing any work;
 *     the RPC itself is only ever called by refresh(), not on every reporting attempt.
 *   - Refreshable without a redeploy: call refresh() on app start/foreground and on an interval while the
 *     app is active (wireRefreshTriggers below does both). A production flip of client_ingest_enabled
 *     takes effect for already-running app instances within one refresh cycle.
 */

export type ReportingFlagRpcClient = {
  rpc: (fn: string, args?: undefined) => PromiseLike<{ data?: unknown; error?: unknown }>;
};

export interface ServerReportingFlagOptions {
  timeoutMs?: number;
  refreshIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const RPC_NAME = "system_client_reporting_enabled";

export class ServerReportingFlag {
  private readonly client: ReportingFlagRpcClient;
  private readonly timeoutMs: number;
  private readonly refreshIntervalMs: number;
  private enabled = false;
  private refreshing: Promise<void> | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(client: ReportingFlagRpcClient, opts: ServerReportingFlagOptions = {}) {
    this.client = client;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  }

  /** Cheap, synchronous, in-memory read. Never performs I/O. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Reads the server flag once. Never throws. On any failure (network error, timeout, malformed
   * response), fails closed: sets the cache to false rather than leaving a stale true in place.
   * Concurrent calls share one in-flight request.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    try {
      const result = await this.withTimeout(this.client.rpc(RPC_NAME), this.timeoutMs);
      if (result.error) {
        this.enabled = false;
        return;
      }
      this.enabled = result.data === true;
    } catch {
      this.enabled = false;
    }
  }

  private withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), ms);
      Promise.resolve(p).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  /** Starts the periodic background refresh. Call once per app session. Idempotent. */
  startPeriodicRefresh(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      this.refresh().catch(() => undefined);
    }, this.refreshIntervalMs);
  }

  stopPeriodicRefresh(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}

let appWideFlag: ServerReportingFlag | null = null;

/** Lazily creates (once) and returns the app-wide flag instance bound to the given Supabase client. */
export function getServerReportingFlag(client: ReportingFlagRpcClient): ServerReportingFlag {
  if (!appWideFlag) {
    appWideFlag = new ServerReportingFlag(client);
  }
  return appWideFlag;
}

/** Test-only: forget the app-wide singleton so tests can construct a fresh one. */
export function resetServerReportingFlagForTests(): void {
  appWideFlag?.stopPeriodicRefresh();
  appWideFlag = null;
}
