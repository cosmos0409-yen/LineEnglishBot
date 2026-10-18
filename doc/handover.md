# 交接手冊 — LINE 英文解題助手（Cloudflare 改寫）

> 最後更新：2026-10-18　目前階段：**Phase 4 完成（使用者確認：手機收到解答、已讀正常），下一步 Phase 5 正式上線（待使用者裁決）**
> 完整計畫與決策：[cloudflare-migration-plan.md](cloudflare-migration-plan.md)　Prompt：[prompt-v2.md](prompt-v2.md)
> 根目錄的 `交接手冊.md`、`Phase1_交接手冊.md` 是 Python 舊版的文件，Phase 7 會合併後移除

## 1. 已完成（Done）

- **Python 舊版安全修補**（commit `6c76a8e`）與 **Supabase 備份**（`backup/`，git 已忽略）
- **Phase 1 POC**：webhook 驗簽 → `StudentBuffer` DO 30 秒緩衝 → 下載圖片 → OpenAI 草稿；實測 CPU 全部在免費方案內
- **Phase 2 核心流程**（已部署到 https://line-tutor.cosmos0409.workers.dev ，含每日 cron）：
  - D1 `DB`（`questions`、`messages`）與 D1 `IMAGES_DB`（照片切塊存放）；migration 在 `cf/migrations/{main,images}/`，**本機與遠端都已套用**
  - 照片改存 D1：R2 要綁信用卡，使用者選擇不綁（決策 D9）。每天 03:00（台灣）cron 刪除 180 天前的照片
  - `buffer.ts`：每一步都可重跑（訊息 event_id 去重、提問 batch_id 去重、已通知不重發）；AI 重試 6 次都失敗 → 存成 `ai_status='error'` 並通知老師
  - 對話前後文：同一學生最近 60 分鐘、最多 8 則；本批沒照片但前文有 → 補上最近一張照片並改用圖片模型
  - `telegram.ts`：題目通知（照片＋草稿＋給老師的備註＋「前往審核」按鈕）、非題目精簡通知（「產生解答」按鈕）、AI 失敗警告；全部 HTML 跳脫、長文分段
  - 模擬器新增假 Telegram 伺服器，以及 `SIM_SCENARIO=bigimage|fail`
- **Phase 3 審核與推播**（已部署，version `3af8c517`；遠端已套用 `0002_review.sql`，已設 `SESSION_SECRET`）：
  - `auth.ts`：PIN 登入、簽章 Cookie（365 天，換 PIN 自動登出）、同 IP 錯 5 次鎖 15 分鐘、CSRF token
  - `review.ts`：原子化審核（單一 UPDATE … RETURNING）、推播（固定 retry key，重送不重複）、標已讀、待審核清單、前文
  - `pages.ts`／`html.ts`／`static.ts`：登入頁、待審核清單、審核頁（§7.4 的 14 項改善），`html```` 自動跳脫、CSP、靜態檔依內容加版本號
  - DO 新增 `getImage`、`regenerate`（照片轉換與重新產生的 CPU 放在 DO，不放在只有 10 ms 的 Worker）
  - 老師按「產生 AI 草稿」時，schema 拿掉 non_question，保證一定寫出草稿
  - 已送出的老師解答記成 `messages(role='teacher')`，之後的追問會帶入前文
- **介面改用線條圖示**（`icons.ts`，使用者要求少用 Emoji）；Telegram 通知改用粗體標題，不用 Emoji
- **按學生分類**（決策 D10，遠端已套用 `0003_students.sql`）：
  - `students.ts`：`students` 表以 LINE userId 為主鍵；老師可設定備註名稱與班級（可留空），學生改暱稱不影響
  - `/students` 學生清單、`/students/:id` 學生頁（設定備註＋完整提問紀錄）、`/queue?student=` 篩選
  - 清單、審核頁、Telegram 通知都改用備註名稱（沒設定就用 LINE 暱稱）
- **非英文訊息分流**（使用者要求，遠端已套用 `0004_dismiss.sql`）：
  - 待處理清單與學生的待處理數不含「AI 判斷為非英文、還沒人處理」的訊息；改放在清單下方的收合區
  - 一鍵「不需回覆」（status `dismissed`，記錄 `dismissed_by`、`dismissed_at`）、全部標記、改回待處理；一般題目也可標記（例如已在 LINE 直接回了）
- **Phase 4 接上真實 LINE**（2026-10-18）：使用者自己的測試用官方帳號，Webhook 指向 workers.dev；手機實測「我想要問第16提」直接通過並推播成功
- **雲端測試資料已清除**：刪除 ID 含 `_` 的模擬學生（3 題、4 則訊息、3 位學生）；保留使用者手機的真實測試

## 2. 當前狀態（Current State）

| 項目 | 狀態 | 證據 |
|---|---|---|
| 型別檢查、單元測試 | ✅ 39/39 | `npm run typecheck`、`npm test`（Phase 3 新增 Cookie、PIN、html 跳脫、台灣時間、LINE 分則） |
| 審核流程端對端 | ✅ 47/47（連跑兩次穩定；含學生分類、不需回覆） | `node scripts/review-flow.mjs`：登入／鎖定、CSRF、Origin、XSS、同時通過只推一次、推播失敗重送同 key、產生草稿、前文含老師解答 |
| 手機尺寸實際操作 | ✅ | 內建瀏覽器 375px：登入、清單、審核頁（照片、前文、還原、字數、直接通過） |
| 雲端 Phase 3 | ✅ 冒煙測試 | `/` 回 phase 3、未登入 `/queue` → 303 登入頁、樣式檔 200；**PIN 尚未設定，目前誰都登不進去（fail closed）** |
| 合併、去重、社交略過、簽章、驗證按鈕 | ✅ | 模擬器 S1–S7，結果與 Phase 1 相同 |
| 寫入 D1 | ✅ | 6 筆提問的 kind、模型、通知狀態都正確；重送的訊息只存 1 筆 |
| Telegram 通知內容 | ✅（假伺服器） | 題目、需要補資訊、非題目、AI 失敗四種格式都正確，按鈕網址正確 |
| 對話前後文 | ✅ | 傳考卷問 29 → 20 秒後問「那25呢」→ 自動補上照片，sol 答「25. D restoring；to」（正解） |
| 大照片切塊 | ✅ | 1.75 MB 照片切 2 塊，存回位元組數完全相同；追問「那12題呢」讀回後答「12. B gamble」 |
| AI 最終失敗 | ✅ | 模型故意設錯：retryCount 0→6，接著存成 error 並發「⚠️ AI 處理失敗」 |
| 部署 Phase 2 | ✅ | 雲端 secrets：LINE（測試值）、OpenAI、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`（測試群組「測試用」） |
| 雲端 → 真實 Telegram | ✅ | 部署版 3 則文字情境，遠端 D1 的 `notified_at` 都有值 |
| 含照片 → 真實 Telegram | ✅ | 本機改用真實 token 和測試群組跑完整情境：6 則通知第一次就成功（retryCount 0），沒有錯誤 |

