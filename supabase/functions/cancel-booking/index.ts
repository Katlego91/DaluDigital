// Dalu Digital — Cancel Booking Edge Function
// POST /functions/v1/cancel-booking

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function sanitize(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${hour12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00");
  return date.toLocaleDateString("en-ZA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { confirmationToken, reason } = body;

    if (!confirmationToken) {
      return new Response(
        JSON.stringify({ success: false, error: "validation", message: "Confirmation token is required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Look up booking by confirmation token
    const { data: booking, error: fetchError } = await supabase
      .from("bookings")
      .select("*")
      .eq("confirmation_token", confirmationToken)
      .single();

    if (fetchError || !booking) {
      return new Response(
        JSON.stringify({ success: false, error: "not_found", message: "Booking not found." }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check booking is confirmed and in the future
    if (booking.status !== "confirmed") {
      return new Response(
        JSON.stringify({ success: false, error: "already_cancelled", message: "This booking has already been cancelled." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const bookingDateTime = new Date(`${booking.booking_date}T${booking.start_time}+02:00`);
    if (bookingDateTime <= new Date()) {
      return new Response(
        JSON.stringify({ success: false, error: "past_booking", message: "Cannot cancel a past booking." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cancel the booking
    const { error: updateError } = await supabase
      .from("bookings")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancel_reason: reason || null,
      })
      .eq("id", booking.id);

    if (updateError) {
      return new Response(
        JSON.stringify({ success: false, error: "update_failed", message: "Failed to cancel booking." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const formattedDate = formatDate(booking.booking_date);
    const formattedTime = formatTime(booking.start_time);

    // Send cancellation emails via Resend
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (resendApiKey) {
      const resend = new Resend(resendApiKey);

      // Client cancellation email
      try {
        await resend.emails.send({
          from: "Dalu Digital <bookings@daludigital.co.za>",
          to: [booking.client_email],
          replyTo: "katlego@daludigital.co.za",
          subject: `Your Discovery Call Has Been Cancelled — ${formattedDate}`,
          html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAF6F3;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="text-align:center;margin-bottom:32px;">
      <div style="display:inline-block;width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#7A1D3E,#C73E6B);text-align:center;line-height:40px;">
        <span style="color:#fff;font-size:18px;">&#9889;</span>
      </div>
      <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#18132A;">Dalu Digital</p>
    </div>
    <div style="background:#FFFFFF;border-radius:16px;padding:36px 32px;border:1px solid #EBE5E0;">
      <h1 style="font-size:22px;color:#18132A;margin:0 0 8px;font-weight:700;">Booking Cancelled</h1>
      <p style="color:#5A5470;font-size:15px;line-height:1.7;margin:0 0 20px;">
        Hi ${sanitize(booking.client_name)}, your discovery call on <strong>${formattedDate}</strong> at <strong>${formattedTime} SAST</strong> has been cancelled.
      </p>
      <p style="color:#5A5470;font-size:14px;line-height:1.7;margin:0 0 24px;">
        Want to rebook? You can schedule a new time at any point:
      </p>
      <div style="text-align:center;">
        <a href="https://daludigital.co.za/#booking" style="display:inline-block;padding:14px 32px;background:#7A1D3E;color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;border-radius:100px;">
          Book a New Time
        </a>
      </div>
    </div>
    <div style="text-align:center;margin-top:28px;">
      <p style="color:#9B95A8;font-size:12px;margin:0;">Dalu Digital · Johannesburg, South Africa</p>
    </div>
  </div>
</body>
</html>`,
        });
      } catch (e) {
        console.error("Failed to send client cancellation email:", e);
      }

      // Owner notification
      try {
        await resend.emails.send({
          from: "Dalu Digital Bookings <bookings@daludigital.co.za>",
          to: ["katlego@daludigital.co.za"],
          subject: `Booking Cancelled — ${booking.client_name} on ${formattedDate}`,
          html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAF6F3;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="background:#FFFFFF;border-radius:16px;padding:36px 32px;border:1px solid #EBE5E0;">
      <h1 style="font-size:22px;color:#18132A;margin:0 0 16px;font-weight:700;">Booking Cancelled</h1>
      <p style="color:#5A5470;font-size:15px;line-height:1.7;margin:0 0 16px;">
        <strong>${sanitize(booking.client_name)}</strong> cancelled their discovery call.
      </p>
      <div style="background:#FAF6F3;border-radius:12px;padding:20px;margin-bottom:16px;">
        <p style="margin:0;color:#18132A;font-size:14px;"><strong>Was:</strong> ${formattedDate} at ${formattedTime} SAST</p>
        ${reason ? `<p style="margin:8px 0 0;color:#5A5470;font-size:14px;"><strong>Reason:</strong> ${sanitize(reason)}</p>` : ""}
      </div>
      <p style="color:#9B95A8;font-size:13px;margin:0;">The slot is now available again.</p>
    </div>
  </div>
</body>
</html>`,
        });
      } catch (e) {
        console.error("Failed to send owner cancellation email:", e);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Your booking has been cancelled. The slot is now available again.",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Cancel booking error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "server_error", message: "Something went wrong." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
