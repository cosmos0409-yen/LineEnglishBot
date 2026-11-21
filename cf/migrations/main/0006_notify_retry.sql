-- Telegram 通知失敗時的補發：記錄嘗試次數、最後嘗試時間與錯誤原因（log 只保留 3 天，原因要存在資料庫才查得到）

ALTER TABLE questions ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE questions ADD COLUMN notify_attempt_at INTEGER;   -- ms；「正在發送」的租約，避免排程與緩衝區同時發；失敗後清空
ALTER TABLE questions ADD COLUMN notify_error TEXT;           -- 最後一次失敗的原因；成功後清空

-- 排程每 5 分鐘找「還沒通知成功」的題目，只索引這些列
CREATE INDEX idx_questions_unnotified ON questions(created_at) WHERE notified_at IS NULL;
