-- Add OpenRouter as a provider.
--
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it
-- on some Postgres versions, so this migration only declares the value; nothing
-- here references it.
ALTER TYPE provider_id ADD VALUE IF NOT EXISTS 'openrouter';
