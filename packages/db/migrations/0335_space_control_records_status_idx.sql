-- Speed audit 14/11: listActive (the control tick's watch, schedule and operation reads, Nous's held dispatch) read every record of
-- the kind through (kind, updated_at) to keep the few whose status is active: 108,600 calls in 12 h, 3,981 pages each for 3 rows.
-- On a copy-sized table (10,106 rows, 33 MB) the read goes from 11.5 ms and 11,389 pages to 0.09 ms and 6; a read that matches most of
-- a kind keeps the older index. Plain CREATE INDEX (the runner's transaction): writes to the table wait well under a second.
CREATE INDEX IF NOT EXISTS space_control_records_kind_status_idx ON space_control_records (kind, (value->>'status'));
