-- feedback_pre / feedback_post nodes, completion time, and outbox delivery state.
-- Additive only: no existing column changes type or meaning, and no data is deleted.

ALTER TABLE feedback ADD COLUMN feedback_pre_json TEXT;
ALTER TABLE feedback ADD COLUMN feedback_post_json TEXT;
ALTER TABLE feedback ADD COLUMN completed_at TEXT;

ALTER TABLE feedback_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feedback_outbox ADD COLUMN delivered_at TEXT;
ALTER TABLE feedback_outbox ADD COLUMN last_error_code TEXT;
