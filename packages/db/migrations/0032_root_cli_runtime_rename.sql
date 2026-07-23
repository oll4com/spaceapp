UPDATE panes
SET terminal_runtime_id = 'cli:root',
    title = CASE WHEN title = 'VM' || '207 ROOT' THEN 'CLI ROOT' ELSE title END
WHERE terminal_runtime_id = 'cli:' || chr(118) || 'm207-root';

UPDATE pane_cli_sessions
SET runtime_id = 'cli:root'
WHERE runtime_id = 'cli:' || chr(118) || 'm207-root';
