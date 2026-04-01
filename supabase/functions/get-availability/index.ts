// Dalu Digital — Get Availability Edge Function
// GET /functions/v1/get-availability?month=2026-03

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function formatTime12(h: number, m: number): string {
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${hour12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const url = new URL(req.url);
    const monthParam = url.searchParams.get("month"); // "2026-03"

    if (!monthParam || !/^\d{4}-\d{2}$/.test(monthParam)) {
      return new Response(
        JSON.stringify({ error: "Invalid month parameter. Use format: YYYY-MM" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    // Fetch settings
    const { data: settings } = await supabase
      .from("booking_settings")
      .select("*")
      .eq("id", 1)
      .single();

    if (!settings) {
      return new Response(
        JSON.stringify({ error: "Settings not found" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Calculate month date range
    const [year, month] = monthParam.split("-").map(Number);
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    const startDate = `${monthParam}-01`;
    const endDate = `${monthParam}-${lastDay.getDate().toString().padStart(2, "0")}`;

    // Fetch confirmed bookings for this month (only date + time, no PII)
    const { data: bookings } = await supabase
      .from("bookings")
      .select("booking_date, start_time")
      .eq("status", "confirmed")
      .gte("booking_date", startDate)
      .lte("booking_date", endDate);

    // Fetch blocked dates for this month
    const { data: blockedDates } = await supabase
      .from("blocked_dates")
      .select("blocked_date")
      .gte("blocked_date", startDate)
      .lte("blocked_date", endDate);

    // Build booked slots set
    const bookedSet = new Set(
      (bookings || []).map((b: { booking_date: string; start_time: string }) => `${b.booking_date}_${b.start_time.substring(0, 5)}`)
    );
    const blockedSet = new Set(
      (blockedDates || []).map((b: { blocked_date: string }) => b.blocked_date)
    );

    // Calculate today + min/max advance window (in SAST)
    const nowUTC = new Date();
    const nowSAST = new Date(nowUTC.getTime() + 2 * 60 * 60 * 1000);
    const todaySAST = nowSAST.toISOString().split("T")[0];
    const minDate = new Date(nowSAST);
    minDate.setDate(minDate.getDate() + settings.advance_min_days);
    const minDateStr = minDate.toISOString().split("T")[0];
    const maxDate = new Date(nowSAST);
    maxDate.setDate(maxDate.getDate() + settings.advance_max_days);
    const maxDateStr = maxDate.toISOString().split("T")[0];

    // Generate availability for each day in the month
    const availability: Record<string, { dayOfWeek: string; available: boolean; blocked: boolean; slots: Array<{ time: string; display: string; available: boolean }> }> = {};

    for (let d = 1; d <= lastDay.getDate(); d++) {
      const date = new Date(year, month - 1, d);
      const dateStr = `${year}-${month.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
      const isoDay = date.getDay() === 0 ? 7 : date.getDay(); // Convert JS day (0=Sun) to ISO (7=Sun)
      const dayName = DAY_NAMES[isoDay];

      const isAvailableDay = settings.available_days.includes(isoDay);
      const isBlocked = blockedSet.has(dateStr);
      const isInWindow = dateStr >= minDateStr && dateStr <= maxDateStr;

      if (!isAvailableDay || isBlocked || !isInWindow) {
        availability[dateStr] = {
          dayOfWeek: dayName,
          available: false,
          blocked: isBlocked,
          slots: [],
        };
        continue;
      }

      // Generate time slots
      const slots: Array<{ time: string; display: string; available: boolean }> = [];
      for (let h = settings.start_hour; h < settings.end_hour; h++) {
        for (let m = 0; m < 60; m += settings.slot_duration_minutes) {
          const totalMin = h * 60 + m;
          const endMin = totalMin + settings.slot_duration_minutes;
          if (endMin > settings.end_hour * 60) break;

          const timeStr = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
          const key = `${dateStr}_${timeStr}`;
          const isBooked = bookedSet.has(key);

          slots.push({
            time: timeStr,
            display: formatTime12(h, m),
            available: !isBooked,
          });
        }
      }

      const hasAvailableSlots = slots.some((s) => s.available);
      availability[dateStr] = {
        dayOfWeek: dayName,
        available: hasAvailableSlots,
        blocked: false,
        slots,
      };
    }

    return new Response(
      JSON.stringify({
        timezone: settings.timezone,
        month: monthParam,
        availability,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      }
    );
  } catch (err) {
    console.error("Get availability error:", err);
    return new Response(
      JSON.stringify({ error: "Something went wrong." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
