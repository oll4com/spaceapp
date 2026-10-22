-- Design requests carry the Studio's template and its fields (operator request 2026-10-18, plan "Design for every agent"):
-- any agent asks for a graphic with a template, headline, subline, call to action and colours, like the operator in the Studio.
ALTER TABLE design_requests ADD COLUMN IF NOT EXISTS template_id text CHECK (template_id IS NULL OR char_length(template_id) <= 60);
ALTER TABLE design_requests ADD COLUMN IF NOT EXISTS params jsonb CHECK (params IS NULL OR jsonb_typeof(params) = 'object');
