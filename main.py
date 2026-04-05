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


async def process_event(event):
    """
    背景任務：處理單一 LINE 事件。
    1. 判斷訊息類型（文字/圖片）
    2. 取得學生 LINE 顯示名稱
    3. 呼叫 Gemini AI 產生解答
    4. 存入 Supabase 資料庫
    5. 推播到導師 Telegram 群組（含審核連結）
    """
    if not isinstance(event, MessageEvent):
        return

    user_id = event.source.user_id
    profile = await line_service.get_user_profile(user_id)
    student_name = profile.get("displayName", "未知用戶")

    image_bytes = None
    image_base64 = None
    user_text = None
    question_type = "text"

    if isinstance(event.message, ImageMessageContent):
        question_type = "image"
        image_bytes = await line_service.download_image(event.message.id)
        if not image_bytes:
            print("[Error] 圖片下載失敗，略過此事件")
            return
        image_base64 = base64.b64encode(image_bytes).decode("utf-8")

    elif isinstance(event.message, TextMessageContent):
        user_text = event.message.text

    else:
        print(f"[Info] 不支援的訊息類型: {event.message.type}")
        return

    # 呼叫 Gemini AI
    print(f"[Gemini] 開始處理 {student_name} 的提問...")
    ai_answer = await gemini_service.generate_answer(
        image_bytes=image_bytes,
        user_text=user_text,
    )
    print(f"[Gemini] 處理完成，解答長度: {len(ai_answer)} 字")

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
    return {"message": "LINE Tutor Bot Phase 3 Server is running"}


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
        background_tasks.add_task(process_event, event)

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


@app.post("/review/{ticket_id}", response_class=HTMLResponse)
async def review_submit(ticket_id: str, final_answer: str = Form(...)):
    """處理導師的審核提交。"""
    question = await supabase_service.get_question(ticket_id)
    if not question:
        raise HTTPException(status_code=404, detail="找不到此提問記錄")

    if question["status"] in ("approved", "sent"):
        template = templates.get_template("review.html")
        html = template.render(question=question, message="此提問已完成審核。")
        return HTMLResponse(content=html)

    # 執行審核
    updated = await supabase_service.approve_question(ticket_id, final_answer)

    if updated:
        question = await supabase_service.get_question(ticket_id)
        if question["approval_count"] >= 2:
            # 雙導師通過 → LINE Push 最終解答給學生
            push_text = (
                f"您好 {question['student_name']}！\n\n"
                f"您的問題已由兩位導師審核完成，以下是最終解答：\n\n"
                f"{question['final_answer']}"
            )
            success = await line_service.push_message(question["student_line_id"], push_text)
            if success:
                await supabase_service.mark_as_sent(ticket_id)
                question = await supabase_service.get_question(ticket_id)
                msg = "✅ 雙導師審核完成！解答已成功發送給學生。"
                print(f"[LINE] 已推播解答給學生: {question['student_name']}")
            else:
                msg = "⚠️ 雙導師審核完成，但 LINE 發送失敗，請聯繫管理員手動處理。"
        else:
            msg = "✅ 審核通過！等待第二位導師審核。"
    else:
        msg = "❌ 審核提交失敗，請稍後再試。"

    template = templates.get_template("review.html")
    html = template.render(question=question, message=msg)
    return HTMLResponse(content=html)
