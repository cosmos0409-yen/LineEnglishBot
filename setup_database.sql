-- ============================================
-- LINE Tutor Bot - 資料庫初始化腳本
-- 請在 Supabase Dashboard → SQL Editor 中執行
-- ============================================

CREATE TABLE IF NOT EXISTS questions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_line_id TEXT NOT NULL,
    student_name TEXT NOT NULL DEFAULT '未知用戶',
    question_type TEXT NOT NULL DEFAULT 'text',  -- 'text' 或 'image'
    question_text TEXT,
    question_image_base64 TEXT,                   -- 圖片以 base64 存儲（供審核頁面顯示）
    ai_answer TEXT NOT NULL,
    final_answer TEXT NOT NULL,                   -- 初始值 = ai_answer，導師可編輯
    approval_count INTEGER NOT NULL DEFAULT 0,    -- 0 → 1 → 2（兩位導師皆通過）
    status TEXT NOT NULL DEFAULT 'pending',        -- pending → approved → sent
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 建立索引加速查詢
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_questions_created_at ON questions(created_at DESC);
