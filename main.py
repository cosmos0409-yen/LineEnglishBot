import asyncio
import os
import base64
from fastapi import FastAPI, Request, BackgroundTasks, HTTPException, Form
from fastapi.responses import JSONResponse, HTMLResponse
from linebot.v3.webhook import WebhookParser
from linebot.v3.exceptions import InvalidSignatureError
from linebot.v3.webhooks import MessageEvent, TextMessageContent, ImageMessageContent
from dotenv import load_dotenv
from jinja2 import Environment, FileSystemLoader

from services import line_service, gemini_service, telegram_service, supabase_service

load_dotenv()

app = FastAPI(title="LINE Tutor Bot - Phase 4")

channel_secret = os.getenv("LINE_CHANNEL_SECRET", "YOUR_CHANNEL_SECRET")
parser = WebhookParser(channel_secret)

DEV_MODE = os.getenv("DEV_MODE", "false").lower() == "true"
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:8000")

# Jinja2 模板引擎
templates = Environment(loader=FileSystemLoader("templates"))

# ========== 10 秒訊息緩衝 ==========

_pending_messages: dict[str, list] = {}   # user_id → [events]
_pending_tasks: dict[str, asyncio.Task] = {}  # user_id → timer task


async def buffer_event(event):
    """
    將 LINE 事件加入緩衝區，並重新計時 10 秒。
    同一學生在 10 秒內的所有訊息（文字＋圖片）會合併成一筆處理。
    """
    if not isinstance(event, MessageEvent):
        return

    user_id = event.source.user_id
    _pending_messages.setdefault(user_id, []).append(event)

    old_task = _pending_tasks.get(user_id)
    if old_task and not old_task.done():
        old_task.cancel()

    _pending_tasks[user_id] = asyncio.create_task(
        _delayed_process(user_id, delay=10)
    )


async def _delayed_process(user_id: str, delay: int):
    """等待 delay 秒後，取出該學生的所有緩衝訊息並批次處理。"""
    await asyncio.sleep(delay)
    events = _pending_messages.pop(user_id, [])
    _pending_tasks.pop(user_id, None)
    if events:
        await _process_batch(user_id, events)


async def _process_batch(user_id: str, events: list):
    """
    批次處理同一學生的多則訊息：
    - 下載所有圖片（取第一張送 AI）
    - 合併所有文字
    - 呼叫 AI、存 DB、推播 Telegram
    """
    profile = await line_service.get_user_profile(user_id)
    student_name = profile.get("displayName", "未知用戶")

    image_bytes = None
    image_base64 = None
    text_parts = []
    question_type = "text"

    for event in events:
        if isinstance(event.message, ImageMessageContent):
            if image_bytes is None:
                # 只取第一張圖片
                image_bytes = await line_service.download_image(event.message.id)
                if image_bytes:
                    question_type = "image"
                    image_base64 = base64.b64encode(image_bytes).decode("utf-8")
                else:
                    print("[Error] 圖片下載失敗，略過")
        elif isinstance(event.message, TextMessageContent):
            text_parts.append(event.message.text)
        else:
            print(f"[Info] 不支援的訊息類型: {event.message.type}")

    user_text = "\n".join(text_parts) if text_parts else None

    if image_bytes is None and user_text is None:
        print(f"[Info] {student_name} 無有效訊息內容，略過")
        return

    # 呼叫 AI
    print(f"[OpenAI] 開始處理 {student_name} 的提問（共 {len(events)} 則訊息）...")
    ai_answer = await gemini_service.generate_answer(
        image_bytes=image_bytes,
        user_text=user_text,
    )
    print(f"[OpenAI] 處理完成，解答長度: {len(ai_answer)} 字")

    # 存入 Supabase
    record = await supabase_service.save_question(
        student_line_id=user_id,
        student_name=student_name,
        question_type=question_type,
        question_text=user_text,
        question_image_base64=image_base64,
        ai_answer=ai_answer,
    )

    if record:
        question_id = record["id"]
        review_url = f"{APP_BASE_URL}/review/{question_id}"
        print(f"[Supabase] 已儲存，ticket ID: {question_id}")
    else:
        review_url = None
        print("[Supabase] 儲存失敗，仍然推播到 Telegram（但無審核連結）")

    # 推播到 Telegram
    await telegram_service.notify_new_question(
        student_name=student_name,
        question_text=user_text,
        image_bytes=image_bytes,
        ai_answer=ai_answer,
        review_url=review_url,
    )
    print(f"[Telegram] 已推播 {student_name} 的提問與解答")


