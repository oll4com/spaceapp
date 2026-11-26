-- Operator 26/11 (nous_msg:2d0eb603e71d43bb863d9717): a program's verified usage {state USED|UNUSED, evidence, checkedAt}, read from real
-- evidence; it wins over the usage the page derives from benefit lines. Null = not verified.
ALTER TABLE nous_programs ADD COLUMN usage jsonb;
