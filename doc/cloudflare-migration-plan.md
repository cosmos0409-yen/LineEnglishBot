# Cloudflare 改寫計畫（Railway → Cloudflare Workers）

> 建立：2026-10-02　狀態：**決策已全部定案，可以開始 Phase 1**（需使用者先建立 Cloudflare 帳號）

## 1. 背景與目標

- Railway 30 天試用於 2026-05-07 結束（GitHub 部署紀錄於當日轉為 `inactive`），之後的 Free plan 每月只有 $1 額度，不夠常駐 FastAPI。
- 目標：**月費 $0**、不休眠、維持現有功能（30 秒訊息合併 → AI 解答 → Telegram 通知 → 雙導師審核 → LINE Push），並順便修掉檢視報告中的 #3、#4、#6–#12。

## 2. 為何不能直接搬現有 Python 程式

| 現有做法 | 在 Workers 上的問題 | 改寫後 |
|---|---|---|
| `asyncio.create_task` + 記憶體 dict 做 30 秒緩衝 | Worker 用完即丟，記憶體不保留 | 每位學生一個 **Durable Object**，用 `setAlarm()` 計時 |
| FastAPI `BackgroundTasks` | Worker 回應後只剩 `waitUntil` 30 秒 | 重活交給 DO alarm（CPU 30 秒、wall time 15 分鐘） |
| Supabase（免費方案 7 天無活動暫停） | 低流量 bot 容易被暫停 | **D1**（SQLite，免費 5 GB，不會暫停） |
| 圖片 base64 存進 DB | 500 MB 約 370 張就滿 | **R2** 物件儲存（免費 10 GB） |
| Python SDK（openai、httpx） | Python Workers 對這些套件的支援未確認 | TypeScript + 原生 `fetch` |

## 3. 目標架構

```
學生 (LINE)
   │ webhook
   ▼
Worker（公開）
   ├─ POST /webhook ── 驗 X-Line-Signature（Web Crypto HMAC-SHA256，常數時間比較）
   │                   └─ 依 userId 轉給 Durable Object UserBuffer.enqueue(event)，立即回 200
   ├─ GET  /review/:id ─ 審核頁（需導師驗證，見 §7-D1）
   ├─ POST /review/:id ─ 原子化審核（單一 UPDATE … WHERE … RETURNING）
   ├─ POST /review/:id/resend ─ Push 失敗時重送
   └─ GET  /img/:key ── 從 R2 讀圖（需導師驗證）

Durable Object「UserBuffer」（每位學生一個，SQLite 後端）
   ├─ enqueue：事件寫入 DO storage，setAlarm(now + 30s)（每來一則就重設）
   └─ alarm()：取出整批 → 下載所有圖片存 R2 → OpenAI → 寫 D1 → Telegram 通知
              （全程冪等：以批次第一則的 webhookEventId 當 batch_id，D1 設 UNIQUE）

D1：questions 表　R2：學生圖片　Secrets：各金鑰
```

## 4. 免費額度檢查

| 資源 | 免費額度 | 本專案估計用量 |
|---|---|---|
| Workers 請求 | 100,000 / 天 | 每題約 3–10 次 |
| Worker CPU | 10 ms / 請求 | 只做驗簽、轉送、渲染 HTML，應足夠（Phase 1 實測） |
| DO 請求 | 100,000 / 天 | 每則訊息 1 次 + 每批 1 次 alarm |
| DO 執行時間 | 13,000 GB-s / 天 | 每批約 20 秒 × 0.128 GB ≈ 2.5 GB-s → 約 5,000 題/天 |
| DO CPU | 30 秒 / 請求（含 alarm） | base64 與 JSON 處理遠低於此 |
| D1 | 5 GB、每天 500 萬次讀 / 10 萬次寫 | 遠低於 |
| R2 | 10 GB 儲存 | 約 1 萬張照片；可設生命週期規則自動清理舊圖 |

> 真正的瓶頸是 **LINE 輕用量方案每月 200 則免費 Push**，不是 Cloudflare。

## 5. 資料表（D1）

