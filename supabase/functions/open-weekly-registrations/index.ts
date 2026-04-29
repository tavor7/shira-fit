/**
 * Run on a frequent schedule (e.g. every 15–60 minutes) via Supabase Cron.
 *
 * Rule:
 * - Next calendar week (Sun–Sat) sessions are CLOSED by default.
 * - At the configured opening day+time (default Thu 08:00 UTC), all next-week
 *   sessions that are NOT hidden are opened for registration.
 * - Sessions outside that next-week window are always closed.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function isoDateUTC(d: Date) {
  return d.toISOString().slice(0, 10);
}

function atUTC(y: number, m0: number, d: number, hh: number, mm: number) {
  return new Date(Date.UTC(y, m0, d, hh, mm, 0, 0));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const secret = Deno.env.get("CRON_SECRET");
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!secret)
    return new Response(JSON.stringify({ error: "missing_cron_secret" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  if (auth !== secret)
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(url, key);

  // Read schedule (UTC) from DB settings; defaults if row missing.
  const { data: sched } = await supabase
    .from("app_settings")
    .select("registration_open_weekday, registration_open_time")
    .eq("id", 1)
    .maybeSingle();

  const openWeekday = (sched?.registration_open_weekday ?? 4) as number; // Thu
  const openTime = (sched?.registration_open_time ?? "08:00:00") as string;
  const [hhStr, mmStr] = openTime.slice(0, 5).split(":");
  const openHH = parseInt(hhStr || "8", 10);
  const openMM = parseInt(mmStr || "0", 10);

  const now = new Date();
  // Compute nextSunday in UTC.
  const nowUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), 0, 0));
  const dow = nowUTC.getUTCDay();
  const daysToNextSunday = (7 - dow) % 7 || 7;
  const nextSunday = new Date(nowUTC);
  nextSunday.setUTCDate(nowUTC.getUTCDate() + daysToNextSunday);
  nextSunday.setUTCHours(0, 0, 0, 0);
  const endSaturday = new Date(nextSunday);
  endSaturday.setUTCDate(nextSunday.getUTCDate() + 6);
  endSaturday.setUTCHours(23, 59, 59, 999);

  // Opening moment is in the week BEFORE nextSunday.
  const prevSunday = new Date(nextSunday);
  prevSunday.setUTCDate(nextSunday.getUTCDate() - 7);
  const openDay = new Date(prevSunday);
  openDay.setUTCDate(prevSunday.getUTCDate() + openWeekday);
  const openAt = atUTC(openDay.getUTCFullYear(), openDay.getUTCMonth(), openDay.getUTCDate(), openHH, openMM);

  const startStr = isoDateUTC(nextSunday);
  const endStr = isoDateUTC(new Date(Date.UTC(nextSunday.getUTCFullYear(), nextSunday.getUTCMonth(), nextSunday.getUTCDate() + 6)));

  // Always close everything outside next-week window.
  await supabase
    .from("training_sessions")
    .update({ is_open_for_registration: false })
    .or(`session_date.lt.${startStr},session_date.gt.${endStr}`);

  // Always keep hidden sessions closed (even in next week).
  await supabase
    .from("training_sessions")
    .update({ is_open_for_registration: false })
    .gte("session_date", startStr)
    .lte("session_date", endStr)
    .eq("is_hidden", true);

  // Open next-week only if we're past opening time; never open hidden.
  const shouldOpen = nowUTC.getTime() >= openAt.getTime();
  const { error } = shouldOpen
    ? await supabase
        .from("training_sessions")
        .update({ is_open_for_registration: true })
        .gte("session_date", startStr)
        .lte("session_date", endStr)
        .eq("is_hidden", false)
    : await supabase
        .from("training_sessions")
        .update({ is_open_for_registration: false })
        .gte("session_date", startStr)
        .lte("session_date", endStr)
        .eq("is_hidden", false);

  if (error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  return new Response(
    JSON.stringify({
      ok: true,
      window: { start: startStr, end: endStr },
      schedule: { weekday: openWeekday, time: openTime.slice(0, 5) },
      openAt: openAt.toISOString(),
      shouldOpen,
    }),
    { headers: { ...cors, "Content-Type": "application/json" } }
  );
});
