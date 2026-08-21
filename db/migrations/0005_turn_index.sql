ALTER TABLE chat_requests
  ADD COLUMN IF NOT EXISTS turn_index integer;

WITH ranked_requests AS (
  SELECT id, row_number() OVER (PARTITION BY session_id ORDER BY requested_at, id)::integer AS turn_index
  FROM chat_requests
)
UPDATE chat_requests AS request
SET turn_index = ranked.turn_index
FROM ranked_requests AS ranked
WHERE request.id = ranked.id AND request.turn_index IS NULL;

ALTER TABLE chat_requests
  ALTER COLUMN turn_index SET NOT NULL,
  ADD CONSTRAINT chat_requests_turn_index_positive CHECK (turn_index > 0),
  ADD CONSTRAINT chat_requests_session_turn_unique UNIQUE (session_id, turn_index);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS turn_index integer;

UPDATE messages AS message
SET turn_index = request.turn_index
FROM chat_requests AS request
WHERE message.chat_request_id = request.id AND message.turn_index IS NULL;

ALTER TABLE messages
  ALTER COLUMN turn_index SET NOT NULL,
  ADD CONSTRAINT messages_turn_index_positive CHECK (turn_index > 0);

CREATE INDEX IF NOT EXISTS messages_session_turn_idx
  ON messages (session_id, turn_index, sequence_no);
