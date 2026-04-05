import os
from google import genai
from google.genai import types

MODEL_NAME = "gemini-2.5-flash"

SYSTEM_PROMPT = """你是一位專業且經驗豐富的英文家教。

當學生傳送英文相關問題（文字或圖片）時，請直接給出完整詳解，包含：
1. 正確答案
2. 詳細的文法/語法解釋
3. 相關例句與用法說明
4. 如有易混淆的觀念，請額外補充說明

請使用繁體中文回答，英文單字/例句保持原文。
回答要清楚有條理，適合學生自學閱讀。"""

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
