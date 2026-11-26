-- Files every mail of a template version carries (operator 20/11 21:42 BKK, nous_msg:6aadf9c8: the free-audit sample PDF goes as an
-- attachment, never a link). [{filename, contentBase64}]; part of the version and its fingerprint, so an approval covers the exact bytes.
ALTER TABLE mail_campaign_template_versions ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
