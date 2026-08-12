ALTER TABLE source_control_connections
  DROP CONSTRAINT IF EXISTS source_control_connections_check;

ALTER TABLE source_control_connections
  DROP CONSTRAINT IF EXISTS source_control_connections_repository_name_check;

UPDATE source_control_connections
   SET repository_name = 'space'
 WHERE provider = 'gitea'
   AND repository_name IN ('spaceapp-rooms', 'spaceapp');

UPDATE source_control_connections
   SET repository_name = 'space'
 WHERE provider = 'github'
   AND repository_name = 'spaceapp';

ALTER TABLE source_control_connections
  ADD CONSTRAINT source_control_connections_repository_name_check
  CHECK (
    (provider = 'gitea' AND repository_name = 'space')
    OR (provider = 'github' AND repository_name = 'space')
  );