# ========== 路由 ==========


@app.get("/")
def root():
    return {"message": "LINE Tutor Bot Phase 4 Server is running"}


@app.post("/webhook")
async def handle_webhook(request: Request, background_tasks: BackgroundTasks):
    signature = request.headers.get("X-Line-Signature", "")
    body = await request.body()
    body_str = body.decode("utf-8")

    try:
        events = parser.parse(body_str, signature)
    except InvalidSignatureError:
        if DEV_MODE:
            print("[Dev] Invalid signature, bypassing for development")
            events = []
        else:
            raise HTTPException(status_code=400, detail="Invalid signature")

    for event in events:
        background_tasks.add_task(buffer_event, event)

    return JSONResponse(content={"status": "ok"})


@app.get("/review/{ticket_id}", response_class=HTMLResponse)
async def review_page(ticket_id: str):
    """審核頁面：顯示學生提問與 AI 解答，供導師編輯與審核。"""
    question = await supabase_service.get_question(ticket_id)
    if not question:
        raise HTTPException(status_code=404, detail="找不到此提問記錄")

    template = templates.get_template("review.html")
    html = template.render(question=question, message=None)
    return HTMLResponse(content=html)


FAST_APPROVE_PASSWORD = "fang0220"


async def _trigger_push_if_approved(ticket_id: str) -> tuple[dict, str]:
    """審核完成後觸發 LINE Push，回傳最新 question 與訊息。"""
    question = await supabase_service.get_question(ticket_id)
    if question["approval_count"] >= 2:
        push_text = question["final_answer"]
        success = await line_service.push_message(question["student_line_id"], push_text)
        if success:
            await supabase_service.mark_as_sent(ticket_id)
            question = await supabase_service.get_question(ticket_id)
            print(f"[LINE] 已推播解答給學生: {question['student_name']}")
            return question, "✅ 雙導師審核完成！解答已成功發送給學生。"
        else:
            return question, "⚠️ 雙導師審核完成，但 LINE 發送失敗，請聯繫管理員手動處理。"
    return question, "✅ 審核通過！等待另一位導師審核。"


@app.post("/review/{ticket_id}", response_class=HTMLResponse)
async def review_submit(
    ticket_id: str,
    final_answer: str = Form(...),
    approver: str = Form(""),
    bypass_password: str = Form(""),
):
    """處理導師的審核提交。"""
    question = await supabase_service.get_question(ticket_id)
    if not question:
        raise HTTPException(status_code=404, detail="找不到此提問記錄")

    if question["status"] in ("approved", "sent"):
        template = templates.get_template("review.html")
        html = template.render(question=question, message="此提問已完成審核。")
        return HTMLResponse(content=html)

    # 快速通過（密碼驗證）
    if bypass_password == FAST_APPROVE_PASSWORD:
        updated = await supabase_service.fast_approve(ticket_id, final_answer)
        if updated:
            question, msg = await _trigger_push_if_approved(ticket_id)
        else:
            question = await supabase_service.get_question(ticket_id)
            msg = "❌ 快速通過失敗（可能已完成審核）。"

    # 具名審核
    elif approver in ("cheng_jie", "tutor"):
        updated = await supabase_service.approve_by_role(ticket_id, approver, final_answer)
        if updated:
            question, msg = await _trigger_push_if_approved(ticket_id)
        else:
            question = await supabase_service.get_question(ticket_id)
            msg = "⚠️ 您已審核過此提問，或提問已完成審核。"

    else:
        question = await supabase_service.get_question(ticket_id)
        msg = "❌ 無效的審核操作。"

    template = templates.get_template("review.html")
    html = template.render(question=question, message=msg)
    return HTMLResponse(content=html)
