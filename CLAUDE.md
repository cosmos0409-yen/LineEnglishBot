# LINE 英文解題助手

學生在 LINE 傳英文題目（文字或考卷照片），AI 先寫解答草稿，兩位導師在網頁審核後再推播給學生。
正在從 Python/FastAPI（Railway，已停用）改寫成 Cloudflare Workers；新程式在 `cf/`。

## Commands（在 `cf/` 內執行）

- 安裝：     `npm install && npm run types`
- 本機開發： `npx wrangler dev --ip 127.0.0.1 --port 8787`（金鑰放 `cf/.dev.vars`，範本 `.dev.vars.example`）
- 本機模擬： `SIM_IMAGE_DIR=<jpg 資料夾> node scripts/simulate.mjs`（假 LINE API 和簽章 webhook）
- 審核測試： `node scripts/review-flow.mjs`（需 wrangler dev 開著；跑前先清 `login_failures`）
- 測試：     `npm test`
- 型別檢查： `npm run typecheck`
- 資料庫：   `npx wrangler d1 migrations apply DB --local`（`IMAGES_DB` 同理；遠端用 `--remote`）
- 部署：     `npm run deploy`（需先 `wrangler login`）

## Stack

TypeScript + Cloudflare Workers + Durable Objects (SQLite) + D1（`DB` 主資料、`IMAGES_DB` 照片；不用 R2，因為要綁卡）。外部服務：LINE Messaging API、OpenAI Chat Completions、Telegram Bot。

## Structure

```
cf/src/index.ts    — Worker 入口：webhook 驗簽、轉交 Durable Object
cf/src/buffer.ts   — StudentBuffer DO：每位學生 30 秒緩衝與批次處理（alarm）
cf/src/openai.ts   — 產生草稿（Structured Outputs、Flex 方案退回標準方案）
cf/src/prompt.ts   — 解題 Prompt（唯一來源）
cf/src/db.ts       — D1 主資料：提問、對話紀錄、前文
cf/src/images.ts   — 照片切塊存 D1、讀回、過期清除
cf/src/telegram.ts — 導師通知（HTML 跳脫）
cf/src/review.ts   — 審核、推播、標已讀、清單
cf/src/auth.ts     — PIN、Cookie、鎖定、CSRF
cf/src/pages.ts    — 審核介面 HTML（html.ts 自動跳脫、static.ts 的 CSS／JS、icons.ts 線條圖示）
cf/src/students.ts — 學生資料：備註名稱、班級、學生清單與紀錄
cf/src/text.ts     — 純函式：句號清理、社交回應過濾、跳脫、分段、base64
cf/migrations/     — main/（DB）、images/（IMAGES_DB）
cf/scripts/        — 本機模擬器（假 LINE、假 Telegram）
main.py, services/, templates/ — Python 舊版，Phase 6 移除前只做必要修補
doc/               — 計畫、交接手冊、Prompt 說明
```

## Constraints

- 金鑰與 PIN 一律放 Cloudflare Secrets／`.dev.vars`／`.env`，**不可寫進程式碼、文件或 commit**（repo 是公開的）。
- `backup/`、`考卷例題/` 含學生個資，絕不可 commit 或外傳。
- `cf/worker-configuration.d.ts` 由 `npm run types` 產生，改 `wrangler.jsonc` 後要重新產生，不要手改。
- 所有顯示學生內容的地方都要 HTML 跳脫：審核頁一律用 `html```` 樣板，`raw()` 只能包程式自己產生的片段。
- 需要登入的 POST 表單都要帶 `_csrf`；不要用 Origin 判斷（內嵌瀏覽器會送 null）。
- 圖片下載失敗不可「少了圖片照樣解題」，要讓 alarm 重試。
- 模型 ID、API 參數、Cloudflare 設定鍵要查官方文件確認，不憑記憶。
- 介面不用 Emoji，改用 `icons.ts` 的線條圖示；Telegram 通知用文字標籤。
- Claude 的 Bash 讀不到使用者的 wrangler 登入資料：deploy、secret、tail 這類 wrangler 遠端指令改在使用者的終端機分頁執行（PowerShell 5.1，不支援 `&&`）。

## Further Reading

IMPORTANT: 開始非小型任務前先讀相關文件。

- `doc/handover.md` — 目前進度、下一步、已知問題、測試方法
- `doc/cloudflare-migration-plan.md` — 架構、免費額度、決策紀錄、模型實測、審核頁改善清單、各 Phase
- `doc/prompt-v2.md` — Prompt 設計依據
