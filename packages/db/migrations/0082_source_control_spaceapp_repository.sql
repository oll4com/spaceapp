ALTER TABLE source_control_connections
  DROP CONSTRAINT IF EXISTS source_control_connections_repository_name_check;

UPDATE source_control_connections
   SET repository_name = 'spaceapp'
 WHERE provider IN ('gitea', 'github')
   AND repository_name = 'space';

ALTER TABLE source_control_connections
  ADD CONSTRAINT source_control_connections_repository_name_check
  CHECK (
    (provider = 'gitea' AND repository_name = 'spaceapp')
    OR (provider = 'github' AND repository_name = 'spaceapp')
  );
