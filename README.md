# 英文導師 LINE 官方帳號

學生透過 LINE 傳送英文問題（文字或圖片） → Gemini AI 生成初版解答 → 雙導師於 Telegram 收到通知並透過網頁審核 → 審核通過後自動推播解答給學生。

## 系統架構

```
學生 (LINE)
    │ 傳送文字/圖片
    ▼
LINE Messaging API
    │
    ▼
FastAPI 後端 (Railway)
    ├─ 驗證 LINE 簽章
    ├─ 下載圖片 (有存取期限，立即處理)
    ├─ Gemini 2.5 Flash 生成 AI 解答
    ├─ 存入 Supabase DB
    └─ Telegram 推播給導師 (含審核頁面連結)
            │
            ▼
        導師點擊連結 → 網頁審核介面
            │ 編輯解答 → 送出
            ▼
        第一位通過 → approval_count = 1
        第二位通過 → approval_count = 2
            │
            ▼
        LINE Push API → 學生收到最終解答
```

## 技術堆疊

| 類別 | 技術 |
|------|------|
| 後端框架 | FastAPI (Python) |
| 學生端 | LINE Messaging API |
| AI 引擎 | Google Gemini 2.5 Flash |
| 導師通知 | Telegram Bot API |
| 審核介面 | Jinja2 HTML (深色主題) |
| 資料庫 | Supabase (PostgreSQL via PostgREST) |
| 部署 | Railway |

## 快速開始

### 1. 安裝依賴

```bash
python -m venv venv
venv\Scripts\activate      # Windows
# source venv/bin/activate  # macOS/Linux
pip install -r requirements.txt
```

### 2. 環境變數

複製範本並填入金鑰：

```bash
copy .env.example .env
```

| 變數 | 說明 | 取得方式 |
|------|------|---------|
| `LINE_CHANNEL_SECRET` | 簽章驗證 | LINE Developers → Basic settings |
| `LINE_CHANNEL_ACCESS_TOKEN` | 發送/接收訊息 | LINE Developers → Messaging API → Issue token |
| `GEMINI_API_KEY` | AI 解答 | Google AI Studio |
| `TELEGRAM_BOT_TOKEN` | 導師通知 | @BotFather |
| `TELEGRAM_CHAT_ID` | 導師群組 ID | 群組發訊後呼叫 `getUpdates` |
| `SUPABASE_URL` | 資料庫 URL | Supabase Dashboard → Project Settings |
| `SUPABASE_KEY` | service_role key | Supabase Dashboard → Settings → API Keys |
| `APP_BASE_URL` | 審核頁面的公開 URL | Railway 部署後填入，本地用 `http://localhost:8000` |
| `DEV_MODE` | 跳過 LINE 簽章驗證 | 開發時設 `true`，正式設 `false` |

### 3. 建立資料庫

前往 Supabase Dashboard → SQL Editor，執行 `setup_database.sql`。

### 4. 本地啟動

```bash
python -m uvicorn main:app --reload --port 8000
```

LINE Webhook 需公開網址，可使用 ngrok：

```bash
ngrok http 8000
# 將產生的 https://xxxx.ngrok.io/webhook 填入 LINE Developers Console
```

## 部署到 Railway

1. 前往 [railway.app](https://railway.app) → New Project → Deploy from GitHub Repo
2. 選擇此 repository
3. 在 Railway 專案設定 → Variables，逐一填入所有環境變數
4. 部署完成後，複製 Railway 提供的 Public Domain（如 `https://xxx.railway.app`）
5. 填入環境變數 `APP_BASE_URL = https://xxx.railway.app`
6. 將 `https://xxx.railway.app/webhook` 填入 LINE Developers Console → Messaging API → Webhook URL

## API 路由

| 路由 | 方法 | 說明 |
|------|------|------|
| `/` | GET | 健康檢查 |
| `/webhook` | POST | LINE Webhook 入口 |
| `/review/{id}` | GET | 導師審核頁面 |
| `/review/{id}` | POST | 提交審核結果 |

## 資料庫結構

```sql
questions 資料表
  id                    UUID        -- 主鍵，自動生成
  student_line_id       TEXT        -- 學生 LINE User ID
  student_name          TEXT        -- 學生顯示名稱
  question_type         TEXT        -- 'text' 或 'image'
  question_text         TEXT        -- 文字提問（nullable）
  question_image_base64 TEXT        -- 圖片 base64（nullable）
  ai_answer             TEXT        -- AI 初版解答
  final_answer          TEXT        -- 最終解答（導師可修改）
  approval_count        INTEGER     -- 0 → 1 → 2
  status                TEXT        -- pending → approved → sent
  created_at            TIMESTAMPTZ
```

## 流程狀態說明

| status | 說明 |
|--------|------|
| `pending` | 等待導師審核（0 或 1 位通過） |
| `approved` | 雙導師已通過，LINE Push 處理中 |
| `sent` | 解答已成功發送給學生 |

## 已知限制

- 圖片以 base64 存入 DB，大量使用後建議改用 Supabase Storage
- 審核頁面無身分識別，同一人可連點兩次（可加入簡易認證改善）
- 日誌使用 `print()`，正式環境可升級為 `logging` 模組
