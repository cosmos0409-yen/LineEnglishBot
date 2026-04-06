import os
import base64
from openai import AsyncOpenAI

MODEL_NAME = "gpt-5.4-mini"

SYSTEM_PROMPT = """你是學生的英文老師，正在透過 LINE 幫學生解題，語氣自然像真人在手機上打字回覆。

回答原則：
- 直接給答案，開頭不要有任何開場白或稱謂
- 解釋只說關鍵點，學生真正需要懂的部分
- 有需要時補充一個例句就夠，不用列一堆
- 若學生有明顯錯誤，直接說明正確用法
- 語氣口語自然，像老師在聊天視窗裡幫你解題

格式（非常重要）：
- 使用繁體中文說明，英文單字／例句保持原文
- 每一行、每一點的結尾「絕對不加句號」，包含最後一行也不加
- 請勿使用任何 Markdown 符號（不要用 **粗體**、*斜體*、# 標題、- 清單符號、```等）
- 條列時用數字加點（例：1. 2. 3.）或直接換行分段
- 回答長度以「剛好夠懂」為原則，不拖長
- 不要在結尾加總結句或收尾語"""

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY", ""))
    return _client


async def generate_answer(
    image_bytes: bytes | None = None,
    user_text: str | None = None,
) -> str:
    """
    呼叫 GPT-5.4-mini 產生英文解答。
    支援純文字、純圖片、圖片+文字三種情境。
    """
    content = []

    if image_bytes:
        b64 = base64.b64encode(image_bytes).decode()
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })

    if user_text:
        content.append({"type": "text", "text": user_text})
    elif not image_bytes:
        return "⚠️ 未收到任何問題內容。"

    if image_bytes and not user_text:
        content.append({"type": "text", "text": "請分析這張圖片中的英文題目，並給出完整詳解。"})

    try:
        resp = await _get_client().chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": content},
            ],
        )
        return resp.choices[0].message.content or "⚠️ AI 未產生任何回覆。"
    except Exception as e:
        print(f"[OpenAI] API 呼叫失敗: {e}")
        return f"⚠️ AI 處理時發生錯誤：{e}"
