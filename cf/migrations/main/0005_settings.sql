-- AI 設定（承傑可在審核介面修改）：沒有設定的項目沿用 wrangler.jsonc 的預設值

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,      -- model_image / model_text / reasoning_effort / fallback_warned_at
  value       TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  INTEGER
);

CREATE TABLE settings_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,
  old_value   TEXT,                  -- NULL 代表原本是預設值
  new_value   TEXT,                  -- NULL 代表改回預設值
  changed_by  TEXT NOT NULL,
  changed_at  INTEGER NOT NULL
);
CREATE INDEX idx_settings_log_time ON settings_log(changed_at DESC);