```sql
CREATE TABLE questions (
  id               TEXT PRIMARY KEY,            -- UUID
  batch_id         TEXT NOT NULL UNIQUE,        -- 冪等鍵（第一則訊息的 webhookEventId）
  student_line_id  TEXT NOT NULL,
  student_name     TEXT NOT NULL DEFAULT '未知用戶',
  question_text    TEXT,
  image_keys       TEXT NOT NULL DEFAULT '[]',  -- R2 key 的 JSON 陣列（支援多張）
  ai_answer        TEXT,
  ai_status        TEXT NOT NULL DEFAULT 'ok',  -- ok / error（錯誤時不把錯誤文字當解答）
  ai_meta          TEXT,                        -- JSON：model、tokens、成本、延遲
  final_answer     TEXT,
  approver_cheng_jie INTEGER NOT NULL DEFAULT 0,
  approver_tutor     INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending → approved → sent / push_failed
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at          TEXT
);
CREATE INDEX idx_questions_status ON questions(status, created_at);

-- 對話前後文（§7.2）
CREATE TABLE messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  student_line_id  TEXT NOT NULL,
  role             TEXT NOT NULL,               -- student / teacher（已送出的最終解答）
  text             TEXT,
  image_key        TEXT,                        -- R2 key
  question_id      TEXT,                        -- 對應的 questions.id
  mark_as_read_token TEXT,                      -- LINE 標已讀用
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_student ON messages(student_line_id, created_at);
```

審核一律用原子更新，例如：
```sql
UPDATE questions
   SET approver_tutor = 1, final_answer = ?,
       status = CASE WHEN approver_cheng_jie = 1 THEN 'approved' ELSE 'pending' END
 WHERE id = ? AND status = 'pending' AND approver_tutor = 0
RETURNING *;
```
→ 只有拿到 `status='approved'` 的那一個請求負責 Push，徹底避免重複推播與卡在 1/2。

## 6. OpenAI 設定（全部用環境變數，可不改程式切換）

| 變數 | 預設 | 說明 |
|---|---|---|
| `OPENAI_MODEL_IMAGE` | `gpt-6.1-sol` | 有圖片（考卷）的提問；實測正確率最高 |
| `OPENAI_MODEL_TEXT` | `gpt-6-luna` | 純文字提問；單字、文法類，便宜模型就足夠 |
| `OPENAI_REASONING_EFFORT` | `medium` | none / low / medium / high / xhigh / max |
| `OPENAI_SERVICE_TIER` | `flex` | 半價；遇 429 資源不足時自動改用 standard 重試一次 |

- 使用 Structured Outputs，回傳 `{kind, answer, tutor_note, confidence}`，Prompt 見 [prompt-v2.md](prompt-v2.md)
- 程式後處理：移除中文句尾的「。」（luna 常不遵守格式規則）
- `tutor_note`／`confidence` 只當參考：實測時 luna 答錯仍標「高信心、無備註」，不能靠它篩掉審核

### 6.1 實測結果（2026-10-02）

測試資料：新莊、雄女高一第一次段考考卷（150 dpi 掃描檔），12 個圖片情境共 14 題，人工核對正解；另有 9 則取自真實紀錄的純文字訊息，用來測試分類。

| 設定 | 圖片題正確 | 訊息分類正確 | 中文句號違規 | 圖片題每題成本 | 平均秒數 |
|---|---|---|---|---|---|
| 現行 Prompt + gpt-5.4-mini | 10/14（翻譯題還答成中文） | 不適用 | 0 | $0.0028 | 3.5 |
| v2 + gpt-6-luna low | 13/14 | 9/9 | 16 | $0.0005 | 3.3 |
| v2 + gpt-6-luna medium | 13/14 | 9/9 | 9 | $0.0005 | 4.8 |
| v2 + gpt-6.1-sol medium | **14/14** | 9/9 | 1 | $0.0081 | 7.4 |

- luna 唯一錯的是分詞構句題（新莊第 25 題 restoring; to）
- 現行設定錯 4 題：25、29、雄女 22、翻譯題沒翻成英文
- 樣本小，而且是掃描檔不是手機照片。上線後應持續看導師的修改率

## 7. 決策紀錄

