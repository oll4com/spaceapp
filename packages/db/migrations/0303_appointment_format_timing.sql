-- Appointment format and timing (operator 6/11 10:15 BKK, nous_msg:ea6f0792): who or what is on the other side, and whether the time is strict
-- (FIXED) or any time until deadline_at (FLEXIBLE). Required on UPCOMING writes by the API; older closed rows keep them null.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS format text
  CHECK (format IN ('AI_INTERVIEW', 'RECORDED_VIDEO', 'LIVE_HUMAN_VIDEO', 'PHONE', 'IN_PERSON', 'WEBINAR', 'TEST', 'OTHER'));
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS timing text CHECK (timing IN ('FIXED', 'FLEXIBLE'));
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deadline_at timestamptz;

-- Backfill every UPCOMING one from its kind and text, kept FIXED (a FLEXIBLE one needs its deadline, which only its mail says).
UPDATE appointments SET timing = 'FIXED', format = CASE
    WHEN kind = 'WEBINAR' THEN 'WEBINAR'
    WHEN concat_ws(' ', title, notes) ~* '(^|[^a-z])ai[- ](voice |video )?(call|interview|screen)' THEN 'AI_INTERVIEW'
    WHEN concat_ws(' ', title, location, notes) ~* '(hireflix|spark ?hire|one-way|recorded video|βιντεοσκοπημένη)' THEN 'RECORDED_VIDEO'
    WHEN kind IN ('INTERVIEW', 'CALL') THEN 'LIVE_HUMAN_VIDEO'
    ELSE 'OTHER' END
  WHERE status = 'UPCOMING' AND format IS NULL;
-- The operator's one recorded interview (the Hireflix one, moved to 11:00 BKK): any time until its link closes. A no-op on every other install.
UPDATE appointments SET timing = 'FLEXIBLE', deadline_at = '2026-11-07T13:42:00Z'
  WHERE id = 'appointment:575c2be656d14a53' AND status = 'UPCOMING' AND deadline_at IS NULL;
