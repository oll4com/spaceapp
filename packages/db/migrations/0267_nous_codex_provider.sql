-- Operator request 2026-10-29: after adding provider selection, use Codex / GPT-6 Astra / high
-- for every normal Nous turn. This is a one-time change to this operator's legacy selection,
-- not a runtime override. Explicit provider selections and every other user's settings survive.
-- Legacy public installs also use user:operator, so match this operator's identity as well.
UPDATE user_settings
SET settings = jsonb_set(settings, '{nous}',
  (settings->'nous') || jsonb_build_object(
    'provider', 'codex',
    'models', jsonb_build_object(
      'operator', jsonb_build_object('model', 'gpt-6-astra', 'effort', 'high'),
      'decision', jsonb_build_object('model', 'gpt-6-astra', 'effort', 'high'),
      'inbox', jsonb_build_object('model', 'gpt-6-astra', 'effort', 'high'),
      'standing', jsonb_build_object('model', 'gpt-6-astra', 'effort', 'high'),
      'helper', jsonb_build_object('model', 'gpt-6-astra', 'effort', 'high'),
      'goal', jsonb_build_object('model', 'gpt-6-astra', 'effort', 'high')),
    'fallbackModel', 'none',
    'lowSpend', COALESCE(settings #> '{nous,lowSpend}', '{}'::jsonb) || jsonb_build_object(
      'models', jsonb_build_object(
        'inbox', jsonb_build_object('model', 'gpt-6.1-sol', 'effort', 'medium'),
        'standing', jsonb_build_object('model', 'gpt-6.1-sol', 'effort', 'medium'),
        'helper', jsonb_build_object('model', 'gpt-6.1-sol', 'effort', 'medium')),
      'criticalModels', jsonb_build_object(
        'inbox', jsonb_build_object('model', 'gpt-6-luna', 'effort', 'medium'),
        'standing', jsonb_build_object('model', 'gpt-6-luna', 'effort', 'medium'),
        'helper', jsonb_build_object('model', 'gpt-6-luna', 'effort', 'medium')))))
WHERE user_id = 'user:operator'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = user_settings.user_id AND lower(u.email) = 'operator@example.invalid')
  AND jsonb_typeof(settings->'nous') = 'object'
  AND NOT ((settings->'nous') ? 'provider');
