-- 「不需回覆」：老師把不需要回答的訊息（打招呼、閒聊、已在 LINE 直接回覆的）標記為已處理
-- status 新增 'dismissed'；可以再改回 'pending'
ALTER TABLE questions ADD COLUMN dismissed_by TEXT;
ALTER TABLE questions ADD COLUMN dismissed_at INTEGER;
