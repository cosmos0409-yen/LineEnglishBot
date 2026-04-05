import os
import httpx


def _get_config():
    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_KEY", "")
    return (
        f"{url}/rest/v1",
        {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )


async def save_question(
    student_line_id: str,
    student_name: str,
    question_type: str,
    question_text: str | None,
    question_image_base64: str | None,
    ai_answer: str,
) -> dict | None:
    """將學生提問與 AI 解答存入資料庫，回傳新建的 record（含 id）。"""
    rest_url, headers = _get_config()
    payload = {
        "student_line_id": student_line_id,
        "student_name": student_name,
        "question_type": question_type,
        "question_text": question_text,
        "question_image_base64": question_image_base64,
        "ai_answer": ai_answer,
        "final_answer": ai_answer,
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{rest_url}/questions",
            headers=headers,
            json=payload,
        )
        if resp.status_code == 201:
            data = resp.json()
            return data[0] if isinstance(data, list) else data
        print(f"[Supabase] 儲存失敗: {resp.status_code} {resp.text}")
    return None


async def get_question(question_id: str) -> dict | None:
    """根據 ID 取得單筆提問記錄。"""
    rest_url, headers = _get_config()
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{rest_url}/questions",
            headers=headers,
            params={"id": f"eq.{question_id}", "select": "*"},
        )
        if resp.status_code == 200:
            data = resp.json()
            return data[0] if data else None
    return None


async def mark_as_sent(question_id: str) -> bool:
    """雙導師審核完成、LINE Push 成功後，將 status 更新為 'sent' 防止重複發送。"""
    rest_url, headers = _get_config()
    async with httpx.AsyncClient() as client:
        resp = await client.patch(
            f"{rest_url}/questions",
            headers=headers,
            params={"id": f"eq.{question_id}"},
            json={"status": "sent"},
        )
        return resp.status_code == 200


async def approve_question(question_id: str, edited_answer: str) -> dict | None:
    """
    導師審核通過：更新最終解答、遞增審核計數。
    當 approval_count >= 2 時，自動將 status 設為 'approved'。
    """
    rest_url, headers = _get_config()
    question = await get_question(question_id)
    if not question:
        return None

    new_count = question["approval_count"] + 1
    new_status = "approved" if new_count >= 2 else "pending"

    updates = {
        "final_answer": edited_answer,
        "approval_count": new_count,
        "status": new_status,
    }

    async with httpx.AsyncClient() as client:
        resp = await client.patch(
            f"{rest_url}/questions",
            headers=headers,
            params={"id": f"eq.{question_id}"},
            json=updates,
        )
        if resp.status_code == 200:
            data = resp.json()
            return data[0] if isinstance(data, list) and data else data
        print(f"[Supabase] 審核更新失敗: {resp.status_code} {resp.text}")
    return None
