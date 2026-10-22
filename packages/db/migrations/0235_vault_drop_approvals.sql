-- Hardening plan clipboard:sFj1wGEY473i step 16: per-use approvals ended with the one-switch decision (2026-10-18,
-- plan clipboard:Ml8zElMcc4Ac); nothing has read or written vault_approvals since. Its rows never held a value.
DROP TABLE IF EXISTS vault_approvals;
