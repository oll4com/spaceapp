-- Operator 31/10 16:07 and 16:25 BKK «Βγάλε όλα τα όρια!! Από παντού!!», «Σταμάτα να βάζεις αυθαίρετα όρια» (plan clipboard:xCBrZwhCTzmC
-- step 3, inventory K2): a copilot's event message (a question, a review reason, a report, an error) and a Design or Video request's message
-- are kept whole. Until 1/11 they were cut at 1,000 (Job, Mail, Marketing, Freelance) or 2,000 characters (the others) to fit these CHECKs.
ALTER TABLE job_apply_events DROP CONSTRAINT IF EXISTS job_apply_events_message_check;
ALTER TABLE job_apply_events ADD CONSTRAINT job_apply_events_message_check CHECK (char_length(message) >= 1);
ALTER TABLE mail_copilot_events DROP CONSTRAINT IF EXISTS mail_copilot_events_message_check;
ALTER TABLE mail_copilot_events ADD CONSTRAINT mail_copilot_events_message_check CHECK (char_length(message) >= 1);
ALTER TABLE marketing_copilot_events DROP CONSTRAINT IF EXISTS marketing_copilot_events_message_check;
ALTER TABLE marketing_copilot_events ADD CONSTRAINT marketing_copilot_events_message_check CHECK (char_length(message) >= 1);
ALTER TABLE freelance_copilot_events DROP CONSTRAINT IF EXISTS freelance_copilot_events_message_check;
ALTER TABLE freelance_copilot_events ADD CONSTRAINT freelance_copilot_events_message_check CHECK (char_length(message) >= 1);
ALTER TABLE security_copilot_events DROP CONSTRAINT IF EXISTS security_copilot_events_message_check;
ALTER TABLE security_copilot_events ADD CONSTRAINT security_copilot_events_message_check CHECK (char_length(message) >= 1);
ALTER TABLE monitoring_copilot_events DROP CONSTRAINT IF EXISTS monitoring_copilot_events_message_check;
ALTER TABLE monitoring_copilot_events ADD CONSTRAINT monitoring_copilot_events_message_check CHECK (char_length(message) >= 1);
ALTER TABLE app_studio_events DROP CONSTRAINT IF EXISTS app_studio_events_message_check;
ALTER TABLE app_studio_events ADD CONSTRAINT app_studio_events_message_check CHECK (char_length(message) >= 1);
ALTER TABLE design_requests DROP CONSTRAINT IF EXISTS design_requests_message_check;
ALTER TABLE design_events DROP CONSTRAINT IF EXISTS design_events_message_check;
ALTER TABLE video_requests DROP CONSTRAINT IF EXISTS video_requests_message_check;
ALTER TABLE video_events DROP CONSTRAINT IF EXISTS video_events_message_check;
