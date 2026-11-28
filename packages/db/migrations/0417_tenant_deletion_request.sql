-- K4 account deletion with a 7-day undo (plan clipboard:ZGz1LnD51ELH step 7, K2 design §3.2 DELETE /api/account): when the tenant
-- entered DELETING and the status to restore if the deletion is cancelled. Both NULL outside DELETING.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status_before_deletion text CHECK (status_before_deletion IN ('ACTIVE', 'FROZEN'));
