# 交接手冊 — LINE 英文解題助手（Cloudflare 改寫）

> 最後更新：2026-11-22　目前階段：**Phase 5 正式營運中；11/22 學生分幾次傳的訊息併入同一題、審核頁送出前檢查草稿版本**
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

- **2026-10-28 部署**：
  - 介面「承傑／導師」改為「老師1／老師2」（`auth.ts` 的 `ROLE_LABEL` 一處管理）
  - 修正：AI 失敗（`kind` 為 NULL）的題目原本不會出現在待處理清單（SQL 的 NULL 比較），改用 `IFNULL`，並加單元測試
  - AI 設定頁 `/settings`（`settings.ts`、migration `0005_settings.sql`）：只有老師1 能修改；測試通過才能套用；模型失效自動退回預設並提醒
  - AI 錯誤分類：金鑰失效、額度用完、模型設定錯直接通知並寫明原因，不重試

- **2026-11-21 Telegram 通知補發**（version `5be6b7fd`，遠端已套用 `0006_notify_retry.sql`）：
  - 起因：業主回報「有時 TG 沒跳通知」。查 11/17–11/21 共 80 題：AI 全部成功、77 題在 6 秒內通知；但 11/18 晚上 Telegram 發送連續失敗，
    alarm 重試 6 次（約 4 分鐘）用完後整批卡在 DO，有 2 題分別延遲 13、43 小時才因學生再傳訊息而補發；
    卡住期間同一學生補傳的 2 則文字被併進舊批次而**沒有成為題目**（已請業主直接回覆該生）。失敗原因因 log 只留 3 天已查不到
  - `buffer.ts`：題目存好就清掉 pending，通知改由 `notify()` 發送，失敗只記錄、不丟例外 → 不再卡住或吞掉之後的訊息
  - `db.ts`：`claimNotify`（租約 3 分鐘，避免排程與緩衝區同時發）、`recordNotifyError`（失敗原因寫進 `questions.notify_error`、放掉租約）、`listUnnotified`
  - 每 5 分鐘 cron（`*/5 * * * *`）呼叫 DO 的 `retryNotify` 補發 2 天內還沒通知成功的題目；每日清理排程用 `DAILY_CRON` 區分
  - `telegram.ts`：429 照 `retry_after` 等待後重送（≤30 秒、最多 2 次），等更久的交給排程
  - 測試：單元 57 項全過（新增補發租約、補發清單、429 重送）；端對端新增「Telegram 故障」4 項全過

- **2026-11-22 分次傳訊息併入同一題**（version `d14681b0`，遠端已套用 `0007_merge.sql`）：
  - 起因：學生 HAO 傳照片後隔 43 秒才打說明（超過 30 秒緩衝），被拆成兩題：只有照片那題 AI 延續 20 分鐘前的舊話題答錯；
    有說明那題只看得到第二張照片，漏答第一張的 6、8 題
  - 併入規則（`db.ts` 的 `findMergeTarget`）：必須是該學生**最新一題**、`pending`、兩位老師都還沒按通過、和該題最後一則學生訊息相隔 ≤ 10 分鐘（`MERGE_WINDOW_MS`）
  - `buffer.ts`：`mergeBatch` 用這一題全部的照片（最多 4 張）與文字重寫草稿；`mergeIntoQuestion` 在同一個交易內更新並連結訊息，
    只在 `draft_version` 沒變、仍沒人通過時成功，否則改成另開一題。AI 失敗時保留原草稿只記錯誤。alarm 重跑以 `getQuestionByEvent` 判斷已處理
  - 只有照片、還沒打字時緩衝延長為 3 倍（`text.ts` 的 `bufferDelaySeconds`，正式環境 90 秒）
  - 通知（`notify_kind`）：`new` 新提問；`update` 一行靜音（`disable_notification`）寫出補傳了什麼，不重發照片；
    `upgrade`（原本非英文或 AI 失敗、補充後才有草稿）照新提問格式完整通知並標「學生補充後」
  - 審核頁：表單帶 `draft_version`、`seen_count`；版本不符時 `approve` 回 `draft_updated`，路由重新顯示頁面，保留老師內容、列出學生補傳的訊息與新版草稿。
    老師按「產生 AI 草稿」也會讓版本 +1。編輯框自動暫存在瀏覽器 localStorage（7 天），還原時若版本已變，送出會被擋下確認
  - Prompt 加「七、照片、前文與夾雜的訊息」（只有照片不延續舊話題、多張照片逐張對照、夾雜非英文事項寫進 tutor_note）；多張照片標上傳送順序
  - 每週健康檢查（Claude 排程任務 `line-tutor-weekly-health`，週六 21:00，唯讀，需使用者環境變數 `CF_READONLY_TOKEN`）加「草稿被大改的比例」
  - 測試：單元 70 項全過；端對端 67 項中 58 項通過，未過的 9 項都需要真實 AI（本機金鑰失效）；新增的併題、擋下送出、另開新題 7 項全過；內建瀏覽器實測自動暫存與擋下頁面

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

