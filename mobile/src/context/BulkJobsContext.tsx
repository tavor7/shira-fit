import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

/**
 * Tracks long-running bulk operations (e.g. regenerating every receipt PDF, bulk-creating
 * receipts) in state owned above the route Stack, so the job keeps running — and its progress
 * stays visible — even if the user navigates to another screen while it's in flight.
 *
 * Only one bulk job runs app-wide at a time; starting a second one while one is active is a no-op.
 */

type JobProgress = { key: string; done: number; total: number; cancelling: boolean } | null;

type RunTask = (setDone: (done: number) => void, isCancelled: () => boolean) => Promise<void>;

type Ctx = {
  job: JobProgress;
  runJob: (key: string, total: number, task: RunTask) => Promise<void>;
  cancelJob: (key: string) => void;
};

const BulkJobsContext = createContext<Ctx | null>(null);

export function BulkJobsProvider({ children }: { children: ReactNode }) {
  const [job, setJob] = useState<JobProgress>(null);
  const runningKeyRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  const runJob = useCallback(async (key: string, total: number, task: RunTask) => {
    if (runningKeyRef.current) return;
    runningKeyRef.current = key;
    cancelledRef.current = false;
    setJob({ key, done: 0, total, cancelling: false });
    try {
      await task(
        (done) => setJob((cur) => (cur && cur.key === key ? { ...cur, done } : cur)),
        () => cancelledRef.current
      );
    } finally {
      runningKeyRef.current = null;
      cancelledRef.current = false;
      setJob(null);
    }
  }, []);

  const cancelJob = useCallback((key: string) => {
    if (runningKeyRef.current !== key) return;
    cancelledRef.current = true;
    setJob((cur) => (cur && cur.key === key ? { ...cur, cancelling: true } : cur));
  }, []);

  return <BulkJobsContext.Provider value={{ job, runJob, cancelJob }}>{children}</BulkJobsContext.Provider>;
}

export function useBulkJobs() {
  const ctx = useContext(BulkJobsContext);
  if (!ctx) throw new Error("useBulkJobs must be used within BulkJobsProvider");
  return ctx;
}
