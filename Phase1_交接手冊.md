# 英文導師 LINE 官方帳號 - Phase 1 交接手冊

## 專案概述

本專案是一套「學生透過 LINE 發問 → AI 生成解答 → 雙導師審核 → 回覆學生」的自動化英文教學輔助系統。

### 系統架構總覽

```
學生 (LINE)                    導師 (Telegram + 網頁)
    │                                │
    ▼                                │
LINE Messaging API                   │
    │                                │
    ▼                                │
┌──────────────────────────┐         │
│  FastAPI 後端 (Render)    │         │
│  ├─ /webhook (LINE)      │         │
│  ├─ /review/{id} (審核)  │         │
│  └─ Background Tasks     │         │
│       ├─ Gemini AI 解答   │───────▶│ Telegram 通知
│       └─ LINE Push 回覆   │◀───────│ 網頁審核送出
└──────────┬───────────────┘
           │
           ▼
     Supabase (PostgreSQL)
     問題/解答/審核狀態
```

### 技術堆疊

| 類別 | 技術 | 說明 |
|------|------|------|
| 後端框架 | FastAPI (Python) | 非同步 Web 框架 |
| 學生端 | LINE Messaging API | 學生透過 LINE 發問與接收回覆 |
| AI 引擎 | Google Gemini 2.5 Flash | 圖片 OCR + 英文解答生成 |
| 導師通知 | Telegram Bot API | 免費無限推播，通知導師審核 |
| 審核介面 | FastAPI 內建路由 + HTML | 輕量網頁，供導師編輯/批准解答 |
| 資料庫 | Supabase (PostgreSQL) | 儲存問題、解答、審核狀態 |
| 部署 | Render (Free Tier) | 免費雲端主機 |

---

## Phase 1 階段目標

完成基礎環境建置與 LINE Webhook 的非同步背景任務優化，確保收到 LINE 訊息時能立即回覆 HTTP 200 OK，避免因為 AI 處理時間過長導致 LINE 伺服器判定 Timeout 而觸發重發（Retry）機制，節省不必要的推播及運算資源浪費。

## Phase 1 完成項目清單

1. [x] **建立基礎專案架構**：完成 `main.py`、`requirements.txt`、`.gitignore` 等基本檔案。
2. [x] **實作 FastAPI Webhook**：加入 `/webhook` 路由，並整合 `line-bot-sdk` 的簽章驗證（開發環境暫時跳過阻擋以便測試）。
3. [x] **導入 Background Tasks**：將模擬高耗時的處理邏輯移至 `BackgroundTasks`，主程式接收並驗證後秒回 `{"status": "ok"}`。
4. [x] **工作流配置**：自動關聯全域工作流提供更好的自動化支援。

---

## 專案檔案結構

```
LINE官方帳號開發/
├── .agent/                  # 開發輔助工具（工作流等）
│   └── workflows/
├── .env.example             # 環境變數範本
├── .gitignore               # Git 忽略規則
├── main.py                  # 主程式入口（FastAPI 應用）
├── requirements.txt         # Python 依賴套件清單
└── Phase1_交接手冊.md        # 本文件
```

### 各檔案職責說明

#### `main.py`
- **FastAPI 應用實例**：建立 `app` 物件，標題為 `LINE Tutor Bot - Phase 1`
- **`GET /`**：健康檢查端點，回傳伺服器運行狀態
- **`POST /webhook`**：接收 LINE 平台的 Webhook 事件
  - 讀取 `X-Line-Signature` 標頭做簽章驗證
  - 使用 `WebhookParser` 解析事件
  - 將每個事件丟進 `BackgroundTasks` 非同步處理
  - 立即回傳 `200 OK`，避免 LINE 判定逾時重送
- **`process_line_event()`**：背景任務處理函式（目前為模擬，Phase 2 將替換為 Gemini AI 呼叫）

#### `requirements.txt`
```
fastapi        # Web 框架
uvicorn        # ASGI 伺服器
line-bot-sdk   # LINE Bot SDK (v3)
python-dotenv  # 讀取 .env 環境變數
```

#### `.env.example`
```env
LINE_CHANNEL_SECRET=your_channel_secret_here
LINE_CHANNEL_ACCESS_TOKEN=your_channel_access_token_here
```

---

## ⚠️ 已知限制與 TODO

1. **簽章驗證被 bypass**
   - 位置：`main.py` 第 39-43 行
   - 目前 `InvalidSignatureError` 被 catch 後只印出警告並跳過，`events` 會被設為空 list
   - **正式環境必須改回 `raise HTTPException(status_code=400)`**

2. **`process_line_event()` 是模擬的**
   - 目前只有 `asyncio.sleep(2)` 模擬耗時，Phase 2 將替換為真實 AI 處理邏輯

