-- Operator 31/10 16:07 BKK «Βγάλε όλα τα όρια» (plan clipboard:xCBrZwhCTzmC): a Design or Video request takes any number of
-- formats, sources and delivered assets (were 8, 8 and 32). Design's 3 references stay: the image models take at most 3.
ALTER TABLE design_requests DROP CONSTRAINT IF EXISTS design_requests_format_ids_check;
ALTER TABLE design_requests ADD CONSTRAINT design_requests_format_ids_check CHECK (cardinality(format_ids) >= 1);
ALTER TABLE design_requests DROP CONSTRAINT IF EXISTS design_requests_result_asset_ids_check;

ALTER TABLE video_requests DROP CONSTRAINT IF EXISTS video_requests_sources_check;
ALTER TABLE video_requests ADD CONSTRAINT video_requests_sources_check CHECK (jsonb_typeof(sources) = 'array');
ALTER TABLE video_requests DROP CONSTRAINT IF EXISTS video_requests_format_ids_check;
ALTER TABLE video_requests ADD CONSTRAINT video_requests_format_ids_check CHECK (cardinality(format_ids) >= 1);
ALTER TABLE video_requests DROP CONSTRAINT IF EXISTS video_requests_result_asset_ids_check;
