-- Nous Computer K4 (plan clipboard:ZGz1LnD51ELH step 7): a suspended account's cell sleeps and refuses every wake until resumed.
ALTER TABLE nous_computer_cells ADD COLUMN suspended_at timestamptz;
