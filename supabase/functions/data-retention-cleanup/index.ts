/**
 * Supabase Edge Function: data-retention-cleanup
 *
 * POPIA-compliant data retention management.
 * Runs monthly (via cron or manual trigger) and handles:
 *
 * 1. WARNING PHASE (30 days before deletion):
 *    - Finds cancelled/completed subscriptions approaching 5 years old
 *    - Sends a warning email to the client explaining their data will be deleted
 *    - Marks the subscription as warned (retention_warning_sent = true)
 *
 * 2. DELETION PHASE (after 5 years):
 *    - Finds subscriptions that are 5+ years old AND have been warned
 *    - Deletes all associated payment records
 *    - Deletes the subscription record
 *    - Sends a final confirmation email that data has been deleted
 *
 * 3. CLEANUP:
 *    - Deletes expired verification codes older than 24 hours
 *
 * Deploy: supabase functions deploy data-retention-cleanup --no-verify-jwt
 * Schedule: Call monthly via cron.schedule or external scheduler
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const RETENTION_YEARS = 5;
const WARNING_DAYS_BEFORE = 30;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const resend = resendApiKey ? new Resend(resendApiKey) : null;

    const now = new Date();
    const results = {
      warnings_sent: 0,
      records_deleted: 0,
      verification_codes_cleaned: 0,
      errors: [] as string[],
    };

    // ═══════════════════════════════════════════
    // 1. WARNING PHASE
    // Find records where the last activity was ~4 years 11 months ago
    // (i.e., 30 days before the 5-year mark)
    // ═══════════════════════════════════════════

    const warningCutoff = new Date(now);
    warningCutoff.setFullYear(warningCutoff.getFullYear() - RETENTION_YEARS);
    warningCutoff.setDate(warningCutoff.getDate() + WARNING_DAYS_BEFORE);

    // Get cancelled/completed subscriptions that are approaching 5 years
    // and haven't been warned yet
    const { data: warningRecords, error: warningError } = await supabase
      .from("subscriptions")
      .select("*")
      .in("status", ["cancelled", "completed"])
      .eq("retention_warning_sent", false)
      .or(
        `cancelled_at.lte.${warningCutoff.toISOString()},last_payment_at.lte.${warningCutoff.toISOString()}`
      )
      .limit(50);

    if (warningError) {
      console.error("Warning query error:", warningError);
      results.errors.push("Warning query failed: " + warningError.message);
    }

    if (warningRecords && warningRecords.length > 0) {
      for (const sub of warningRecords) {
        // Calculate actual deletion date
        const lastActivity = sub.cancelled_at || sub.last_payment_at || sub.created_at;
        const deletionDate = new Date(lastActivity);
        deletionDate.setFullYear(deletionDate.getFullYear() + RETENTION_YEARS);

        const deletionDateStr = deletionDate.toLocaleDateString("en-ZA", {
          day: "numeric",
          month: "long",
          year: "numeric",
        });

        // Send warning email
        if (resend) {
          try {
            await resend.emails.send({
              from: "Dalu Digital <onboarding@resend.dev>",
              to: [sub.email],
              replyTo: "mabunda.katlego@gmail.com",
              subject: "Important: Your Dalu Digital Records Will Be Deleted Soon",
              html: `
                <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 24px;">
                  <div style="text-align: center; margin-bottom: 32px;">
                    <h1 style="color: #18132A; font-size: 22px; margin: 0;">Dalu Digital</h1>
                  </div>

                  <p style="color: #5A5470; font-size: 15px; line-height: 1.6;">
                    Hi ${sub.first_name},
                  </p>

                  <p style="color: #5A5470; font-size: 15px; line-height: 1.6;">
                    In line with the <strong style="color: #18132A;">Protection of Personal Information Act (POPIA)</strong>, we're writing to let you know that your records with Dalu Digital are scheduled for permanent deletion.
                  </p>

                  <div style="background: #FEF3C7; border: 1px solid #F59E0B; border-radius: 12px; padding: 20px; margin: 24px 0;">
                    <p style="color: #92400E; font-size: 14px; font-weight: 600; margin: 0 0 8px;">
                      Scheduled deletion date: ${deletionDateStr}
                    </p>
                    <p style="color: #92400E; font-size: 13px; line-height: 1.5; margin: 0;">
                      After this date, all your personal information, subscription details, and payment history will be permanently removed from our systems.
                    </p>
                  </div>

                  <div style="background: #FAF6F3; border: 1px solid #EBE5E0; border-radius: 12px; padding: 20px; margin: 24px 0;">
                    <p style="font-size: 13px; font-weight: 700; color: #18132A; margin: 0 0 8px;">What data we hold:</p>
                    <table style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td style="padding: 4px 0; font-size: 13px; color: #9B95A8;">Name</td>
                        <td style="padding: 4px 0; font-size: 13px; color: #18132A; text-align: right;">${sub.first_name} ${sub.last_name}</td>
                      </tr>
                      <tr>
                        <td style="padding: 4px 0; font-size: 13px; color: #9B95A8;">Email</td>
                        <td style="padding: 4px 0; font-size: 13px; color: #18132A; text-align: right;">${sub.email}</td>
                      </tr>
                      <tr>
                        <td style="padding: 4px 0; font-size: 13px; color: #9B95A8;">Plan</td>
                        <td style="padding: 4px 0; font-size: 13px; color: #18132A; text-align: right;">${sub.plan_name}</td>
                      </tr>
                      <tr>
                        <td style="padding: 4px 0; font-size: 13px; color: #9B95A8;">Status</td>
                        <td style="padding: 4px 0; font-size: 13px; color: #18132A; text-align: right;">${sub.status}</td>
                      </tr>
                      <tr>
                        <td style="padding: 4px 0; font-size: 13px; color: #9B95A8;">Payment records</td>
                        <td style="padding: 4px 0; font-size: 13px; color: #18132A; text-align: right;">${sub.payments_made || 0} payment(s)</td>
                      </tr>
                    </table>
                  </div>

                  <p style="color: #5A5470; font-size: 14px; line-height: 1.6;">
                    <strong style="color: #18132A;">Why are we deleting this?</strong><br>
                    Under POPIA (Section 14), we may not keep your personal information longer than necessary. South African tax law requires us to retain financial records for 5 years, after which we are required to delete them.
                  </p>

                  <p style="color: #5A5470; font-size: 14px; line-height: 1.6;">
                    If you'd like a copy of your records before they're deleted, or if you have any questions, simply reply to this email or WhatsApp us before <strong>${deletionDateStr}</strong>.
                  </p>

                  <hr style="border: none; border-top: 1px solid #EBE5E0; margin: 32px 0 16px;" />
                  <p style="color: #9B95A8; font-size: 12px; text-align: center;">
                    &copy; ${now.getFullYear()} Dalu Digital &middot; daludigital.co.za
                  </p>
                </div>
              `,
            });
            console.log("Retention warning sent to:", sub.email);
          } catch (emailErr) {
            console.error("Failed to send warning to", sub.email, emailErr);
            results.errors.push(`Warning email failed for ${sub.email}`);
            continue; // Don't mark as warned if email failed
          }
        }

        // Mark as warned
        await supabase
          .from("subscriptions")
          .update({
            retention_warning_sent: true,
            retention_warning_sent_at: now.toISOString(),
          })
          .eq("id", sub.id);

        results.warnings_sent++;
      }
    }

    // ═══════════════════════════════════════════
    // 2. DELETION PHASE
    // Find records where last activity was 5+ years ago
    // AND the warning has been sent
    // ═══════════════════════════════════════════

    const deletionCutoff = new Date(now);
    deletionCutoff.setFullYear(deletionCutoff.getFullYear() - RETENTION_YEARS);

    const { data: deleteRecords, error: deleteError } = await supabase
      .from("subscriptions")
      .select("*")
      .in("status", ["cancelled", "completed"])
      .eq("retention_warning_sent", true)
      .or(
        `cancelled_at.lte.${deletionCutoff.toISOString()},last_payment_at.lte.${deletionCutoff.toISOString()}`
      )
      .limit(50);

    if (deleteError) {
      console.error("Deletion query error:", deleteError);
      results.errors.push("Deletion query failed: " + deleteError.message);
    }

    if (deleteRecords && deleteRecords.length > 0) {
      for (const sub of deleteRecords) {
        // Delete associated payment records first
        const { error: payDeleteErr } = await supabase
          .from("payments")
          .delete()
          .eq("subscription_id", sub.id);

        if (payDeleteErr) {
          console.error("Failed to delete payments for", sub.id, payDeleteErr);
          results.errors.push(`Payment deletion failed for ${sub.email}`);
          continue;
        }

        // Delete the subscription record
        const { error: subDeleteErr } = await supabase
          .from("subscriptions")
          .delete()
          .eq("id", sub.id);

        if (subDeleteErr) {
          console.error("Failed to delete subscription", sub.id, subDeleteErr);
          results.errors.push(`Subscription deletion failed for ${sub.email}`);
          continue;
        }

        // Send deletion confirmation email
        if (resend) {
          try {
            await resend.emails.send({
              from: "Dalu Digital <onboarding@resend.dev>",
              to: [sub.email],
              replyTo: "mabunda.katlego@gmail.com",
              subject: "Your Dalu Digital Records Have Been Deleted",
              html: `
                <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 24px;">
                  <div style="text-align: center; margin-bottom: 32px;">
                    <h1 style="color: #18132A; font-size: 22px; margin: 0;">Dalu Digital</h1>
                  </div>

                  <p style="color: #5A5470; font-size: 15px; line-height: 1.6;">
                    Hi ${sub.first_name},
                  </p>

                  <p style="color: #5A5470; font-size: 15px; line-height: 1.6;">
                    As communicated in our previous email, your personal information and records have now been <strong style="color: #18132A;">permanently deleted</strong> from our systems in compliance with the Protection of Personal Information Act (POPIA).
                  </p>

                  <div style="background: #FAF6F3; border: 1px solid #EBE5E0; border-radius: 12px; padding: 20px; margin: 24px 0;">
                    <p style="font-size: 13px; font-weight: 700; color: #18132A; margin: 0 0 8px;">What was deleted:</p>
                    <ul style="color: #5A5470; font-size: 13px; line-height: 1.8; padding-left: 20px; margin: 0;">
                      <li>Your name and email address</li>
                      <li>Subscription and plan details</li>
                      <li>All payment history and invoices</li>
                      <li>Any service request descriptions</li>
                    </ul>
                  </div>

                  <p style="color: #5A5470; font-size: 14px; line-height: 1.6;">
                    This data cannot be recovered. If you ever need our services again in the future, you're always welcome — we'll simply set up a fresh account for you.
                  </p>

                  <p style="color: #5A5470; font-size: 14px; line-height: 1.6;">
                    Thank you for being a Dalu Digital client. We wish you all the best.
                  </p>

                  <hr style="border: none; border-top: 1px solid #EBE5E0; margin: 32px 0 16px;" />
                  <p style="color: #9B95A8; font-size: 12px; text-align: center;">
                    &copy; ${now.getFullYear()} Dalu Digital &middot; daludigital.co.za<br>
                    This is a one-time notification. You will not receive further emails from us.
                  </p>
                </div>
              `,
            });
            console.log("Deletion confirmation sent to:", sub.email);
          } catch (emailErr) {
            console.error("Failed to send deletion email to", sub.email, emailErr);
          }
        }

        // Notify owner
        if (resend) {
          try {
            await resend.emails.send({
              from: "Dalu Digital <onboarding@resend.dev>",
              to: ["mabunda.katlego@gmail.com"],
              subject: `POPIA: Records deleted — ${sub.first_name} ${sub.last_name}`,
              html: `
                <div style="font-family: 'Helvetica Neue', Arial, sans-serif; padding: 24px;">
                  <h2 style="color: #18132A; font-size: 16px;">POPIA Data Deletion Complete</h2>
                  <p style="color: #5A5470; font-size: 14px;">
                    Records for <strong>${sub.first_name} ${sub.last_name}</strong> (${sub.email}) have been permanently deleted after the 5-year retention period.
                  </p>
                  <p style="color: #5A5470; font-size: 13px;">
                    Plan: ${sub.plan_name} | Payments: ${sub.payments_made || 0} | Status: ${sub.status}
                  </p>
                </div>
              `,
            });
          } catch (e) {
            console.error("Owner notification failed:", e);
          }
        }

        results.records_deleted++;
      }
    }

    // ═══════════════════════════════════════════
    // 3. CLEANUP — Expired verification codes
    // ═══════════════════════════════════════════

    const cleanupCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { data: deletedCodes, error: cleanupError } = await supabase
      .from("verification_codes")
      .delete()
      .lt("expires_at", cleanupCutoff)
      .select("id");

    if (cleanupError) {
      console.error("Verification code cleanup error:", cleanupError);
      results.errors.push("Code cleanup failed: " + cleanupError.message);
    } else {
      results.verification_codes_cleaned = deletedCodes?.length || 0;
    }

    // ═══════════════════════════════════════════
    // Return summary
    // ═══════════════════════════════════════════

    console.log("Data retention cleanup complete:", results);

    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Retention cleanup error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
