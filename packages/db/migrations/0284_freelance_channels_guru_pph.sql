-- Freelance Copilot: Guru and PeoplePerHour join the six platforms (2/11, Cleo/Dana's space_freelance_lead_add refused GURU).
ALTER TABLE freelance_copilot_leads DROP CONSTRAINT IF EXISTS freelance_copilot_leads_channel_check;
ALTER TABLE freelance_copilot_leads ADD CONSTRAINT freelance_copilot_leads_channel_check
  CHECK (channel IN ('UPWORK','CONTRA','FIVERR','TOPTAL','ARC','BRAINTRUST','GURU','PEOPLEPERHOUR'));
ALTER TABLE freelance_copilot_messages DROP CONSTRAINT IF EXISTS freelance_copilot_messages_channel_check;
ALTER TABLE freelance_copilot_messages ADD CONSTRAINT freelance_copilot_messages_channel_check
  CHECK (channel IN ('UPWORK','CONTRA','FIVERR','TOPTAL','ARC','BRAINTRUST','GURU','PEOPLEPERHOUR'));
ALTER TABLE freelance_copilot_accounts DROP CONSTRAINT IF EXISTS freelance_copilot_accounts_channel_check;
ALTER TABLE freelance_copilot_accounts ADD CONSTRAINT freelance_copilot_accounts_channel_check
  CHECK (channel IN ('UPWORK','CONTRA','FIVERR','TOPTAL','ARC','BRAINTRUST','GURU','PEOPLEPERHOUR'));
ALTER TABLE freelance_copilot_memory DROP CONSTRAINT IF EXISTS freelance_copilot_memory_channel_check;
ALTER TABLE freelance_copilot_memory ADD CONSTRAINT freelance_copilot_memory_channel_check
  CHECK (channel IS NULL OR channel IN ('UPWORK','CONTRA','FIVERR','TOPTAL','ARC','BRAINTRUST','GURU','PEOPLEPERHOUR'));
ALTER TABLE freelance_copilot_rules DROP CONSTRAINT IF EXISTS freelance_copilot_rules_channel_check;
ALTER TABLE freelance_copilot_rules ADD CONSTRAINT freelance_copilot_rules_channel_check
  CHECK (channel IN ('UPWORK','CONTRA','FIVERR','TOPTAL','ARC','BRAINTRUST','GURU','PEOPLEPERHOUR'));
