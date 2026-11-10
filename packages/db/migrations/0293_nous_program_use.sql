-- What a program is and how SpaceApp/oll4 uses it, with what that needs (operator 4/11 15:09 BKK, R73): the operator's report on an approval
-- leads with them; required when Nous or a person makes a program APPROVED. Null on rows written before.
ALTER TABLE nous_programs ADD COLUMN what_it_is text, ADD COLUMN how_we_use text;
