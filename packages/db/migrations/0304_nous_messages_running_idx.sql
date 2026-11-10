-- A start's failRunning (status = 'RUNNING') read all of nous_messages (131,897 rows, 182 MB): 15 s on a cold cache and past the API's 120 s
-- onReady limit on the Greece DR copy of public-host (6/11), so the API exited before it listened. Only a turn in flight is RUNNING.
CREATE INDEX IF NOT EXISTS nous_messages_running_idx ON nous_messages (status) WHERE status = 'RUNNING';
