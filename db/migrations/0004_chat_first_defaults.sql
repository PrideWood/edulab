UPDATE experiment_settings
SET task_visible = false, updated_at = now()
WHERE task_visible = true;