3. **尚未部署至雲端**
   - 缺少 `Procfile`（或 `render.yaml`），預計於 Phase 2 完成後設定 Render 部署

4. **缺少日誌系統**
   - 目前使用 `print()` 輸出，後續應改為 `logging` 模組以利正式環境除錯

---

## 開發環境建置教學

### 前置條件

- Python 3.10+
- 一個 LINE Official Account（見下方 LINE Developers Console 設定）
- Git（建議）

### 1. 安裝套件

請於專案目錄底下的終端機執行以下指令建立環境並安裝套件：
```bash
# 建立虛擬環境 (建議使用)
python -m venv venv

# 啟動虛擬環境 (Windows)
venv\Scripts\activate

# 安裝依賴套件
pip install -r requirements.txt
```

### 2. 環境變數設定

專案中已提供 `.env.example`。請複製或重新命名成 `.env`，並放入真實的 LINE Channel Secret：
```env
LINE_CHANNEL_SECRET=您的_Channel_Secret
LINE_CHANNEL_ACCESS_TOKEN=您的_Channel_Access_Token
```

### 3. 測試執行

輸入以下指令以啟動本地開發伺服器：
```bash
uvicorn main:app --reload --port 8000
```
成功啟動後，伺服器將執行在 `http://localhost:8000`。
- 可以使用瀏覽器開啟 `http://localhost:8000/` 確認伺服器狀態。
- 若需要公開至網際網路以讓 LINE 伺服器打 Webhook，可以使用 `ngrok`：
  ```bash
  ngrok http 8000
  ```
  然後將產生出來的 HTTPS 網址加上 `/webhook` 貼入到 LINE Developers Console 中即可。

---

## LINE Developers Console 設定指引

### 建立 LINE Official Account & Messaging API Channel

1. 前往 [LINE Developers Console](https://developers.line.biz/console/)
2. 使用你的 LINE 帳號登入
3. 建立一個 **Provider**（若尚未建立）
4. 在 Provider 下新增一個 **Messaging API Channel**
   - Channel type: `Messaging API`
   - 填入 Channel 名稱、描述等基本資訊
5. 建立完成後，在 **Basic settings** 頁面取得：
   - `Channel Secret` → 填入 `.env` 的 `LINE_CHANNEL_SECRET`
6. 在 **Messaging API** 頁面：
   - 點選 **Issue** 按鈕產生 `Channel Access Token (long-lived)` → 填入 `.env` 的 `LINE_CHANNEL_ACCESS_TOKEN`
   - 在 **Webhook URL** 欄位填入你的伺服器網址（如 `https://your-app.onrender.com/webhook` 或 ngrok 產生的網址 + `/webhook`）
   - 開啟 **Use webhook** 開關
   - 建議關閉 **Auto-reply messages**（在 LINE Official Account Manager 中設定），避免與 Bot 回覆衝突

---

## 分階段開發路線圖

### Phase 1: 基礎環境建置與 LINE Webhook ✅ 已完成
- 建立 FastAPI 專案骨架
- 實作 `/webhook` 路由 + 簽章驗證
- Background Tasks 非同步處理
- **驗證**：LINE 傳文字 → 伺服器印出訊息且不引起重試

### Phase 2: Gemini AI 處理與 Telegram 通知群組串接 ⏳ 下一步
- 實作下載 LINE 伺服器上的學生圖片
- 串接 Google Gemini 2.5 Flash API 產生解答
- 建立 Telegram Bot，推播 AI 解答到導師群組
- 完成後設定 Render 部署 + `Procfile`
- **驗證**：傳圖片給 LINE → Telegram 群組收到 AI 解答通知

### Phase 3: 資料庫 (Supabase) 與輕量網頁審核介面
- 連線 Supabase，建立 Questions 資料表
- 建置 `/review/{ticket_id}` 網頁路由（含文字編輯區）
- 導師可修改解答、標記審核通過
- **驗證**：Telegram 點連結 → 網頁修改內文 → 資料庫狀態更新

### Phase 4: 雙導師審核 + LINE Push 最終回覆
- 實作雙導師審核邏輯（兩位都通過才送出）
- 呼叫 LINE Push API 將最終解答推送給學生
- **驗證**：兩位導師都審核通過 → 學生 LINE 收到解答

---

## 下一步 (Phase 2 開發準備)

Phase 2 開始前需準備以下項目：

| 準備項目 | 說明 |
|---------|------|
| Google Gemini API Key | 前往 [Google AI Studio](https://aistudio.google.com/apikey) 取得 |
| Telegram Bot Token | 透過 [@BotFather](https://t.me/BotFather) 建立 Bot 並取得 Token |
| Telegram 群組 Chat ID | 建立導師群組 → 將 Bot 加入 → 取得群組 Chat ID |
| LINE Channel Access Token | 用於呼叫 LINE API 下載學生圖片（Phase 1 已取得） |
