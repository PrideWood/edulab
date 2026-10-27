-- A separate disposition survives all later snapshots of the same local identity.
-- No snapshots/messages are deleted; the ingestion role receives no new rights.
CREATE TABLE IF NOT EXISTS local_backup_dispositions (
  device_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  is_trashed boolean NOT NULL DEFAULT true,
  trashed_at timestamptz NOT NULL DEFAULT now(),
  trashed_by uuid REFERENCES admin_users(id),
  restored_at timestamptz,
  restored_by uuid REFERENCES admin_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(device_id, participant_id)
);
CREATE INDEX IF NOT EXISTS local_backup_trash_time_idx
  ON local_backup_dispositions(trashed_at DESC) WHERE is_trashed;
REVOKE ALL ON local_backup_dispositions FROM PUBLIC;
