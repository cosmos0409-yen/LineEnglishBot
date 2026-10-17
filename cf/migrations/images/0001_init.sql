-- 照片資料庫：D1 單列上限 2 MB，所以照片切塊存放；每天由 cron 清除超過保存期限的照片

CREATE TABLE images (
  id               TEXT PRIMARY KEY,                 -- LINE messageId
  student_line_id  TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  size             INTEGER NOT NULL,
  chunk_count      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL                  -- ms
);
CREATE INDEX idx_images_created ON images(created_at);

CREATE TABLE image_chunks (
  image_id  TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  data      BLOB NOT NULL,
  PRIMARY KEY (image_id, seq)
);
