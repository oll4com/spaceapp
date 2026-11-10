-- The fields the operator locked on a program (operator 9/11 20:59 BKK: UpCloud's €5,000 went back to €1,000 when a pane rewrote the programs file):
-- a data file never changes them, space_programs only with a new source.
ALTER TABLE nous_programs ADD COLUMN locked text[] NOT NULL DEFAULT '{}';
