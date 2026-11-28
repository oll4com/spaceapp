-- K4 deletion sweep (plan clipboard:ZGz1LnD51ELH step 7): when finishDeletion revoked the tenant's keys and destroyed its computer,
-- so the hourly sweep finishes each deletion once. The tenant's rows stay until K1's purge.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deletion_finished_at timestamptz;
