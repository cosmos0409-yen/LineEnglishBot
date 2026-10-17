-- 主資料庫：提問與對話紀錄

CREATE TABLE questions (
  id                 TEXT PRIMARY KEY,               -- UUID，審核網址用
  batch_id           TEXT NOT NULL UNIQUE,           -- 冪等鍵：該批第一則訊息的 webhookEventId
  student_line_id    TEXT NOT NULL,
  student_name       TEXT NOT NULL DEFAULT '未知用戶',
  question_text      TEXT,
  image_ids          TEXT NOT NULL DEFAULT '[]',     -- IMAGES_DB.images.id 的 JSON 陣列
  context_image_id   TEXT,                           -- 追問時從前文補上的照片
  kind               TEXT,                           -- question / need_more_info / non_question；AI 失敗時為 NULL
  ai_status          TEXT NOT NULL DEFAULT 'ok',     -- ok / error（錯誤時不把錯誤訊息當解答）
  ai_error           TEXT,
  ai_answer          TEXT,
  tutor_note         TEXT,
  confidence         TEXT,
  ai_meta            TEXT,                           -- JSON：model、tokens、延遲
  final_answer       TEXT,
  approver_cheng_jie INTEGER NOT NULL DEFAULT 0,
  approver_tutor     INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'pending',-- pending → approved → sent / push_failed
  notified_at        INTEGER,                        -- Telegram 通知成功時間（ms），NULL 代表還沒通知
  created_at         INTEGER NOT NULL,               -- ms
  sent_at            INTEGER
);
CREATE INDEX idx_questions_status ON questions(status, created_at);
CREATE INDEX idx_questions_student ON questions(student_line_id, created_at);

CREATE TABLE messages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT UNIQUE,                    -- 學生訊息的 webhookEventId；老師訊息為 NULL
  student_line_id    TEXT NOT NULL,
  role               TEXT NOT NULL,                  -- student / teacher（已送出的最終解答）
  type               TEXT NOT NULL,                  -- text / image / 其他
  text               TEXT,
  image_id           TEXT,
  question_id        TEXT,
  mark_as_read_token TEXT,
  ts                 INTEGER NOT NULL                -- LINE 事件時間（ms）
);
CREATE INDEX idx_messages_student_ts ON messages(student_line_id, ts);
