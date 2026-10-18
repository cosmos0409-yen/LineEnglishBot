-- 學生資料：以 LINE userId 為主鍵；老師可設定備註名稱與班級（都可留空）

CREATE TABLE students (
  line_id        TEXT PRIMARY KEY,
  line_name      TEXT NOT NULL,           -- 最近一次看到的 LINE 暱稱（學生可能會改）
  display_name   TEXT,                    -- 老師設定的備註名稱；空白時顯示 LINE 暱稱
  class_name     TEXT,                    -- 班級，可留空
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  updated_at     INTEGER
);
CREATE INDEX idx_students_last_seen ON students(last_seen_at DESC);

-- 由既有提問補建學生資料（暱稱取最新一筆提問的）
INSERT OR IGNORE INTO students (line_id, line_name, first_seen_at, last_seen_at)
SELECT q.student_line_id,
       (SELECT q2.student_name FROM questions q2 WHERE q2.student_line_id = q.student_line_id ORDER BY q2.created_at DESC LIMIT 1),
       MIN(q.created_at),
       MAX(q.created_at)
  FROM questions q
 GROUP BY q.student_line_id;
