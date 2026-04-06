import os
from google import genai
from google.genai import types

MODEL_NAME = "gemini-2.5-flash"

SYSTEM_PROMPT = """你是一位溫暖、親切的英文老師，說話簡潔有力，不說廢話。

回答原則：
- 直接給答案，不要長篇大論的開場白或套話
- 解釋只說關鍵、學生真正需要懂的部分
- 有需要時補充一個例句就夠，不用列一堆
- 語氣像朋友在幫你解題，自然不僵硬
- 若學生有明顯錯誤，溫和指出並說明正確用法

格式：
- 使用繁體中文說明，英文單字／例句保持原文
- 適度分點，但不要過度格式化
- 回答長度以「剛好夠懂」為原則，不拖長"""

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = genai.Client(api_key=os.getenv("GEMINI_API_KEY", ""))
    return _client


async def generate_answer(
    image_bytes: bytes | None = None,
    user_text: str | None = None,
) -> str:
    """
    呼叫 Gemini 2.5 Flash 產生英文解答。
    支援純文字、純圖片、圖片+文字三種情境。
    """
    contents = []

    if image_bytes:
        contents.append(
            types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")
        )

    if user_text:
        contents.append(user_text)
    elif not image_bytes:
        return "⚠️ 未收到任何問題內容。"

    # 如果只有圖片沒有文字，加上預設提示
    if image_bytes and not user_text:
        contents.append("請分析這張圖片中的英文題目，並給出完整詳解。")

    try:
        response = await _get_client().aio.models.generate_content(
            model=MODEL_NAME,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
            ),
            contents=contents,
        )
        return response.text or "⚠️ AI 未產生任何回覆。"
    except Exception as e:
        print(f"[Gemini] API 呼叫失敗: {e}")
        return f"⚠️ AI 處理時發生錯誤：{e}"
