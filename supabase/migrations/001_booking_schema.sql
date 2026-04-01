-- ═══════════════════════════════════════════════════════════
-- Dalu Digital — Discovery Session Booking System
-- Migration 001: Core Schema
-- ═══════════════════════════════════════════════════════════

-- Table: bookings
CREATE TABLE bookings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,

  -- Booking details
  booking_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  timezone TEXT DEFAULT 'Africa/Johannesburg' NOT NULL,

  -- Client info
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_phone TEXT,
  business_type TEXT,
  project_description TEXT,

  -- Status
  status TEXT DEFAULT 'confirmed' NOT NULL CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),

  -- Metadata
  confirmation_token UUID DEFAULT gen_random_uuid() NOT NULL,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,

  -- Prevent double-booking
  UNIQUE(booking_date, start_time, status)
);

-- Indexes
CREATE INDEX idx_bookings_date_status ON bookings(booking_date, status) WHERE status = 'confirmed';
CREATE INDEX idx_bookings_token ON bookings(confirmation_token);

-- Table: blocked_dates
CREATE TABLE blocked_dates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  blocked_date DATE NOT NULL UNIQUE,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: booking_settings (singleton)
CREATE TABLE booking_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  available_days INTEGER[] DEFAULT '{1,2,4,5,6}' NOT NULL, -- 1=Mon, 6=Sat (ISO)
  start_hour INTEGER DEFAULT 10 NOT NULL,
  end_hour INTEGER DEFAULT 15 NOT NULL,
  slot_duration_minutes INTEGER DEFAULT 30 NOT NULL,
  advance_min_days INTEGER DEFAULT 1 NOT NULL,
  advance_max_days INTEGER DEFAULT 30 NOT NULL,
  session_name TEXT DEFAULT 'Free Discovery Call' NOT NULL,
  owner_email TEXT DEFAULT 'katlego@daludigital.co.za' NOT NULL,
  owner_name TEXT DEFAULT 'Katlego Phokela' NOT NULL,
  timezone TEXT DEFAULT 'Africa/Johannesburg' NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Insert default settings
INSERT INTO booking_settings DEFAULT VALUES;

-- ═══════════════════════════════════════════════════════════
-- Row Level Security
-- ═══════════════════════════════════════════════════════════

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_settings ENABLE ROW LEVEL SECURITY;

-- Public can INSERT bookings
CREATE POLICY "Anyone can create bookings"
  ON bookings FOR INSERT
  WITH CHECK (true);

-- Public can SELECT confirmed bookings (for availability — no PII exposed via frontend)
CREATE POLICY "Anyone can check availability"
  ON bookings FOR SELECT
  USING (status = 'confirmed');

-- Public can read blocked dates
CREATE POLICY "Anyone can read blocked dates"
  ON blocked_dates FOR SELECT
  USING (true);

-- Public can read settings
CREATE POLICY "Anyone can read settings"
  ON booking_settings FOR SELECT
  USING (true);

-- ═══════════════════════════════════════════════════════════
-- Atomic Booking Function (prevents race conditions)
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION create_booking(
  p_date DATE,
  p_start_time TIME,
  p_end_time TIME,
  p_client_name TEXT,
  p_client_email TEXT,
  p_client_phone TEXT DEFAULT NULL,
  p_business_type TEXT DEFAULT NULL,
  p_project_description TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_booking_id UUID;
  v_day_of_week INTEGER;
  v_settings RECORD;
BEGIN
  -- Get settings
  SELECT * INTO v_settings FROM booking_settings WHERE id = 1;

  -- Validate day of week
  v_day_of_week := EXTRACT(ISODOW FROM p_date)::INTEGER;
  IF NOT (v_day_of_week = ANY(v_settings.available_days)) THEN
    RAISE EXCEPTION 'Selected day is not available for bookings';
  END IF;

  -- Check if date is blocked
  IF EXISTS (SELECT 1 FROM blocked_dates WHERE blocked_date = p_date) THEN
    RAISE EXCEPTION 'Selected date is blocked';
  END IF;

  -- Validate time is within business hours
  IF p_start_time < make_time(v_settings.start_hour, 0, 0) OR
     p_end_time > make_time(v_settings.end_hour, 0, 0) THEN
    RAISE EXCEPTION 'Selected time is outside business hours';
  END IF;

  -- Validate date is within booking window
  IF p_date < CURRENT_DATE + v_settings.advance_min_days OR
     p_date > CURRENT_DATE + v_settings.advance_max_days THEN
    RAISE EXCEPTION 'Date is outside the booking window';
  END IF;

  -- Advisory lock on date+time combo to prevent race conditions
  PERFORM pg_advisory_xact_lock(
    hashtext(p_date::TEXT || p_start_time::TEXT)
  );

  -- Check slot is still available
  IF EXISTS (
    SELECT 1 FROM bookings
    WHERE booking_date = p_date
      AND start_time = p_start_time
      AND status = 'confirmed'
  ) THEN
    RAISE EXCEPTION 'This time slot has already been booked';
  END IF;

  -- Insert booking
  INSERT INTO bookings (
    booking_date, start_time, end_time,
    client_name, client_email, client_phone,
    business_type, project_description
  ) VALUES (
    p_date, p_start_time, p_end_time,
    p_client_name, p_client_email, p_client_phone,
    p_business_type, p_project_description
  ) RETURNING id INTO v_booking_id;

  RETURN v_booking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
