import { SYSTEM_PROMPT } from "./prompt";
import { cleanAnswer } from "./text";
import { defaultAiConfig, getAiConfig, type AiConfigInput } from "./settings";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export type DraftKind = "question" | "need_more_info" | "non_question";

export interface Draft {
  kind: DraftKind;
  answer: string;
  tutor_note: string;
  confidence: "high" | "medium" | "low";
}

export interface DraftResult {
  draft: Draft;
  meta: {
    model: string;
    serviceTier: string;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    latencyMs: number;
    flexFallback: boolean;
    /** 老師1 設定的模型無法使用、自動改用預設模型時，記下原本的模型 */
    modelFallbackFrom?: string;
  };
}

export interface InlineImage {
  base64: string;
  contentType: string;
}

/** 前文：學生訊息當 user、老師已送出的解答當 assistant。 */
export interface HistoryTurn {
  role: "student" | "teacher";
  text: string | null;
  hadImage: boolean;
  minutesAgo: number;
}

export interface DraftInput {
  text: string | null;
  images: InlineImage[];
  history?: HistoryTurn[];
  /** 本批沒有照片時，從前文補上的最近一張照片 */
  contextImage?: InlineImage | null;
  /** 老師在審核頁按「產生 AI 草稿」：不允許判成 non_question */
  forceAnswer?: boolean;
}

// 老師強制產生草稿時，kind 的選項拿掉 non_question：不只靠 Prompt，用 schema 保證一定會寫草稿
const responseFormat = (forceAnswer: boolean) => ({
  type: "json_schema",
  json_schema: {
    name: "tutor_draft",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: forceAnswer ? ["question", "need_more_info"] : ["question", "need_more_info", "non_question"] },
        answer: { type: "string" },
        tutor_note: { type: "string" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["kind", "answer", "tutor_note", "confidence"],
    },
  },
});

const imagePart = (img: InlineImage) => ({
  type: "image_url",
  image_url: { url: `data:${img.contentType};base64,${img.base64}`, detail: "high" },
});

function buildUserContent(input: DraftInput) {
  const content: unknown[] = input.images.map(imagePart);
  if (input.contextImage) {
    content.push({ type: "text", text: "（下面這張是學生前面傳過的照片，這次沒有重新傳）" });
    content.push(imagePart(input.contextImage));
  }
  // 只有圖片沒有文字時，仍要給模型一段文字，讓它判斷是否需要追問題號
  content.push({ type: "text", text: input.text ?? "（學生只傳了圖片，沒有附文字）" });
  if (input.forceAnswer) {
    content.push({
      type: "text",
      text: "（老師要求：請把這則訊息當成英文學習問題寫出回覆草稿，kind 只能是 question 或 need_more_info，不可以是 non_question）",
    });
  }
  return content;
}

export function buildMessages(input: DraftInput) {
  const history = (input.history ?? []).map((h) => {
    const body = h.text ?? "";
    if (h.role === "teacher") return { role: "assistant", content: body };
    const photo = h.hadImage ? "［傳了一張照片］" : "";
    return { role: "user", content: `（${h.minutesAgo} 分鐘前）${photo}${body}` };
  });
  return [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: buildUserContent(input) }];
}

async function callOnce(env: Env, model: string, effort: string, serviceTier: string | null, input: DraftInput) {
  const body: Record<string, unknown> = {
    model,
    reasoning_effort: effort,
    response_format: responseFormat(Boolean(input.forceAnswer)),
    messages: buildMessages(input),
  };
  if (serviceTier) body.service_tier = serviceTier;
  return fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export type AiErrorKind = "auth" | "quota" | "model" | "rate_limit" | "server" | "unknown";

/** 給老師看的原因（Telegram、審核頁共用）。 */
export const AI_ERROR_REASON: Record<AiErrorKind, string> = {
  auth: "OpenAI 金鑰失效，請更新 OPENAI_API_KEY",
  quota: "OpenAI 額度用完，請到 OpenAI 後台加值或提高使用上限",
  model: "找不到 AI 模型或請求格式有誤，請檢查 OPENAI_MODEL_* 設定",
  rate_limit: "OpenAI 暫時忙碌，多次重試仍失敗",
  server: "OpenAI 暫時故障，多次重試仍失敗",
  unknown: "AI 處理失敗，原因不明",
};

/** OpenAI 呼叫失敗。retryable = false 代表重試也不會好（金鑰、額度、模型設定），應該直接通知老師。 */
export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    readonly retryable: boolean,
    readonly detail: string,
  ) {
    super(`${AI_ERROR_REASON[kind]}｜${detail}`);
    this.name = "AiError";
  }
}

