-- Recurring appointments (operator 26/11 11:08 BKK, nous_msg:cfce1783): {"every":"DAY"|"WEEKDAY","until":"YYYY-MM-DD"}, the same wall time
-- each day of the period in the appointment's zone; Expired only after the last one.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS recurrence jsonb;

-- The operator's EF-Start daily call: every weekday at 09:00 PST, Day 1 Wed 18/11, five calls after it per the 18/11 mail (to Tue 24/11 PST).
-- Weekdays are counted in its own zone, so it is booked in Los Angeles time. A no-op on every other install.
UPDATE appointments SET recurrence = '{"every":"WEEKDAY","until":"2026-11-24"}'::jsonb, time_zone = 'America/Los_Angeles'
  WHERE id = 'appointment:c0d7e484d10942d6' AND recurrence IS NULL;
