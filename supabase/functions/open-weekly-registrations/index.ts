/**
 * Run every Thursday 08:00 (Supabase Dashboard → Edge Functions → Cron).
 * Opens registration only for sessions whose session_date falls in the
 * next calendar week (Sun–Sat), per spec example.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const secret = Deno.env.get("CRON_SECRET");
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (secret && auth !== secret)
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(url, key);

  const now = new Date();
  const dow = now.getDay();
  const daysToNextSunday = (7 - dow) % 7 || 7;
  const nextSunday = new Date(now);
  nextSunday.setDate(now.getDate() + daysToNextSunday);
  nextSunday.setHours(0, 0, 0, 0);
  const endSaturday = new Date(nextSunday);
  endSaturday.setDate(nextSunday.getDate() + 6);

  const startStr = nextSunday.toISOString().slice(0, 10);
  const endStr = endSaturday.toISOString().slice(0, 10);

  await supabase
    .from("training_sessions")
    .update({ is_open_for_registration: false })
    .or(`session_date.lt.${startStr},session_date.gt.${endStr}`);

  const { error } = await supabase
    .from("training_sessions")
    .update({ is_open_for_registration: true })
    .gte("session_date", startStr)
    .lte("session_date", endStr);

  if (error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  return new Response(
    JSON.stringify({ ok: true, window: { start: startStr, end: endStr } }),
    { headers: { ...cors, "Content-Type": "application/json" } }
  );
});
