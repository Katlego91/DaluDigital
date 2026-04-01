/**
 * Supabase Edge Function: payfast-notify
 *
 * Receives PayFast ITN (Instant Transaction Notification) webhooks.
 * - Creates/updates subscription records
 * - Logs each payment
 * - Generates invoice numbers
 *
 * Deploy: supabase functions deploy payfast-notify --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAYFAST_PASSPHRASE = Deno.env.get("PAYFAST_PASSPHRASE") || "";

// PayFast sandbox and live IPs for validation
const PAYFAST_HOSTS = [
  "www.payfast.co.za",
  "sandbox.payfast.co.za",
  "w1w.payfast.co.za",
  "w2w.payfast.co.za",
];

function pfEncode(val: string): string {
  return encodeURIComponent(val).replace(/%20/g, "+");
}

async function md5(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("MD5", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    // Parse form data from PayFast
    const formData = await req.formData();
    const data: Record<string, string> = {};
    formData.forEach((value, key) => {
      data[key] = value.toString();
    });

    console.log("PayFast ITN received:", JSON.stringify(data));

    // ── Verify signature ──
    const receivedSignature = data.signature;
    const paramString = Object.entries(data)
      .filter(([key]) => key !== "signature")
      .map(([key, val]) => `${key}=${pfEncode(val.trim())}`)
      .join("&");

    const signatureString = PAYFAST_PASSPHRASE
      ? `${paramString}&passphrase=${pfEncode(PAYFAST_PASSPHRASE.trim())}`
      : paramString;

    const expectedSignature = await md5(signatureString);

    if (receivedSignature !== expectedSignature) {
      console.error("Signature mismatch:", { received: receivedSignature, expected: expectedSignature });
      return new Response("Invalid signature", { status: 403 });
    }

    // ── Process the notification ──
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const paymentStatus = data.payment_status; // COMPLETE, FAILED, PENDING
    const mPaymentId = data.m_payment_id;
    const pfPaymentId = data.pf_payment_id;
    const amountGross = Math.round(parseFloat(data.amount_gross || "0"));
    const token = data.token || null; // Subscription token (for recurring)

    if (paymentStatus !== "COMPLETE") {
      console.log("Payment not complete, status:", paymentStatus);
      return new Response("OK", { status: 200 });
    }

    // Find or create subscription by our payment ID
    let { data: sub } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("payfast_payment_id", mPaymentId)
      .single();

    if (!sub) {
      // First payment — create subscription record
      // Parse plan info from payment ID format: DALU-PLAN-NAME-TIMESTAMP
      const now = new Date();

      // Try to find by partial match (the payment ID prefix matches)
      const prefix = mPaymentId.split("-").slice(0, -1).join("-");
      const { data: existingSub } = await supabase
        .from("subscriptions")
        .select("*")
        .like("payfast_payment_id", `${prefix}%`)
        .eq("status", "pending")
        .single();

      if (existingSub) {
        sub = existingSub;
      } else {
        // Create a basic record from ITN data
        const { data: newSub, error } = await supabase
          .from("subscriptions")
          .insert({
            email: data.email_address || "",
            first_name: data.name_first || "",
            last_name: data.name_last || "",
            plan_name: data.item_name || "Unknown",
            payment_type: token ? "subscription" : "onceoff",
            amount: amountGross,
            payfast_payment_id: mPaymentId,
            payfast_token: token,
            status: "active",
            start_date: now.toISOString().split("T")[0],
          })
          .select()
          .single();

        if (error) {
          console.error("Error creating subscription:", error);
          return new Response("DB error", { status: 500 });
        }
        sub = newSub;
      }
    }

    // Update subscription status
    const updateData: Record<string, any> = {
      status: "active",
      last_payment_at: new Date().toISOString(),
      payments_made: (sub.payments_made || 0) + 1,
    };

    if (token) {
      updateData.payfast_token = token;
    }

    if (!sub.start_date) {
      updateData.start_date = new Date().toISOString().split("T")[0];
    }

    // Calculate end date for fixed-term subscriptions
    if (sub.total_months > 0 && sub.payment_type === "subscription") {
      const startDate = new Date(sub.start_date || new Date());
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + sub.total_months);
      updateData.end_date = endDate.toISOString().split("T")[0];

      // Calculate next payment
      const nextPayment = new Date();
      nextPayment.setMonth(nextPayment.getMonth() + 1);
      updateData.next_payment_at = nextPayment.toISOString();

      // Check if subscription should complete
      if (updateData.payments_made >= sub.total_months) {
        updateData.status = "completed";
        updateData.next_payment_at = null;
      }
    } else if (sub.payment_type === "subscription") {
      // Ongoing subscription
      const nextPayment = new Date();
      nextPayment.setMonth(nextPayment.getMonth() + 1);
      updateData.next_payment_at = nextPayment.toISOString();
    }

    await supabase
      .from("subscriptions")
      .update(updateData)
      .eq("id", sub.id);

    // ── Log payment ──
    const year = new Date().getFullYear();
    const { data: seqResult } = await supabase.rpc("nextval", {
      seq_name: "invoice_number_seq",
    });
    const invoiceNum = `DALU-INV-${year}-${String(seqResult || Date.now()).padStart(4, "0")}`;

    await supabase.from("payments").insert({
      subscription_id: sub.id,
      pf_payment_id: pfPaymentId,
      m_payment_id: mPaymentId,
      amount: amountGross,
      status: "complete",
      invoice_number: invoiceNum,
    });

    console.log("Payment logged:", invoiceNum, "for subscription:", sub.id);

    // TODO: Send invoice email here (integrate with Resend, SendGrid, etc.)
    // For now, invoices are logged in the database and can be viewed on the subscribe page.

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("ITN Error:", err);
    return new Response("Server error", { status: 500 });
  }
});