Python 舊版：程式仍在 repo，沒有部署。LINE Webhook 仍指向已停止的 Railway。

## 3. 下一步（Next）

**Phase 3 剩餘**：
1. ~~設定 PIN~~（2026-10-18 已完成）
2. 👤 用手機從 Telegram 測試群組的「前往審核」按鈕進入 → 輸入 PIN → 審核（雲端 LINE 是測試金鑰，推播會顯示「推播失敗」，屬正常）

**Phase 4 — 預演**：使用者開自己的測試用 LINE 官方帳號 → 換上真實 LINE 金鑰 → 兩位導師用手機實際走完「學生提問 → 審核 → 收到解答」。

## 4. 已知問題與待釐清（Issues / Blockers）

- ⚠️ 雲端目前的 `TELEGRAM_CHAT_ID` 是**測試群組**；正式上線（Phase 5）要改成正式導師群組
- ⚠️ 雲端 LINE 金鑰仍是測試值：推播與標已讀在 Phase 4 換上真實測試帳號前都會失敗
- ⚠️ 老師對真正的非英文訊息強制「產生 AI 草稿」時，草稿可能不自然（例如「建議直接問老師」）；之後調整 Prompt
- ⚠️ 本機所有請求的 IP 都是 `local`：跑完 review-flow（會觸發鎖定）後要清 `login_failures` 才能手動登入
- ℹ️ 內建瀏覽器送表單時 Origin 是 `null`，所以 CSRF 改用 token；`Referrer-Policy` 用 `same-origin`（`no-referrer` 也會讓 Origin 變 null）
- ℹ️ bot（@AiTeacher0223bot）開著隱私模式：查群組 ID 時要在群組傳 `/start@AiTeacher0223bot`
- ⚠️ Telegram 中途失敗時，alarm 重試會整組重發，可能重複收到照片或訊息（不影響資料正確性）
- ⚠️ Telegram 在最後一次重試仍失敗時，該批會留在 DO 的 pending，等同一學生下次傳訊息才再處理，而且沒有其他通知管道
- ⚠️ 照片 D1 免費上限 500 MB：依過去用量，180 天約 160 MB。用量變大時，改用 R2 或多開一個 D1
- 本機 `cf/.wrangler/state` 保留模擬資料，需要時可刪除

## 5. 測試指南（Testing）

PowerShell 寫法（使用者的終端機是 PowerShell 5.1，不支援 `&&`），都在 `cf/` 目錄內執行：

```powershell
npm install; npm run types
```

```powershell
Copy-Item .dev.vars.example .dev.vars   # 再填入 OPENAI_API_KEY；LINE、Telegram 預設送到假伺服器
```

```powershell
npm run typecheck; npm test
```

```powershell
npx wrangler d1 migrations apply DB --local; npx wrangler d1 migrations apply IMAGES_DB --local
```

本機端對端模擬（開兩個終端機）：

```powershell
npx wrangler dev --ip 127.0.0.1 --port 8787
```

```powershell
$env:SIM_IMAGE_DIR="<放 xz_p1.jpg、xz_p2.jpg、xn_p1.jpg 的資料夾>"; node scripts/simulate.mjs
```

- 程式最後會印出假 Telegram 收到的每一則通知；Worker Log 看 `batch_processing`、`question_saved`、`telegram_notified`
- `$env:SIM_SCENARIO="bigimage"`：需要資料夾裡有 `big.jpg`（>1 MB）
- `$env:SIM_SCENARIO="fail"`：搭配 `npx wrangler dev --var OPENAI_MODEL_TEXT:no-such-model`，約 3 分鐘
- `$env:SIM_IMAGE_404="1"`：模擬 LINE 圖片下載失敗
- 對部署版：設 `SIM_WORKER_URL`、`SIM_LINE_SECRET`（`cf/.sim-secret` 的內容）、`SIM_SKIP_IMAGES=1`
- 考卷圖片可用 PyMuPDF 從 `考卷例題/` 的 PDF 轉成 150 dpi JPG
