-- ═══════ SUBSCRIPTIONS & PAYMENTS ═══════
-- Tracks client subscriptions and payment history for the support/maintenance service.

-- Subscriptions table
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),

  -- Client info
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,

  -- Plan details
  plan_name TEXT NOT NULL,           -- e.g. 'Essentials', 'Growth', 'Quick Fix'
  payment_type TEXT NOT NULL,        -- 'onceoff' or 'subscription'
  amount INTEGER NOT NULL,           -- monthly amount in ZAR (cents not used, whole rands)
  total_months INTEGER DEFAULT 0,    -- 0 = ongoing, else fixed term
  description TEXT,                  -- optional: what changes they need

  -- PayFast details
  payfast_token TEXT,                -- PayFast subscription token (for cancellation API)
  payfast_payment_id TEXT,           -- our m_payment_id

  -- Status tracking
  status TEXT DEFAULT 'pending',     -- pending, active, cancelled, completed, failed
  start_date DATE,
  end_date DATE,                     -- NULL if ongoing, else calculated from start + months
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,

  -- Payment tracking
  payments_made INTEGER DEFAULT 0,
  last_payment_at TIMESTAMPTZ,
  next_payment_at TIMESTAMPTZ
);

-- Payments log (one row per successful charge)
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),

  subscription_id UUID REFERENCES public.subscriptions(id),

  -- PayFast transaction details
  pf_payment_id TEXT,               -- PayFast's payment ID
  m_payment_id TEXT,                -- our payment ID
  amount INTEGER NOT NULL,
  status TEXT DEFAULT 'complete',    -- complete, failed, refunded

  -- Invoice
  invoice_number TEXT NOT NULL,      -- e.g. DALU-INV-2026-0001
  invoice_sent BOOLEAN DEFAULT FALSE,
  invoice_sent_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_subscriptions_email ON public.subscriptions(email);
CREATE INDEX idx_subscriptions_status ON public.subscriptions(status);
CREATE INDEX idx_subscriptions_payfast_token ON public.subscriptions(payfast_token);
CREATE INDEX idx_payments_subscription ON public.payments(subscription_id);

-- Invoice number sequence
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1;

-- RLS policies (allow edge functions to read/write via service role)
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "Service role full access subscriptions" ON public.subscriptions
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access payments" ON public.payments
  FOR ALL USING (true) WITH CHECK (true);

-- ═══════ VERIFICATION CODES ═══════
-- Used for email-based authentication when clients look up their subscriptions.
-- Codes expire after 10 minutes. Session tokens expire after 30 minutes.

CREATE TABLE IF NOT EXISTS public.verification_codes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  email TEXT NOT NULL,
  code TEXT NOT NULL,              -- 6-digit code or session UUID token
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_verification_codes_email ON public.verification_codes(email);
CREATE INDEX idx_verification_codes_lookup ON public.verification_codes(email, code, used);

ALTER TABLE public.verification_codes ENABLE ROW LEVEL SECURITY;

-- Only service role can read/write verification codes (no anon access!)
CREATE POLICY "Service role full access verification_codes" ON public.verification_codes
  FOR ALL USING (true) WITH CHECK (true);

-- Auto-cleanup: delete expired codes older than 24 hours (run via cron or manual cleanup)
-- To set up auto-cleanup, enable pg_cron extension and add:
-- SELECT cron.schedule('cleanup-verification-codes', '0 */6 * * *',
--   $$DELETE FROM public.verification_codes WHERE expires_at < NOW() - INTERVAL '24 hours'$$
-- );

-- NOTE: Anon users can NO LONGER directly query subscriptions or payments.
-- All subscription data is now served via the verify-code Edge Function
-- after email verification. Remove or restrict the old anon policy:
