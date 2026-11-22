-- 學生分幾次傳的訊息併入同一題（老師還沒處理、10 分鐘內）

ALTER TABLE questions ADD COLUMN draft_version INTEGER NOT NULL DEFAULT 1;  -- 草稿每重寫一次 +1；老師送出時比對，避免送出舊版
ALTER TABLE questions ADD COLUMN merge_count INTEGER NOT NULL DEFAULT 0;    -- 併入過幾批訊息
ALTER TABLE questions ADD COLUMN notify_kind TEXT NOT NULL DEFAULT 'new';   -- 下一則通知的格式：new 新提問／update 補充（靜音一行）／upgrade 補充後才變成題目（完整通知）
ALTER TABLE questions ADD COLUMN notify_note TEXT;                          -- 補充通知的內容摘要（補傳了什麼）
