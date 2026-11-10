-- What each program gives, line by line (credit grants, seats, listings; used/remaining for usage), and its tiers (operator 3/11 21:41 BKK,
-- plan clipboard:17yLAnH5ZpyF). Written whole by apps/api/src/nous/programs.ts.
ALTER TABLE nous_programs ADD COLUMN benefits jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE nous_programs ADD COLUMN tiers jsonb NOT NULL DEFAULT '[]'::jsonb;
