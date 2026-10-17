# 交接手冊 — LINE 英文解題助手（Cloudflare 改寫）

> 最後更新：2026-10-17　目前階段：**Phase 2 完成（已部署、已實測發到 Telegram 測試群組），下一步 Phase 3**
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

## 2. 當前狀態（Current State）

| 項目 | 狀態 | 證據 |
|---|---|---|
| 型別檢查、單元測試 | ✅ 27/27 | `npm run typecheck`、`npm test`（新增 escapeHtml、splitText、行首空白清理） |
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

**Phase 3 — 審核與推播**：審核頁（§7.4 改善清單）、PIN 與裝置記憶（§7.3）、原子化審核、LINE 推播、重送、標已讀、`?generate=1` 補產生草稿、待審核清單。

## 4. 已知問題與待釐清（Issues / Blockers）

- ⚠️ 雲端目前的 `TELEGRAM_CHAT_ID` 是**測試群組**；正式上線（Phase 5）要改成正式導師群組
- ⚠️ 通知裡的「前往審核」「產生解答」按鈕目前會 404，審核頁在 Phase 3 實作
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
