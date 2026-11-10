-- EXT-G-5: the trace lookup finds Space Gateway's request log rows by the caller's x-request-id (OBS-006 keeps it as request_id).
CREATE INDEX IF NOT EXISTS space_gateway_request_logs_request_id_idx ON space_gateway_request_logs(request_id);
