-- EXT-G-5: the trace lookup finds a traced CLI session's own gateway calls by its pane tag (project = pane id) within the session's span.
CREATE INDEX IF NOT EXISTS space_gateway_request_logs_project_idx ON space_gateway_request_logs(project, requested_at DESC) WHERE project IS NOT NULL;
