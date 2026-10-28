// AI 設定：存在 D1 的 settings 表；沒設定的項目沿用 wrangler.jsonc 的預設值（env）
import type { Role } from "./auth";

export type AiSettingKey = "model_image" | "model_text" | "reasoning_effort";
export const AI_SETTING_KEYS: AiSettingKey[] = ["model_image", "model_text", "reasoning_effort"];

export const SETTING_LABEL: Record<AiSettingKey, string> = {
  model_image: "有照片的題目",
  model_text: "純文字題目",
  reasoning_effort: "思考深度",
};

export const EFFORT_OPTIONS = ["low", "medium", "high"] as const;
export const EFFORT_LABEL: Record<string, string> = { low: "low（快、省）", medium: "medium（建議）", high: "high（慢、準）" };

export interface AiConfig {
  modelImage: string;
  modelText: string;
  effort: string;
  /** 哪些項目是老師1 自訂的（其餘為預設值） */
  custom: Partial<Record<AiSettingKey, true>>;
}

export function defaultAiConfig(env: Env): Omit<AiConfig, "custom"> {
  return { modelImage: env.OPENAI_MODEL_IMAGE, modelText: env.OPENAI_MODEL_TEXT, effort: env.OPENAI_REASONING_EFFORT };
}

export async function getAiConfig(env: Env): Promise<AiConfig> {
  // 讀不到設定（例如資料表還沒建立、D1 暫時故障）時改用預設值：設定功能出問題不能拖垮 AI 作答
  let results: { key: AiSettingKey; value: string }[] = [];
  try {
    results = (
      await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('model_image', 'model_text', 'reasoning_effort')").run<{
        key: AiSettingKey;
        value: string;
      }>()
    ).results;
  } catch (err) {
    console.log(JSON.stringify({ event: "ai_config_read_failed", error: String(err).slice(0, 200) }));
  }
  const map = new Map(results.map((r) => [r.key, r.value]));
  const d = defaultAiConfig(env);
  const custom: AiConfig["custom"] = {};
  for (const k of AI_SETTING_KEYS) if (map.has(k)) custom[k] = true;
  return {
    modelImage: map.get("model_image") ?? d.modelImage,
    modelText: map.get("model_text") ?? d.modelText,
    effort: map.get("reasoning_effort") ?? d.effort,
    custom,
  };
}

/** 模型 ID 只允許英數與 . _ : -（避免奇怪的輸入被送到 OpenAI 或顯示在頁面上）。 */
export function isValidModelId(id: string): boolean {
  return /^[A-Za-z0-9._:-]{1,64}$/.test(id);
}

export function isValidEffort(e: string): boolean {
  return (EFFORT_OPTIONS as readonly string[]).includes(e);
}

export type AiConfigInput = { modelImage: string; modelText: string; effort: string };

export function validateAiInput(v: AiConfigInput): string | null {
  if (!isValidModelId(v.modelImage) || !isValidModelId(v.modelText)) return "模型名稱格式不正確";
  if (!isValidEffort(v.effort)) return "思考深度不正確";
  return null;
}

/**
 * 儲存設定並寫入變更紀錄。和預設值相同的項目會刪除自訂（回到「預設」），讓預設值日後調整時能自動套用。
 */
export async function saveAiConfig(env: Env, role: Role, v: AiConfigInput, now = Date.now()): Promise<number> {
  const current = await getAiConfig(env);
  const d = defaultAiConfig(env);
  const next: Record<AiSettingKey, string> = { model_image: v.modelImage, model_text: v.modelText, reasoning_effort: v.effort };
  const curr: Record<AiSettingKey, string> = { model_image: current.modelImage, model_text: current.modelText, reasoning_effort: current.effort };
  const defaults: Record<AiSettingKey, string> = { model_image: d.modelImage, model_text: d.modelText, reasoning_effort: d.effort };

  const stmts: D1PreparedStatement[] = [];
  for (const k of AI_SETTING_KEYS) {
    if (next[k] === curr[k] && Boolean(current.custom[k]) === (next[k] !== defaults[k])) continue;
    const isDefault = next[k] === defaults[k];
    stmts.push(
      isDefault
        ? env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(k)
        : env.DB.prepare(
            `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          ).bind(k, next[k], role, now),
    );
    if (next[k] !== curr[k]) {
      stmts.push(
        env.DB.prepare("INSERT INTO settings_log (key, old_value, new_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?)").bind(
          k,
          curr[k],
          next[k],
          role,
          now,
        ),
      );
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

export interface SettingsLogRow {
  id: number;
  key: AiSettingKey;
  old_value: string | null;
  new_value: string | null;
  changed_by: string;
  changed_at: number;
}

export async function listSettingsLog(env: Env, limit = 20): Promise<SettingsLogRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM settings_log ORDER BY changed_at DESC, id DESC LIMIT ?").bind(limit).run<SettingsLogRow>();
  return results;
}

/** 把某一筆變更「改回」：該項目設回當時的舊值。 */
export async function revertSetting(env: Env, role: Role, logId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT * FROM settings_log WHERE id = ?").bind(logId).first<SettingsLogRow>();
  if (!row || row.old_value === null) return false;
  const c = await getAiConfig(env);
  const v: AiConfigInput = { modelImage: c.modelImage, modelText: c.modelText, effort: c.effort };
  if (row.key === "model_image") v.modelImage = row.old_value;
  if (row.key === "model_text") v.modelText = row.old_value;
  if (row.key === "reasoning_effort") v.effort = row.old_value;
  if (validateAiInput(v)) return false;
  await saveAiConfig(env, role, v);
  return true;
}

/**
 * 從 OpenAI 讀取目前帳號可用的模型，只留文字對話類（排除圖片生成、語音、嵌入、審核等）。
 * 讀取失敗時回傳 null，頁面改用文字輸入框。
 */
export async function listOpenAIModels(env: Env): Promise<string[] | null> {
  try {
    const resp = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { data?: { id: string }[] };
    const exclude = /(image|audio|realtime|transcribe|tts|whisper|embedding|moderation|search|dall-e|live|translate|codex|instruct|davinci|babbage|-\d{4}-\d{2}-\d{2})/i;
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id) => /^(gpt-|o\d)/.test(id) && !exclude.test(id) && isValidModelId(id))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  } catch {
    return null;
  }
}

/** 退回預設模型時的 Telegram 提醒，一小時最多一次。回傳 true 代表這次該發。 */
export async function claimFallbackWarning(env: Env, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('fallback_warned_at', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE CAST(settings.value AS INTEGER) < ?
     RETURNING key`,
  )
    .bind(String(now), now, now - 60 * 60 * 1000)
    .first();
  return Boolean(row);
}
