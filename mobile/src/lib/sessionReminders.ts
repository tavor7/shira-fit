import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { loadNotificationPrefs } from "./notificationPrefs";

const STORE_PREFIX = "session_reminder_ids:";

function sessionStartDate(sessionDate: string, startTime: string): Date {
  const t = startTime.length >= 5 ? startTime.slice(0, 5) : startTime;
  return new Date(`${sessionDate}T${t}:00`);
}

async function storeIds(sessionId: string, ids: string[]) {
  await SecureStore.setItemAsync(`${STORE_PREFIX}${sessionId}`, JSON.stringify(ids));
}

async function readIds(sessionId: string): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(`${STORE_PREFIX}${sessionId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function ensureNotificationPermission(): Promise<boolean> {
  const settings = await Notifications.getPermissionsAsync();
  if (settings.granted || settings.status === Notifications.PermissionStatus.GRANTED) return true;
  const req = await Notifications.requestPermissionsAsync();
  return req.granted || req.status === Notifications.PermissionStatus.GRANTED;
}

/** Schedule ~24h and ~12h before session start (local), if still in the future. */
export async function scheduleSessionReminders(opts: {
  sessionId: string;
  sessionDate: string;
  startTime: string;
  title: string;
  bodyNear: string;
}): Promise<void> {
  const prefs = await loadNotificationPrefs();
  if (!prefs.sessionReminders) return;
  const ok = await ensureNotificationPermission();
  if (!ok) return;

  await cancelSessionReminders(opts.sessionId);

  const start = sessionStartDate(opts.sessionDate, opts.startTime);
  const t24 = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const t12 = new Date(start.getTime() - 12 * 60 * 60 * 1000);
  const now = Date.now();
  const ids: string[] = [];

  if (t24.getTime() > now) {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: opts.title,
        body: opts.bodyNear,
        data: { session_id: opts.sessionId, kind: "reminder_24h" },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: t24 },
    });
    ids.push(id);
  }
  if (t12.getTime() > now) {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: opts.title,
        body: opts.bodyNear,
        data: { session_id: opts.sessionId, kind: "reminder_12h" },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: t12 },
    });
    ids.push(id);
  }

  if (ids.length) await storeIds(opts.sessionId, ids);
}

export async function cancelSessionReminders(sessionId: string): Promise<void> {
  const prev = await readIds(sessionId);
  for (const id of prev) {
    try {
      await Notifications.cancelScheduledNotificationAsync(id);
    } catch {
      /* ignore */
    }
  }
  await SecureStore.deleteItemAsync(`${STORE_PREFIX}${sessionId}`).catch(() => undefined);
}