- ✅ 雲端 OpenAI 金鑰（11/4 後更換）運作正常：11/17–11/21 正式學生 80 題 AI 全部成功
- ⚠️ 本機 `cf/.dev.vars` 的 OpenAI 金鑰仍是失效的舊 key：端對端 62 項中需要真實 AI 的 9 項無法通過（AI 分類非英文、產生草稿、設定頁測試、自動退回），其餘 53 項全過
- ⚠️ AI 設定頁「測試通過 → 套用」與「模型失效自動退回」尚未用真實 OpenAI 驗證
- ✅ Phase 5 切換（11/4）：雲端 LINE 金鑰已換成業主正式帳號「非凡英文輔導專區」（`@220xefam`）；Webhook 指向本服務且開啟（LINE 官方 webhook 測試 200）；聊天模式開、已讀手動；方案為輕用量每月 200 則推播；`TELEGRAM_CHAT_ID` 已改為正式導師群組 `-5224723425`
- ⏳ Phase 5 剩餘：確認「自動回應訊息」已關、舊資料匯入決定、PIN 強度（正式學生已在使用：11/17 起每天都有提問與送出）
- ⚠️ 換成正式帳號後，使用者自己的測試官方帳號已無法使用（Webhook 簽章不符）；正式 Telegram 群組若升級為超級群組，ID 會改變（變成 -100 開頭），通知會失敗要重設

- 🚧 **wrangler 在中文路徑 `C:\LINE官方帳號開發` 會無聲結束（exit 127）**：2026-10-27 發現（10/18 還正常，可能是 Windows 更新）。複製到英文路徑可正常打包。
  暫時做法：`subst L: C:\LINE官方帳號開發` 後，在 `L:\cf` 執行 wrangler。subst 重開機後消失。長期做法：把專案搬到英文路徑，或設定開機自動 subst
- ⚠️ 本機 `wrangler dev`（workerd）同樣啟動即結束（0xC0000409），尚未確認從 `L:` 執行能否解決；`.claude/launch.json` 仍指向中文路徑
- ⚠️ OpenAI 金鑰已第三次失效（10/2、10/17、10/27）；GitHub 從未上傳過金鑰。請使用者到 OpenAI 後台確認到期設定與誰能管理金鑰
- ✅ AI 錯誤分類（10/27）：金鑰失效、額度用完、模型設定錯不再重試，Telegram 與審核頁直接寫明原因

- ⚠️ 老師對真正的非英文訊息強制「產生 AI 草稿」時，草稿可能不自然（例如「建議直接問老師」）；之後調整 Prompt
- ⚠️ 本機所有請求的 IP 都是 `local`：跑完 review-flow（會觸發鎖定）後要清 `login_failures` 才能手動登入
- ℹ️ 內建瀏覽器送表單時 Origin 是 `null`，所以 CSRF 改用 token；`Referrer-Policy` 用 `same-origin`（`no-referrer` 也會讓 Origin 變 null）
- ℹ️ bot（@AiTeacher0223bot）開著隱私模式：查群組 ID 時要在群組傳 `/start@AiTeacher0223bot`
- ⚠️ Telegram 通知發到一半失敗（例如照片已送、文字失敗）時，補發會整組重發，可能重複收到照片（不影響資料正確性）
- ⚠️ 併入同一題的限制：學生 10 分鐘內接著問不相關的問題也會併入（由老師一次回覆）；照片超過 4 張時多的不給 AI 看（補充通知會註明）；
  每次併入都重呼叫一次 AI（成本略增）；併入過的題目 `notified_at` 是最後一則補充通知的時間
- ℹ️ 待使用者處理：建立唯讀 Cloudflare API Token（D1 Read＋Account Analytics Read），存成使用者環境變數 `CF_READONLY_TOKEN` 並重開 Claude，每週健康檢查才讀得到雲端資料；
  也請業主在 LINE 歡迎訊息加「傳照片時請一起說明要問第幾題」
- ⚠️ 長草稿每段 3000 字再做 HTML 跳脫，大量 `&`、`<` 時可能超過 Telegram 4096 字上限而被截斷、格式錯誤（400）；目前沒發生過，`notify_error` 會記下
- ✅ 已修（11/21）：Telegram 最後一次重試仍失敗時整批卡在 pending、吞掉之後訊息的問題；改為每 5 分鐘排程補發 2 天內的題目
- ℹ️ 查通知失敗原因：`SELECT id, notify_attempts, notify_error FROM questions WHERE notify_error IS NOT NULL`（成功後會清空 `notify_error`）
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
