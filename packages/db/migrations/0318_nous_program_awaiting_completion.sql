-- An approved program whose completion is still pending (credit, activation, code or card verification not done; operator 11/11,
-- nous_msg:a5e13d012e47434a995fbc91): the page lists it under Approved and Waiting. Set by space_programs upsert.
ALTER TABLE nous_programs ADD COLUMN awaiting_completion boolean NOT NULL DEFAULT false;
