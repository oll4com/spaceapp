-- Whether a program gives money (cash, investment, or spendable credits with a value: API usage, cloud, GPU, storage) rather than courses,
-- memberships, free tiers or services (operator 3/11, nous_msg:c85c7a41). Set per row by the programs files; null = not classified yet.
ALTER TABLE nous_programs ADD COLUMN gives_money boolean;
