// 本機模擬：啟動假的 LINE API（暱稱、圖片下載），並送出簽章過的 webhook 給 `wrangler dev`。
// 用法：SIM_IMAGE_DIR=<放 jpg 的資料夾> node scripts/simulate.mjs
// 結果看 wrangler dev 的 Log（event: draft_ready / batch_skipped_*）。
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKER = process.env.SIM_WORKER_URL || "http://127.0.0.1:8787";
const SECRET = process.env.SIM_LINE_SECRET || "dev-secret";
const IMAGE_DIR = process.env.SIM_IMAGE_DIR;
const MOCK_PORT = 8790;

const images = new Map(); // messageId → 檔名
const RUN = Date.now().toString(36); // 每輪不同的學生 ID，避免和上一輪殘留的 alarm 混在一起
const uid = (s) => `U_${RUN}_${s}`;

const mock = createServer((req, res) => {
  const profile = req.url.match(/^\/v2\/bot\/profile\/(.+)$/);
  if (profile) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ userId: profile[1], displayName: `測試學生-${profile[1].slice(-1)}` }));
  }
  const content = req.url.match(/^\/v2\/bot\/message\/(.+)\/content$/);
  // SIM_IMAGE_404=1：模擬 LINE 圖片下載失敗（暱稱正常），驗證不會「少了圖片照樣解題」
  if (content && images.has(content[1]) && process.env.SIM_IMAGE_404 !== "1") {
    res.writeHead(200, { "content-type": "image/jpeg" });
    return res.end(readFileSync(join(IMAGE_DIR, images.get(content[1]))));
  }
  res.writeHead(404);
  res.end();
});

function event(userId, message, eventId = randomUUID()) {
  return {
    type: "message",
    mode: "active",
    timestamp: Date.now(),
    webhookEventId: eventId,
    deliveryContext: { isRedelivery: false },
    source: { type: "user", userId },
    replyToken: randomUUID(),
    message: { markAsReadToken: `read-${message.id}`, ...message },
  };
}
const text = (userId, t) => event(userId, { id: randomUUID(), type: "text", text: t });
function image(userId, file) {
  const id = randomUUID();
  images.set(id, file);
  return event(userId, { id, type: "image", contentProvider: { type: "line" } });
}

async function send(events, { badSignature = false } = {}) {
  const body = JSON.stringify({ destination: "Udest", events });
  const signature = badSignature ? "AAAA" : createHmac("sha256", SECRET).update(body).digest("base64");
  const resp = await fetch(`${WORKER}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body,
  });
  return resp.status;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // SIM_SKIP_IMAGES=1：對已部署的 Worker 測試時使用（雲端連不到本機的假 LINE 伺服器）
  const skipImages = process.env.SIM_SKIP_IMAGES === "1";
  if (!IMAGE_DIR && !skipImages) throw new Error("請設定 SIM_IMAGE_DIR，或設 SIM_SKIP_IMAGES=1");
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  const results = {};

  // S1：先傳文字、1 秒後傳圖片 → 應合併成一批，答 8. D scarce
  results.S1_text = await send([text(uid("A"), "第8題為什麼不是B")]);
  if (!skipImages) {
    await sleep(1000);
    results.S1_image = await send([image(uid("A"), "xz_p1.jpg")]);
  }

  // S2：純社交回應 → 應略過
  results.S2 = await send([text(uid("B"), "謝謝老師🙏🙏")]);

  // S3：只傳整張考卷 → need_more_info
  if (!skipImages) results.S3 = await send([image(uid("C"), "xn_p1.jpg")]);

  // S4：課務問題 → non_question
  results.S4 = await send([text(uid("D"), "老師明天要帶什麼？")]);

  // S5：LINE 重送同一事件 → 只算一則
  const dup = text(uid("E"), "since 跟ever since 有區別嗎");
  results.S5_first = await send([dup]);
  results.S5_redelivery = await send([dup]);

  // S6：簽章錯誤 → 401
  results.S6_bad_signature = await send([text(uid("F"), "hack")], { badSignature: true });

  // S7：LINE 後台「驗證」按鈕（空 events）→ 200
  results.S7_verify = await send([]);

  console.log(JSON.stringify({ webhookStatus: results }));
  // 等緩衝時間＋AI 回應；假 LINE 伺服器要開著讓 Worker 下載圖片
  const waitMs = Number(process.env.SIM_WAIT_MS || 60000);
  await sleep(waitMs);
  mock.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
