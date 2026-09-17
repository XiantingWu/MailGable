-- Generic outbound provider identity.
--
-- Pre-public normalization: outgoing messages and delivery events move to
-- provider-generic identity fields. Legacy columns (resend_email_id, svix_id)
-- are retained for v0.1 compatibility and cleaned up in a later release.
--
-- The message pins its provider permanently so retries never migrate to a
-- different provider, and the provider-message-id namespace is unique per
-- provider.

ALTER TABLE mail_messages ADD COLUMN outbound_provider TEXT;
ALTER TABLE mail_messages ADD COLUMN provider_message_id TEXT;
ALTER TABLE mail_messages ADD COLUMN provider_retry_deadline TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_provider_message
  ON mail_messages(outbound_provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL AND provider_message_id <> '';

ALTER TABLE mail_delivery_events ADD COLUMN provider TEXT;
ALTER TABLE mail_delivery_events ADD COLUMN provider_event_id TEXT;
ALTER TABLE mail_delivery_events ADD COLUMN provider_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_delivery_events_provider_event
  ON mail_delivery_events(provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL AND provider_event_id <> '';

-- Backfill: pre-public history was Resend-only.
UPDATE mail_messages
   SET outbound_provider = 'resend',
       provider_message_id = resend_email_id,
       updated_at = updated_at
 WHERE direction = 'outgoing'
   AND resend_email_id IS NOT NULL
   AND resend_email_id <> '';

UPDATE mail_messages
   SET outbound_provider = 'resend',
       updated_at = updated_at
 WHERE direction = 'outgoing'
   AND (outbound_provider IS NULL OR outbound_provider = '')
   AND (resend_email_id IS NULL OR resend_email_id = '');

UPDATE mail_delivery_events
   SET provider = 'resend',
       provider_message_id = resend_email_id,
       provider_event_id = svix_id
 WHERE svix_id IS NOT NULL AND svix_id <> '';