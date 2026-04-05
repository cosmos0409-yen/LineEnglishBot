import os
import httpx


def _get_config():
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
    return f"https://api.telegram.org/bot{token}", chat_id


async def send_text_message(text: str) -> bool:
    """發送純文字訊息到 Telegram 群組。"""
    api_base, chat_id = _get_config()
    url = f"{api_base}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown",
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json=payload)
        if resp.status_code != 200:
            print(f"[Telegram] 文字訊息發送失敗: {resp.text}")
            return False
    return True


async def send_photo(image_bytes: bytes, caption: str = "") -> bool:
    """發送圖片到 Telegram 群組（caption 限制 1024 字）。"""
    api_base, chat_id = _get_config()
    url = f"{api_base}/sendPhoto"
    files = {"photo": ("student_question.jpg", image_bytes, "image/jpeg")}
    data = {"chat_id": chat_id}
    if caption:
        data["caption"] = caption[:1024]
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, data=data, files=files)
        if resp.status_code != 200:
            print(f"[Telegram] 圖片發送失敗: {resp.text}")
            return False
    return True


async def notify_new_question(
    student_name: str,
    question_text: str | None,
    image_bytes: bytes | None,
    ai_answer: str,
    review_url: str | None = None,
) -> None:
    """
    將學生提問與 AI 解答推播到導師 Telegram 群組。
    圖片問題：先發圖片（含學生名稱），再發 AI 解答 + 審核連結。
    文字問題：一則訊息搞定。
    """
    # 審核連結區塊
    review_block = f"\n\n👉 [點此進入審核頁面]({review_url})" if review_url else ""

    if image_bytes:
        # 先發圖片 + 學生資訊
        photo_caption = f"📩 新學生提問\n👤 學生：{student_name}"
        if question_text:
            photo_caption += f"\n📝 附註：{question_text}"
        await send_photo(image_bytes, photo_caption)

        # 再發 AI 解答 + 審核連結
        answer_msg = f"🤖 *AI 解答*（學生：{student_name}）\n\n{ai_answer}{review_block}"
        await send_text_message(answer_msg)
    else:
        # 純文字問題
        msg = (
            f"📩 *新學生提問*\n"
            f"👤 學生：{student_name}\n"
            f"📝 問題：{question_text}\n"
            f"━━━━━━━━━━━━━━━\n"
            f"🤖 *AI 解答：*\n\n{ai_answer}{review_block}"
        )
        if len(msg) > 4096:
            question_msg = (
                f"📩 *新學生提問*\n"
                f"👤 學生：{student_name}\n"
                f"📝 問題：{question_text}"
            )
            await send_text_message(question_msg)
            answer_msg = f"🤖 *AI 解答*（學生：{student_name}）\n\n{ai_answer}{review_block}"
            await send_text_message(answer_msg)
        else:
            await send_text_message(msg)
