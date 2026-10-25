-- Space Gateway code and prose compression (Headroom's content router: lossless folds, CodeAware, mixed content,
-- TextCrusher). SHADOW measures it without changing what is sent; the operator turns it ON after review.
ALTER TABLE space_gateway_settings
  ADD COLUMN IF NOT EXISTS compression_code_text text NOT NULL DEFAULT 'SHADOW' CHECK (compression_code_text IN ('OFF','SHADOW','ON'));
