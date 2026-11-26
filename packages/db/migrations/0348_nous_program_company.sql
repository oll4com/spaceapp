-- The company that applied to a program (operator 16/11 12:39 BKK, nous_msg:52aab2695d1e421ca1c71928): INTRATRADE, TOP IMPORTS, TECHME...
-- Set by space_programs upsert, a data file, or the notes' "Εταιρεία αίτησης: …" line. Null: no evidence names it.
ALTER TABLE nous_programs ADD COLUMN IF NOT EXISTS company text;

-- The operator's startup programs whose own notes, mails, status reason, account or sources already name INTRATRADE as the applicant
-- (read 16/11 from startup-programs.json and its journal). Eligibility remarks alone (elastic, techstars, ramp, crowdin, eic), a recommendation
-- (manifund) and a GitLab group mail (gitlab-hackathon) are no application by it and stay empty. Another install has none of these rows.
UPDATE nous_programs SET company = 'INTRATRADE'
WHERE owner_user_id = 'user:operator' AND company IS NULL AND id IN (
  'aiven-for-startups', 'alchemist-accelerator', 'algolia-startup-program', 'anthropic-claude-cvp', 'anthropic-claude-for-startups',
  'claude-marketplace-partner-waitlist', 'claude-partner-network', 'aria-scaling-trust-tracks-2-3', 'augment-code-claude-stack',
  'clickhouse-startup-offer', 'confluent-for-startups', 'couchbase-capella-starter-kit', 'denvr-ai-ascend', 'telekom-techboost',
  'elevenlabs-claude-stack', 'enum-for-startups', 'elevate-greece-hdbi-funding', 'google-for-startups-cloud',
  'itu-ai-for-good-innovation-factory-2026-27', 'linear-for-startups', 'mit-solve-2027', 'miro-startup-program', 'moda-claude-stack',
  'nvidia-partner-aws-10k', 'auth0-for-startups', 'seedcamp-pitch', 'svix-startups', 'tailscale-for-startups', 'upcloud-for-startups',
  'minimax-open-platform'
);
