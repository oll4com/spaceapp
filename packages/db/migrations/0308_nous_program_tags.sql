-- A program's grouped tags (operator 6/11 21:42 BKK, nous_msg:f0287998): ai-tokens, server-access, cash-grants, dev-tools, perks, set per row
-- by the programs files; the pages filter and badge by them. Rows written before read with none.
ALTER TABLE nous_programs ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
