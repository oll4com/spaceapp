-- Personal repository providers only. ADMIN source-control configuration is unchanged.
ALTER TABLE personal_git_connections DROP CONSTRAINT IF EXISTS personal_git_connections_provider_check;
ALTER TABLE personal_git_connections ADD CONSTRAINT personal_git_connections_provider_check
  CHECK (provider IN ('github','gitea','forgejo','gitlab','bitbucket','azure-devops'));

-- Preserve existing opt-outs, credential references and every other JSON field.
UPDATE personal_git_connections
SET data = jsonb_set(data, '{enabled}', to_jsonb(provider IN ('github','gitea')))
WHERE NOT (data ? 'enabled');
UPDATE project_repository_bindings
SET data = jsonb_set(data, '{kind}', '"provider"'::jsonb)
WHERE NOT (data ? 'kind');
