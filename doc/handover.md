# 交接手冊 — LINE 英文解題助手（Cloudflare 改寫）

> 最後更新：2026-10-17　目前階段：**Phase 1（POC）本機部分完成，等使用者完成 3 個前置動作才能部署實測**
> 完整計畫與決策：[cloudflare-migration-plan.md](cloudflare-migration-plan.md)　Prompt：[prompt-v2.md](prompt-v2.md)
> 根目錄的 `交接手冊.md`、`Phase1_交接手冊.md` 是 Python 舊版的文件，Phase 7 會合併後移除

## 1. 已完成（Done）

- **Python 舊版安全修補**（2026-10-02，commit `6c76a8e`）：快速通過密碼改讀環境變數、審核頁 autoescape、Telegram 改 HTML 跳脫並自動分段
- **資料備份**：`backup/supabase-questions-20261002.json`（146 筆、35 張照片，已驗證；git 已忽略）
- **Phase 1 本機 POC**（`cf/`，尚未 commit、尚未部署）：
  - `src/index.ts`：`GET /` 健康檢查；`POST /webhook` 驗證 LINE 簽章後，依 userId 交給 Durable Object
  - `src/buffer.ts`：`StudentBuffer`（SQLite DO）負責 30 秒緩衝，`alarm()` 依序做社交過濾、取暱稱、下載圖片、呼叫 OpenAI，結果寫 Log
    - 同一事件重送會自動去重（`event_id UNIQUE`）
    - 只處理快照、成功後才刪除；失敗由 alarm 自動重試，訊息不遺失
    - 圖片下載失敗會丟例外重試，只有最後一次重試才不帶圖片繼續
  - `src/openai.ts`：有圖片用 `OPENAI_MODEL_IMAGE`，沒圖片用 `OPENAI_MODEL_TEXT`；Structured Outputs；Flex 遇 429 改用標準方案重試一次
  - `src/text.ts`：中文句號清理、社交回應過濾（允許 emoji）、base64
  - `src/prompt.ts`：Prompt v2（之後以此為準）
  - `scripts/simulate.mjs`：假 LINE API ＋ 簽章 webhook 的本機模擬器

## 2. 當前狀態（Current State）

| 項目 | 狀態 | 證據 |
|---|---|---|
| TypeScript 型別檢查 | ✅ | `npm run typecheck` |
| 單元測試 | ✅ 23/23 | `npm test`：簽章、句號清理、社交過濾、base64 |
| 簽章錯誤回 401、空 events 回 200 | ✅ | 模擬器 S6、S7 |
| 文字＋圖片 1 秒內連傳合併成一批 | ✅ | Log：batchSize 2、imageCount 1 |
| LINE 重送去重 | ✅ | S5 兩次送同一事件，batchSize 1 |
| 社交回應略過 | ✅ | 「謝謝老師🙏🙏」→ `batch_skipped_social` |
| 失敗自動重試、不遺失 | ✅ | retryCount 0→4 遞增 |
| 圖片下載失敗不硬做 | ✅ | `SIM_IMAGE_404=1` 時拋出「圖片下載失敗」重試 |
| OpenAI 產生草稿（本機） | ✅ | 新 key：S1 合併後 sol 答「8. D scarce」、S3 need_more_info、S4 non_question，全部走 flex |
| 部署 | ✅ | https://line-tutor.cosmos0409.workers.dev（2026-10-17；只設了隨機產生的測試用 LINE secret，沒有接任何真實 LINE 帳號） |
| Worker CPU（webhook） | ✅ 0–1 ms | `wrangler tail`，上限 10 ms |
| DO CPU（enqueue、alarm 不含圖片） | ✅ 0–1 ms | `wrangler tail`，上限 30 秒 |
| DO CPU（圖片 base64） | ✅ 估計 17–30 ms／張 | Node 基準測試（446–797 KB 考卷照片），4 張約 120 ms |
| **雲端 AI 草稿** | ⬜ | 等使用者設定 Cloudflare 的 `OPENAI_API_KEY` secret |

Python 舊版：程式仍在 repo，但沒有部署在任何地方。LINE Webhook 仍指向已停止的 Railway。

## 3. 下一步（Next）

**Phase 1 剩餘工作**：
1. 👤 在 `cf/` 執行 `npx wrangler secret put OPENAI_API_KEY`，在提示時貼上 key
2. 對部署版重跑模擬器（`SIM_WORKER_URL`、`SIM_LINE_SECRET`＝`cf/.sim-secret`、`SIM_SKIP_IMAGES=1`），確認雲端 AI 草稿與 alarm CPU
3. 👤 建立 Telegram 測試群組，把現有 bot 加進去（Phase 2 才用到）

**注意**：我的 Bash 讀不到使用者的 wrangler 登入資料，wrangler 指令一律在使用者的終端機分頁執行。

**Phase 2**：D1（questions、messages）、R2（照片 180 天）、Telegram 通知（題目／精簡通知）、對話前後文。

## 4. 已知問題與待釐清（Issues / Blockers）

- 🚧 **OpenAI key 失效**：阻擋 AI 驗證與部署實測
- ⚠️ alarm 重試 6 次都失敗後，訊息會留在 DO 裡，要等同一學生再傳訊息才會再處理，而且沒有任何通知。**Phase 2 必須補上**：最後一次失敗時通知 Telegram，並存成「AI 失敗、待老師處理」
- ✅ `LAST_RETRY = 6` 已在部署版確認：alarm 的 retryCount 最大到 6
- ⚠️ 本機 `.wrangler/state` 會保留舊的模擬資料與重試；不影響正式環境，需要時可刪除
- 審核頁的改善清單見計畫文件 §7.4（Phase 3 實作）

## 5. 測試指南（Testing）

以下為 PowerShell 寫法（使用者的終端機是 PowerShell 5.1，不支援 `&&`），都在 `cf/` 目錄內執行：

```powershell
npm install; npm run types
```

```powershell
Copy-Item .dev.vars.example .dev.vars   # 再填入 OPENAI_API_KEY；LINE 用假值即可
```

```powershell
npm run typecheck; npm test
```

本機端對端模擬（開兩個終端機）：

```powershell
npx wrangler dev --ip 127.0.0.1 --port 8787
```

```powershell
$env:SIM_IMAGE_DIR="<放 xz_p1.jpg、xn_p1.jpg 的資料夾>"; node scripts/simulate.mjs
```

- 結果看 wrangler dev 的 Log：`batch_processing`、`draft_ready`、`batch_skipped_*`
- `SIM_IMAGE_404=1`：模擬圖片下載失敗
- 考卷圖片可用 PyMuPDF 從 `考卷例題/` 的 PDF 轉成 150 dpi JPG
