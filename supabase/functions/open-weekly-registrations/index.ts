/**
 * Run on a frequent schedule (e.g. every 15–60 minutes) via Supabase Cron.
 *
 * Rule (must match SQL `open_next_week_sessions_if_due`):
 * - Let "this week" = Sun–Sat in UTC, with week start = Sunday 00:00 UTC of the week containing today.
 * - Opening instant = this_week_start + registration_open_weekday + registration_open_time (UTC).
 * - When now UTC >= that instant, set is_open_for_registration = true for non-hidden sessions whose
 *   session_date is in the *following* Sun–Sat (i.e. this_week_start + 7 .. +13).
 *
 * Important: Do not mass-close sessions outside that window; that previously broke openings after
 * Sunday (wrong "next Sunday" window) and closed the week that had just become open.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function isoDateUTC(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** UTC calendar day at 00:00. */
function utcDayStartFromNow(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/** Sunday 00:00 UTC of the week that contains `utcDay` (utcDay must be midnight UTC). */
function weekStartSundayContaining(utcDay: Date): Date {
  const dow = utcDay.getUTCDay(); // 0 = Sunday
  const s = new Date(utcDay);
  s.setUTCDate(s.getUTCDate() - dow);
  return s;
}

function addUtcDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function atUtcOpenTime(d: Date, hh: number, mm: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, 0, 0));
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

  const { data: sched } = await supabase
    .from("app_settings")
    .select("registration_open_weekday, registration_open_time")
    .eq("id", 1)
    .maybeSingle();

  const openWeekday = Math.min(6, Math.max(0, (sched?.registration_open_weekday ?? 4) as number));
  const openTime = (sched?.registration_open_time ?? "08:00:00") as string;
  const [hhStr, mmStr] = openTime.slice(0, 5).split(":");
  const openHH = parseInt(hhStr || "8", 10);
  const openMM = parseInt(mmStr || "0", 10);

  const todayUtc = utcDayStartFromNow();
  const thisWeekStart = weekStartSundayContaining(todayUtc);
  const openDay = addUtcDays(thisWeekStart, openWeekday);
  const openAt = atUtcOpenTime(openDay, openHH, openMM);

  const nowUtc = new Date();

  if (nowUtc.getTime() < openAt.getTime()) {
    return new Response(
      JSON.stringify({
        ok: true,
        due: false,
        opened: 0,
        openAt: openAt.toISOString(),
        schedule: { weekday: openWeekday, time: openTime.slice(0, 5) },
      }),
      { headers: { ...cors, "Content-Type": "application/json" } },
    );
  }

  const targetStart = addUtcDays(thisWeekStart, 7);
  const targetEnd = addUtcDays(targetStart, 6);
  const startStr = isoDateUTC(targetStart);
  const endStr = isoDateUTC(targetEnd);

  const { data: updated, error } = await supabase
    .from("training_sessions")
    .update({ is_open_for_registration: true })
    .gte("session_date", startStr)
    .lte("session_date", endStr)
    .eq("is_open_for_registration", false)
    .or("is_hidden.is.null,is_hidden.eq.false")
    .select("id");

  if (error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  const opened = updated?.length ?? 0;

  return new Response(
    JSON.stringify({
      ok: true,
      due: true,
      opened,
      week: { start: startStr, end: endStr },
      schedule: { weekday: openWeekday, time: openTime.slice(0, 5) },
      openAt: openAt.toISOString(),
    }),
    { headers: { ...cors, "Content-Type": "application/json" } },
  );
});
