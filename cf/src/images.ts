// 照片存放在獨立的 D1（IMAGES_DB）。D1 單列上限 2 MB，因此切塊存放。

const CHUNK_BYTES = 1_000_000;

export interface StoredImage {
  bytes: Uint8Array;
  contentType: string;
}

/** 已存在就略過（alarm 重試時不重複寫入）。 */
export async function saveImage(env: Env, id: string, studentLineId: string, img: StoredImage, now = Date.now()): Promise<void> {
  const exists = await env.IMAGES_DB.prepare("SELECT 1 FROM images WHERE id = ?").bind(id).first();
  if (exists) return;

  const chunkCount = Math.max(1, Math.ceil(img.bytes.length / CHUNK_BYTES));
  const stmts = [];
  for (let seq = 0; seq < chunkCount; seq++) {
    // 用 slice 複製成獨立的 buffer；subarray 只是視圖，綁定時可能把整個底層 buffer 送出
    const part = img.bytes.slice(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES);
    stmts.push(env.IMAGES_DB.prepare("INSERT OR REPLACE INTO image_chunks (image_id, seq, data) VALUES (?, ?, ?)").bind(id, seq, part));
  }
  // images 那一列最後寫：讀取端以它是否存在判斷照片是否完整
  stmts.push(
    env.IMAGES_DB.prepare(
      "INSERT OR IGNORE INTO images (id, student_line_id, content_type, size, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, studentLineId, img.contentType, img.bytes.length, chunkCount, now),
  );
  await env.IMAGES_DB.batch(stmts);
}

export async function loadImage(env: Env, id: string): Promise<StoredImage | null> {
  const meta = await env.IMAGES_DB.prepare("SELECT content_type, size, chunk_count FROM images WHERE id = ?")
    .bind(id)
    .first<{ content_type: string; size: number; chunk_count: number }>();
  if (!meta) return null;

  const { results } = await env.IMAGES_DB.prepare("SELECT data FROM image_chunks WHERE image_id = ? ORDER BY seq")
    .bind(id)
    .run<{ data: ArrayBuffer | number[] }>();
  if (results.length !== meta.chunk_count) return null;

  const bytes = new Uint8Array(meta.size);
  let offset = 0;
  for (const row of results) {
    const part = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : new Uint8Array(row.data);
    bytes.set(part, offset);
    offset += part.length;
  }
  return offset === meta.size ? { bytes, contentType: meta.content_type } : null;
}

/** 刪除超過保存期限的照片，回傳刪除張數。 */
export async function deleteExpiredImages(env: Env, now = Date.now()): Promise<number> {
  const days = Number(env.IMAGE_RETENTION_DAYS) || 180;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const [, deleted] = await env.IMAGES_DB.batch([
    env.IMAGES_DB.prepare("DELETE FROM image_chunks WHERE image_id IN (SELECT id FROM images WHERE created_at < ?)").bind(cutoff),
    env.IMAGES_DB.prepare("DELETE FROM images WHERE created_at < ?").bind(cutoff),
  ]);
  return deleted.meta.changes ?? 0;
}
