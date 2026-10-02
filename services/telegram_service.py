import os
import html
import httpx

# Telegram 單則文字上限 4096 字；預留標頭與審核連結的空間
_TEXT_LIMIT = 4096
_CHUNK_SIZE = 3500


def _get_config():
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
    return f"https://api.telegram.org/bot{token}", chat_id


def _esc(text: str | None) -> str:
    """跳脫 HTML 特殊字元，避免學生文字或 AI 解答中的 < > & 讓 Telegram 解析失敗。"""
    return html.escape(text or "", quote=False)


def _split_text(text: str, size: int = _CHUNK_SIZE) -> list[str]:
    """依換行切段，每段不超過 size 字（單行過長時硬切）。"""
    chunks, current = [], ""
    for line in text.split("\n"):
        while len(line) > size:
            if current:
                chunks.append(current)
                current = ""
            chunks.append(line[:size])
            line = line[size:]
        candidate = f"{current}\n{line}" if current else line
        if len(candidate) > size:
            chunks.append(current)
            current = line
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks or [""]


async def send_text_message(text: str) -> bool:
    """發送 HTML 格式訊息到 Telegram 群組（呼叫端須自行跳脫動態內容）。"""
    api_base, chat_id = _get_config()
    url = f"{api_base}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json=payload)
        if resp.status_code != 200:
            print(f"[Telegram] 文字訊息發送失敗: {resp.text}")
            return False
    return True


async def send_photo(image_bytes: bytes, caption: str = "") -> bool:
    """發送圖片到 Telegram 群組（caption 為純文字，限制 1024 字）。"""
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


def _review_link(review_url: str | None) -> str:
    if not review_url:
        return ""
    return f'\n\n👉 <a href="{html.escape(review_url, quote=True)}">點此進入審核頁面</a>'


async def _send_answer(student_name: str, ai_answer: str, review_url: str | None) -> None:
    """發送 AI 解答（過長時分段），審核連結附在最後一段。"""
    review_block = _review_link(review_url)
    chunks = _split_text(ai_answer)
    total = len(chunks)
    for i, chunk in enumerate(chunks, start=1):
        part = f"（{i}/{total}）" if total > 1 else ""
        msg = f"🤖 <b>AI 解答</b>{part}（學生：{_esc(student_name)}）\n\n{_esc(chunk)}"
        if i == total:
            msg += review_block
        await send_text_message(msg)


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
    文字問題：一則訊息搞定，過長時拆成提問＋解答。
    """
    if image_bytes:
        # 先發圖片 + 學生資訊（caption 不使用 parse_mode，免跳脫）
        photo_caption = f"📩 新學生提問\n👤 學生：{student_name}"
        if question_text:
            photo_caption += f"\n📝 附註：{question_text}"
        await send_photo(image_bytes, photo_caption)
        await _send_answer(student_name, ai_answer, review_url)
        return

    # 純文字問題
    review_block = _review_link(review_url)
    question_msg = (
        f"📩 <b>新學生提問</b>\n"
        f"👤 學生：{_esc(student_name)}\n"
        f"📝 問題：{_esc(question_text)}"
    )
    msg = (
        f"{question_msg}\n"
        f"━━━━━━━━━━━━━━━\n"
        f"🤖 <b>AI 解答：</b>\n\n{_esc(ai_answer)}{review_block}"
    )
    if len(msg) <= _TEXT_LIMIT:
        await send_text_message(msg)
        return

    for chunk in _split_text(question_text or ""):
        await send_text_message(
            f"📩 <b>新學生提問</b>\n👤 學生：{_esc(student_name)}\n📝 問題：{_esc(chunk)}"
        )
    await _send_answer(student_name, ai_answer, review_url)
