import { SYSTEM_PROMPT } from "./prompt";
import { cleanAnswer } from "./text";

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
  };
}

export interface DraftInput {
  text: string | null;
  images: { base64: string; contentType: string }[];
}

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "tutor_draft",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["question", "need_more_info", "non_question"] },
        answer: { type: "string" },
        tutor_note: { type: "string" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["kind", "answer", "tutor_note", "confidence"],
    },
  },
};

function buildUserContent(input: DraftInput) {
  const content: unknown[] = input.images.map((img) => ({
    type: "image_url",
    image_url: { url: `data:${img.contentType};base64,${img.base64}`, detail: "high" },
  }));
  // 只有圖片沒有文字時，仍要給模型一段文字，讓它判斷是否需要追問題號
  content.push({ type: "text", text: input.text ?? "（學生只傳了圖片，沒有附文字）" });
  return content;
}

async function callOnce(env: Env, model: string, serviceTier: string | null, input: DraftInput) {
  const body: Record<string, unknown> = {
    model,
    reasoning_effort: env.OPENAI_REASONING_EFFORT,
    response_format: RESPONSE_FORMAT,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserContent(input) },
    ],
  };
  if (serviceTier) body.service_tier = serviceTier;
  return fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 產生解答草稿。Flex 遇到 429（資源不足）時自動改用標準方案重試一次。失敗時丟出例外，交給 alarm 重試。 */
export async function generateDraft(env: Env, input: DraftInput): Promise<DraftResult> {
  const model = input.images.length > 0 ? env.OPENAI_MODEL_IMAGE : env.OPENAI_MODEL_TEXT;
  const tier = env.OPENAI_SERVICE_TIER || null;
  const started = Date.now();

  let flexFallback = false;
  let resp = await callOnce(env, model, tier, input);
  if (resp.status === 429 && tier === "flex") {
    flexFallback = true;
    resp = await callOnce(env, model, null, input);
  }
  if (!resp.ok) {
    throw new Error(`OpenAI ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
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
    },
  };
}