/** 依 HTTP 狀態與 OpenAI 的錯誤代碼分類。 */
export function classifyOpenAIError(status: number, body: string): AiError {
  let code = "";
  try {
    const e = (JSON.parse(body) as { error?: { code?: string; type?: string } }).error;
    code = e?.code || e?.type || "";
  } catch {
    // 不是 JSON 就只看狀態碼
  }
  const detail = `HTTP ${status}${code ? ` ${code}` : ""}`;
  if (status === 401 || status === 403) return new AiError("auth", false, detail);
  if (status === 429 && code === "insufficient_quota") return new AiError("quota", false, detail);
  if (status === 429) return new AiError("rate_limit", true, detail);
  if (status === 400 || status === 404 || status === 422) return new AiError("model", false, detail);
  if (status >= 500 || status === 408) return new AiError("server", true, detail);
  return new AiError("unknown", true, detail);
}

/** 產生解答草稿。Flex 遇到 429（資源不足）時自動改用標準方案重試一次。失敗時丟出 AiError。 */
/**
 * config：要用的模型與思考深度。沒給就讀 AI 設定（老師1 在審核介面設定的，沒設定則用預設值）。
 * 測試設定時會明確傳入 config，並關閉自動退回（allowFallback = false），才能如實反映新模型能不能用。
 */
export async function generateDraft(
  env: Env,
  input: DraftInput,
  options: { config?: AiConfigInput; allowFallback?: boolean } = {},
): Promise<DraftResult> {
  const config = options.config ?? (await getAiConfig(env));
  const hasImage = input.images.length > 0 || Boolean(input.contextImage);
  let model = hasImage ? config.modelImage : config.modelText;
  let effort = config.effort;
  const tier = env.OPENAI_SERVICE_TIER || null;
  const started = Date.now();

  let flexFallback = false;
  let modelFallbackFrom: string | undefined;
  const attempt = async () => {
    let resp = await callOnce(env, model, effort, tier, input);
    if (resp.status === 429 && tier === "flex") {
      flexFallback = true;
      resp = await callOnce(env, model, effort, null, input);
    }
    return resp;
  };

  let resp = await attempt();
  if (!resp.ok) {
    const err = classifyOpenAIError(resp.status, await resp.text());
    // 安全網：設定的模型被下架或設定錯 → 改用 wrangler.jsonc 的預設模型再試一次
    const d = defaultAiConfig(env);
    const fallbackModel = hasImage ? d.modelImage : d.modelText;
    if (options.allowFallback !== false && err.kind === "model" && (model !== fallbackModel || effort !== d.effort)) {
      modelFallbackFrom = model;
      model = fallbackModel;
      effort = d.effort;
      resp = await attempt();
      if (!resp.ok) throw classifyOpenAIError(resp.status, await resp.text());
    } else {
      throw err;
    }
  }

  const data = (await resp.json()) as {
    service_tier?: string;
    choices: { message: { content: string | null } }[];
    usage?: { prompt_tokens: number; completion_tokens: number; completion_tokens_details?: { reasoning_tokens?: number } };
  };
  const draft = JSON.parse(data.choices[0]?.message.content ?? "") as Draft;
  draft.answer = cleanAnswer(draft.answer);

  return {
    draft,
    meta: {
      model,
      serviceTier: data.service_tier ?? "unknown",
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      latencyMs: Date.now() - started,
      flexFallback,
      ...(modelFallbackFrom ? { modelFallbackFrom } : {}),
    },
  };
}
