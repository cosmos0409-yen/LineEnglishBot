-- Phase 3：審核與推播

-- LINE 推播的 X-Line-Retry-Key（第一次推播時產生；重送沿用，24 小時內 LINE 不會重複發送）
ALTER TABLE questions ADD COLUMN push_retry_key TEXT;
ALTER TABLE questions ADD COLUMN push_error TEXT;
-- 老師第一次打開審核頁時呼叫 LINE 標已讀
ALTER TABLE questions ADD COLUMN read_marked_at INTEGER;
-- 承傑「直接通過」時記錄，審核頁顯示用
ALTER TABLE questions ADD COLUMN direct_approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE questions ADD COLUMN updated_at INTEGER;

-- PIN 輸錯紀錄（同一 IP 15 分鐘內錯 5 次就鎖）
CREATE TABLE login_failures (
  ip  TEXT NOT NULL,
  ts  INTEGER NOT NULL
);
CREATE INDEX idx_login_failures_ip_ts ON login_failures(ip, ts);
