// Dalu Digital — Book Session Edge Function
// POST /functions/v1/book-session

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Rate limiting map (in-memory, resets on function cold start)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 3600000 }); // 1 hour
    return true;
  }
  if (entry.count >= 3) return false;
  entry.count++;
  return true;
}

// Validate email format
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Sanitize input to prevent XSS in emails
function sanitize(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Format time for display (e.g. "10:00" -> "10:00 AM")
function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${hour12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

// Format date for display (e.g. "2026-03-20" -> "Friday, 20 March 2026")
function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00");
  return date.toLocaleDateString("en-ZA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Generate ICS calendar content
function generateICS(booking: {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  clientName: string;
  clientEmail: string;
}): string {
  const dtStart = booking.date.replace(/-/g, "") + "T" + booking.startTime.replace(/:/g, "") + "00";
  const dtEnd = booking.date.replace(/-/g, "") + "T" + booking.endTime.replace(/:/g, "") + "00";

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dalu Digital//Discovery Call//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${booking.id}@daludigital.co.za`,
    `DTSTART;TZID=Africa/Johannesburg:${dtStart}`,
    `DTEND;TZID=Africa/Johannesburg:${dtEnd}`,
    "SUMMARY:Discovery Call — Dalu Digital",
    "DESCRIPTION:Free 30-minute discovery call with Katlego Phokela from Dalu Digital.\\n\\nWe will discuss your business needs and how AI-powered digital solutions can help.\\n\\nJoin via Google Meet (link will be shared before the call).",
    "LOCATION:Google Meet",
    "ORGANIZER;CN=Katlego Phokela:mailto:mabunda.katlego@gmail.com",
    `ATTENDEE;CN=${booking.clientName};RSVP=TRUE:mailto:${booking.clientEmail}`,
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Discovery Call with Dalu Digital in 30 minutes",
    "END:VALARM",
    "BEGIN:VALARM",
    "TRIGGER:-PT10M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Discovery Call with Dalu Digital starts in 10 minutes",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

// Generate Google Calendar URL
function generateGoogleCalendarUrl(date: string, startTime: string, endTime: string, clientName: string): string {
  // Convert SAST (UTC+2) to UTC for Google Calendar
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const dateClean = date.replace(/-/g, "");
  const utcSH = (sh - 2 + 24) % 24;
  const utcEH = (eh - 2 + 24) % 24;
  const start = `${dateClean}T${utcSH.toString().padStart(2, "0")}${sm.toString().padStart(2, "0")}00Z`;
  const end = `${dateClean}T${utcEH.toString().padStart(2, "0")}${em.toString().padStart(2, "0")}00Z`;

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: "Discovery Call — Dalu Digital",
    dates: `${start}/${end}`,
    details: `Free 30-minute discovery call with Katlego Phokela.\n\nWe'll discuss your business needs and how AI-powered digital solutions can help.`,
    location: "Google Meet (link sent separately)",
    ctz: "Africa/Johannesburg",
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Client confirmation email HTML
function clientEmailHtml(data: {
  clientName: string;
  formattedDate: string;
  formattedTime: string;
  googleCalendarUrl: string;
  cancelUrl: string;
}): string {
  return `<!DOCTYPE html>
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
      <h1 style="font-size:24px;color:#18132A;margin:0 0 8px;font-weight:700;">You're booked!</h1>
      <p style="color:#5A5470;font-size:15px;line-height:1.7;margin:0 0 28px;">
        Hi ${sanitize(data.clientName)}, your free discovery call with Katlego is confirmed. Here are your details:
      </p>
      <div style="background:#FAF6F3;border-radius:12px;padding:24px;margin-bottom:28px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:8px 0;color:#9B95A8;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;width:100px;">Date</td>
            <td style="padding:8px 0;color:#18132A;font-size:15px;font-weight:600;">${data.formattedDate}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#9B95A8;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Time</td>
            <td style="padding:8px 0;color:#18132A;font-size:15px;font-weight:600;">${data.formattedTime} SAST</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#9B95A8;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Duration</td>
            <td style="padding:8px 0;color:#18132A;font-size:15px;font-weight:600;">30 minutes</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#9B95A8;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">With</td>
            <td style="padding:8px 0;color:#18132A;font-size:15px;font-weight:600;">Katlego Phokela</td>
          </tr>
        </table>
      </div>
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${data.googleCalendarUrl}" style="display:inline-block;padding:14px 32px;background:#7A1D3E;color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;border-radius:100px;">
          Add to Google Calendar
        </a>
      </div>
      <hr style="border:none;border-top:1px solid #EBE5E0;margin:0 0 20px;">
      <p style="color:#5A5470;font-size:14px;line-height:1.7;margin:0 0 16px;">
        <strong>What to expect:</strong> We'll chat about your business, what you need built, and I'll give you an honest assessment of whether we're a good fit — no pressure, no hard sell.
      </p>
      <p style="color:#5A5470;font-size:14px;line-height:1.7;margin:0 0 16px;">
        <strong>Need to reschedule?</strong><br>
        <a href="${data.cancelUrl}" style="color:#7A1D3E;text-decoration:underline;">Cancel or reschedule here</a>
      </p>
    </div>
    <div style="text-align:center;margin-top:28px;">
      <p style="color:#9B95A8;font-size:12px;margin:0;">
        Dalu Digital · Johannesburg, South Africa<br>
        <a href="https://daludigital.co.za" style="color:#7A1D3E;text-decoration:none;">daludigital.co.za</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

// Owner notification email HTML
function ownerEmailHtml(data: {
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  businessType: string;
  projectDescription: string;
  formattedDate: string;
  formattedTime: string;
  googleCalendarUrl: string;
  cancelUrl: string;
}): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAF6F3;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
    <div style="text-align:center;margin-bottom:32px;">
      <div style="display:inline-block;width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#7A1D3E,#C73E6B);text-align:center;line-height:40px;">
        <span style="color:#fff;font-size:18px;">&#9889;</span>
      </div>
      <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#18132A;">New Booking</p>
    </div>
    <div style="background:#FFFFFF;border-radius:16px;padding:36px 32px;border:1px solid #EBE5E0;">
      <h1 style="font-size:22px;color:#18132A;margin:0 0 8px;font-weight:700;">New Discovery Call Booked</h1>
      <p style="color:#5A5470;font-size:15px;line-height:1.7;margin:0 0 28px;">
        ${sanitize(data.clientName)} has booked a discovery call.
      </p>
      <div style="background:#FAF6F3;border-radius:12px;padding:24px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:8px 0;color:#9B95A8;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;width:110px;">Date</td>
            <td style="padding:8px 0;color:#18132A;font-size:15px;font-weight:600;">${data.formattedDate}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#9B95A8;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Time</td>
            <td style="padding:8px 0;color:#18132A;font-size:15px;font-weight:600;">${data.formattedTime} SAST</td>
          </tr>
        </table>
      </div>
      <div style="background:#FAF6F3;border-radius:12px;padding:24px;margin-bottom:28px;">
        <p style="color:#9B95A8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 14px;">Client Details</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:6px 0;color:#9B95A8;font-size:13px;font-weight:600;width:110px;">Name</td>
            <td style="padding:6px 0;color:#18132A;font-size:14px;">${sanitize(data.clientName)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#9B95A8;font-size:13px;font-weight:600;">Email</td>
            <td style="padding:6px 0;color:#18132A;font-size:14px;"><a href="mailto:${sanitize(data.clientEmail)}" style="color:#7A1D3E;">${sanitize(data.clientEmail)}</a></td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#9B95A8;font-size:13px;font-weight:600;">Phone</td>
            <td style="padding:6px 0;color:#18132A;font-size:14px;">${sanitize(data.clientPhone || "Not provided")}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#9B95A8;font-size:13px;font-weight:600;">Business</td>
            <td style="padding:6px 0;color:#18132A;font-size:14px;">${sanitize(data.businessType || "Not specified")}</td>
          </tr>
        </table>
        ${data.projectDescription ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid #EBE5E0;">
          <p style="color:#9B95A8;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 8px;">Project Description</p>
          <p style="color:#18132A;font-size:14px;line-height:1.65;margin:0;">${sanitize(data.projectDescription)}</p>
        </div>` : ""}
      </div>
      <div style="text-align:center;margin-bottom:16px;">
        <a href="${data.googleCalendarUrl}" style="display:inline-block;padding:14px 28px;background:#7A1D3E;color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;border-radius:100px;">
          Add to Calendar
        </a>
      </div>
      <div style="text-align:center;">
        <a href="mailto:${sanitize(data.clientEmail)}" style="color:#7A1D3E;font-size:13px;font-weight:600;text-decoration:underline;">Email Client</a>
        &nbsp;&nbsp;·&nbsp;&nbsp;
        <a href="${data.cancelUrl}" style="color:#EF4444;font-size:13px;font-weight:600;text-decoration:underline;">Cancel Booking</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
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
    // Rate limiting
    const clientIP = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown";
    if (!checkRateLimit(clientIP)) {
      return new Response(
        JSON.stringify({ success: false, error: "rate_limited", message: "Too many booking attempts. Please try again later." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const { date, startTime, clientName, clientEmail, clientPhone, businessType, projectDescription } = body;

    // Validate required fields
    if (!date || !startTime || !clientName || !clientEmail) {
      return new Response(
        JSON.stringify({ success: false, error: "validation", message: "Please fill in all required fields." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate email
    if (!isValidEmail(clientEmail)) {
      return new Response(
        JSON.stringify({ success: false, error: "validation", message: "Please enter a valid email address." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Calculate end time (30 min slot)
    const [h, m] = startTime.split(":").map(Number);
    const endMinutes = h * 60 + m + 30;
    const endTime = `${Math.floor(endMinutes / 60).toString().padStart(2, "0")}:${(endMinutes % 60).toString().padStart(2, "0")}`;

    // Create Supabase client with service role
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Call atomic booking function
    const { data: bookingId, error: bookingError } = await supabase.rpc("create_booking", {
      p_date: date,
      p_start_time: startTime,
      p_end_time: endTime,
      p_client_name: clientName,
      p_client_email: clientEmail,
      p_client_phone: clientPhone || null,
      p_business_type: businessType || null,
      p_project_description: projectDescription || null,
    });

    console.log("RPC result:", JSON.stringify({ bookingId, bookingError }));

    if (bookingError) {
      const isSlotTaken = bookingError.message.includes("already been booked") || bookingError.message.includes("duplicate");
      return new Response(
        JSON.stringify({
          success: false,
          error: isSlotTaken ? "slot_taken" : "booking_failed",
          message: isSlotTaken
            ? "Sorry, this slot was just booked. Please choose another time."
            : bookingError.message,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get the full booking record (including confirmation token)
    const { data: booking } = await supabase
      .from("bookings")
      .select("id, confirmation_token")
      .eq("id", bookingId)
      .single();

    const confirmationToken = booking?.confirmation_token || bookingId;
    const formattedDate = formatDate(date);
    const formattedTime = formatTime(startTime);
    const googleCalUrl = generateGoogleCalendarUrl(date, startTime, endTime, clientName);
    const cancelUrl = `https://daludigital.co.za/?cancel=${confirmationToken}`;

    // Generate ICS
    const icsContent = generateICS({
      id: bookingId,
      date,
      startTime,
      endTime,
      clientName,
      clientEmail,
    });

    console.log("Booking success, preparing emails. Token:", confirmationToken);

    // Send emails via Resend (if API key is configured)
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    console.log("Resend API key present:", !!resendApiKey);
    if (resendApiKey) {
      const resend = new Resend(resendApiKey);

      // Encode ICS to base64
      const icsBase64 = btoa(icsContent);

      // Client confirmation email
      try {
        await resend.emails.send({
          from: "Dalu Digital <onboarding@resend.dev>",
          to: [clientEmail],
          replyTo: "mabunda.katlego@gmail.com",
          subject: `Your Discovery Call is Confirmed — ${formattedDate} at ${formattedTime}`,
          html: clientEmailHtml({
            clientName,
            formattedDate,
            formattedTime,
            googleCalendarUrl: googleCalUrl,
            cancelUrl,
          }),
          attachments: [
            {
              filename: "discovery-call.ics",
              content: icsBase64,
              type: "text/calendar",
            },
          ],
        });
      } catch (emailErr) {
        console.error("Failed to send client email:", emailErr);
      }

      // Owner notification email
      try {
        await resend.emails.send({
          from: "Dalu Digital Bookings <onboarding@resend.dev>",
          to: ["mabunda.katlego@gmail.com"],
          subject: `New Discovery Call — ${clientName} on ${formattedDate} at ${formattedTime}`,
          html: ownerEmailHtml({
            clientName,
            clientEmail,
            clientPhone: clientPhone || "",
            businessType: businessType || "",
            projectDescription: projectDescription || "",
            formattedDate,
            formattedTime,
            googleCalendarUrl: googleCalUrl,
            cancelUrl,
          }),
          attachments: [
            {
              filename: "discovery-call.ics",
              content: icsBase64,
              type: "text/calendar",
            },
          ],
        });
      } catch (emailErr) {
        console.error("Failed to send owner email:", emailErr);
      }
    }

    // Return success
    return new Response(
      JSON.stringify({
        success: true,
        bookingId,
        confirmationToken,
        message: "Your discovery call is confirmed!",
        booking: {
          date: formattedDate,
          time: formattedTime,
          duration: "30 minutes",
          with: "Katlego Phokela",
        },
        googleCalendarUrl: googleCalUrl,
        icsContent,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Book session error:", JSON.stringify({ message: err?.message, stack: err?.stack, name: err?.name }));
    return new Response(
      JSON.stringify({ success: false, error: "server_error", message: "Something went wrong. Please try again.", debug: err?.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