| # | 決策 | 狀態 |
|---|---|---|
| D1 | 審核頁驗證 | ✅ **每位導師一組 PIN**：承傑 `0001`、導師 `0002`，存在 Secrets，不寫進程式，可隨時更換。裝置記憶與畫面說明見 §7.3 |
| D2 | 快速通過 | ✅ 預設方案：以承傑身分登入時，多一個「直接通過（不等另一位）」選項，取代舊的獨立密碼 |
| D3 | 收件回覆 | ✅ **不做**（使用者：機械感太重）。老師打開審核頁時盡量呼叫 Mark as Read API 標已讀，失敗也不影響流程 |
| D4 | 舊資料 | ✅ 2026-10-02 已匯出到 `backup/supabase-questions-20261002.json`（146 筆、35 張照片，已驗證；資料夾已列入 .gitignore）。上線切換時匯入 D1 |
| D5 | R2 圖片保存期限 | ✅ **180 天**，用 R2 生命週期規則自動刪除 |
| D6 | 學生程度 | ✅ 國中會考、高中學測，中等程度（已寫進 Prompt） |
| D7 | 非題目訊息在 Telegram 的呈現 | ✅ **精簡通知**，見 §7.1 |
| D8 | 模型 | ✅ 有圖片用 gpt-6.1-sol，純文字用 gpt-6-luna，見 §6 |

### 7.1 非題目訊息的處理原則：絕不靜默丟棄

真實紀錄約一半是閒聊或課務（點飲料、報學號、聊睡眠），以前全部都產生 AI 解答並推到 Telegram，造成雜訊。新設計：

1. **分類在同一次 AI 呼叫內完成**（`kind` 欄位），不另外花錢
2. **拿不準一律當題目**：Prompt 明訂「寧可多寫一份草稿，也不能漏掉學生的問題」。實測 9/9 正確，包括夾雜閒聊的提問
3. **被判成非題目也不會消失**：
   - 訊息本來就在 LINE 官方帳號後台的聊天室，老師照常看得到
   - Telegram 改發一行精簡通知（學生名稱＋訊息前 50 字），附「產生解答」按鈕，老師覺得是題目時按一下就能補產生草稿
4. **need_more_info**（例如「那這題呢」沒附圖）：產生一句追問的草稿，一樣要老師審核才會送出

### 7.2 對話前後文

舊交接手冊說「30 秒緩衝合併」解決了前後文問題，但它只能合併「同時傳的圖片加文字」。備份資料顯示，追問常在前一張考卷照片之後 0–5 分鐘出現，最長約 40 分鐘，例如：
- 「還有30題😆」
- 「第2為什麼不能用persuade，第15為什麼不能用ensure」

這些訊息都超過 30 秒，會被當成新的一批獨立處理，AI 看不到考卷。新設計分三層：
1. **保留 30 秒緩衝**：處理同時傳的圖片加文字
2. **D1 新增 `messages` 表**：保存每位學生的訊息（含圖片的 R2 key）與已送出的最終解答
3. **呼叫 AI 時附上前文**：同一位學生最近 60 分鐘內的對話，最多 8 則。學生訊息當 user、已送出的解答當 assistant
   - 本批沒有圖片、但前文有 → 自動附上最近一張圖片，並改用圖片模型

實測（2026-10-02）：「那25呢」「那 for 呢」沒有前文時，兩個模型都回 need_more_info（會反問，不亂猜）；附上前文後都正確回答。

已知限制：老師在 LINE 官方帳號後台手動回的訊息不會經過 webhook，AI 看不到。

### 7.3 PIN 與裝置記憶

- **第一次打開審核頁**：只顯示 PIN 輸入框，說明文字：「第一次使用請輸入你的 PIN。之後這台手機／電腦會記住你，一年內不用再輸入」
- **記憶方式**：簽章過的 Cookie（HttpOnly、Secure、SameSite=Lax），有效期 365 天，內容含身分與 PIN 版本。更換 PIN 後，所有裝置自動登出
- **登入後頁首常駐**：「👤 目前身分：承傑（這台裝置已記住）［不是我？切換身分］」
- **按鈕只顯示自己的**：例如「✅ 以承傑身分通過」；另一位的審核狀態只顯示、不能按
- **注意**：Telegram 內建瀏覽器和手機瀏覽器（Chrome、Safari）的記憶是分開的，在兩邊都用的話，各要輸入一次。這點也寫進畫面說明
- **防猜測**：同一 IP 輸錯 5 次鎖 15 分鐘
- **安全提醒**：`0001`、`0002` 很好猜，拿到審核連結的人試一下就能進去。因為有裝置記憶，每台裝置只要輸入一次，改成 6 位隨機數字幾乎不增加麻煩。PIN 存在 Secrets，隨時可以換，不用改程式

