import os
import httpx

LINE_API_BASE = "https://api.line.me/v2/bot"
LINE_DATA_BASE = "https://api-data.line.me/v2/bot"


def _auth_headers():
    token = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")
    return {"Authorization": f"Bearer {token}"}


async def get_user_profile(user_id: str) -> dict:
    """
    取得 LINE 用戶的顯示名稱等資料。
    回傳範例: {"displayName": "王小明", "userId": "U...", "pictureUrl": "..."}
    """
    url = f"{LINE_API_BASE}/profile/{user_id}"
    async with httpx.AsyncClient() as client:
        resp = await client.get(url, headers=_auth_headers())
        if resp.status_code == 200:
            return resp.json()
    return {"displayName": "未知用戶"}


async def download_image(message_id: str) -> bytes | None:
    """
    從 LINE 伺服器下載學生傳送的圖片。
    圖片有存取期限，必須盡快下載。
    """
    url = f"{LINE_DATA_BASE}/message/{message_id}/content"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers=_auth_headers())
        if resp.status_code == 200:
            return resp.content
    print(f"[LINE] 圖片下載失敗: message_id={message_id}, status={resp.status_code}")
    return None


async def push_message(user_id: str, text: str) -> bool:
    """透過 LINE Push API 將最終解答發送給學生。"""
    url = f"{LINE_API_BASE}/message/push"
    # LINE 單則文字訊息上限 5000 字
    payload = {
        "to": user_id,
        "messages": [{"type": "text", "text": text[:5000]}],
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, headers=_auth_headers(), json=payload)
        if resp.status_code != 200:
            print(f"[LINE] Push 發送失敗: {resp.status_code} {resp.text}")
            return False
    return True
