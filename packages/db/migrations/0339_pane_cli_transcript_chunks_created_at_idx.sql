-- Speed slice 21 (14/11): the VPN 429 watcher (deploy/host/usr/local/libexec/space-vpn-429-watch.sh, every 30 s) asks for the chunks
-- of the last 75 seconds, and no index started with created_at: Postgres matched the watcher's regexes on the content of every chunk
-- (30,099 rows, 76 MB with TOAST) before it looked at the time (270 ms on average, 8.7 s at worst; 593 s of Postgres and 4.2 million
-- block reads in 18 hours on stable).
CREATE INDEX IF NOT EXISTS idx_pane_cli_transcript_chunks_created_at ON pane_cli_transcript_chunks (created_at);