## 8. 執行階段

### Phase 0 — 前置準備（使用者）
- 建 Cloudflare 帳號；安裝 Node.js LTS（`wrangler` 需要）
- ~~換發新的 OpenAI API key~~（2026-10-02 已完成）；在 OpenAI 後台設定每月花費上限
- ~~確認 Supabase 專案狀態~~（已恢復）；~~匯出備份~~（2026-10-02 已完成）
- ~~回覆 §7 決策點~~（已全部定案）
- 確認 LINE 官方帳號後台「聊天」功能為開啟（標已讀需要）
- **新的快速通過密碼**（舊的已公開在 GitHub 歷史中，必須作廢）

### Phase 1 — POC 與 Go/No-Go 關卡
- `cf/` 目錄建 Worker（TypeScript + Hono + wrangler）
- 打通：LINE 驗簽 → DO 緩衝 30 秒 → 下載 1 張圖 → OpenAI → 印出結果
- 用 `wrangler tail` 量 CPU 時間；確認 Worker 端 < 10 ms
- **關卡**：CPU 或任一額度不符 → 停下回報，不硬做

### Phase 2 — 核心管線
- D1 schema 與 migration、R2 bucket
- 多圖支援、AI 失敗時 `ai_status='error'` 並通知導師（不把錯誤文字當解答）
- Telegram 通知（HTML 跳脫、長訊息切段，沿用 Python 版修正後的邏輯）
- 訊息分類與非題目處理（§7.1）、對話前後文（§7.2）
- 社交回應過濾：沿用現有正則，並放寬到允許結尾帶 emoji（例如「謝謝老師🙏🙏」）
- 冪等：DO alarm 重試不會重複寫入或重複通知

### Phase 3 — 審核與推播
- 審核頁（伺服器端渲染，全面 HTML 跳脫）＋ PIN 登入、裝置記憶與畫面說明（§7.3）
- Telegram 非題目精簡通知，附「產生解答」按鈕（§7.1）
- 原子化審核、Push 失敗可重送（`push_failed` 狀態 + 按鈕）
- 超過 5,000 字的解答拆成多個訊息泡泡（單次 Push 最多 5 個）
- 老師打開審核頁時呼叫 LINE Mark as Read API（`markAsReadToken` 存在 DO 或 D1，不會過期）。前提：官方帳號後台「聊天」功能要開著

### Phase 4 — 測試與預演
- `vitest` + `@cloudflare/vitest-pool-workers` 單元與整合測試（驗簽、緩衝合併、冪等、原子審核、跳脫）
- 用一個**測試用 LINE channel**走完整流程

### Phase 5 — 上線切換
- 正式部署 → LINE Developers Console 改 Webhook URL → 觀察 48 小時
- 依 D4 匯入或捨棄舊資料
- 關掉 LINE 後台的暫停公告自動回應

### Phase 6 — 清理
- 移除 Python 版（`main.py`、`services/`、`Procfile`、`railway.toml`、`requirements.txt`），改版前打 git tag `python-final` 保留
- 移除與本專案無關的 `.agent/workflows/`（先確認用途）

### Phase 7 — 更新規格文件
- `doc/handover.md` — **新增**（用 `handover-writer` skill；合併並取代根目錄的 `交接手冊.md`、`Phase1_交接手冊.md`）
- `README.md` — **更新**（架構、技術堆疊、部署流程改為 Cloudflare，環境變數表）
- `CLAUDE.md` — **新增**（專案目前沒有；放指令、目錄結構、硬性約束，例如「密碼一律走 Secrets」「所有動態內容必須跳脫」）
