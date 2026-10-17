// 審核流程端對端測試（對本機 `wrangler dev`）：假 LINE（暱稱、推播、標已讀）＋假 Telegram，
// 經由 webhook 建立提問後，用 HTTP 操作審核頁，逐項檢查。
// 用法（PowerShell）：node scripts/review-flow.mjs   ← 需要 .dev.vars 的測試 PIN（111111／222222）
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const WORKER = "http://127.0.0.1:8787";
const SECRET = "dev-secret";
const PIN = { cheng_jie: "111111", tutor: "222222" };
const RUN = Date.now().toString(36);
const uid = (s) => `U_${RUN}_${s}`;

const pushes = []; // { to, retryKey, texts }
const reads = [];
let failPushes = 0; // > 0 時，接下來幾次推播回 500

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const mock = createServer(async (req, res) => {
  const body = await readBody(req);
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const profile = req.url.match(/^\/v2\/bot\/profile\/(.+)$/);
  // 暱稱由學生 ID 本身推出（U_<輪次>_<字母>），之前測試留下、晚到的重試也會保有自己那一輪的名字
  if (profile) {
    const [, run, letter] = decodeURIComponent(profile[1]).split("_");
    return json(200, { displayName: `R${run}-${letter}` });
  }
  if (req.url === "/v2/bot/message/push") {
    const data = JSON.parse(body);
    if (failPushes > 0) {
      failPushes--;
      pushes.push({ to: data.to, retryKey: req.headers["x-line-retry-key"], texts: [], failed: true });
      return json(500, { message: "mock failure" });
    }
    const seen = pushes.some((p) => !p.failed && p.retryKey === req.headers["x-line-retry-key"]);
    pushes.push({ to: data.to, retryKey: req.headers["x-line-retry-key"], texts: data.messages.map((m) => m.text), duplicate: seen });
    return seen ? json(409, { message: "already accepted" }) : json(200, { sentMessages: [{ id: "1" }] });
  }
  if (req.url === "/v2/bot/chat/markAsRead") {
    reads.push(JSON.parse(body).markAsReadToken);
    return json(200, {});
  }
  if (/^\/bot[^/]+\/send(Message|Photo)$/.test(req.url)) return json(200, { ok: true, result: {} });
  res.writeHead(404);
  res.end();
});

function sendWebhook(userId, text) {
  const id = randomUUID();
  const body = JSON.stringify({
    destination: "Udest",
    events: [{
      type: "message", mode: "active", timestamp: Date.now(), webhookEventId: randomUUID(),
      source: { type: "user", userId }, replyToken: randomUUID(),
      message: { id, type: "text", text, markAsReadToken: `read-${id}` },
    }],
  });
  return fetch(`${WORKER}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": createHmac("sha256", SECRET).update(body).digest("base64") },
    body,
  });
}

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && detail ? `  ← ${detail}` : ""}`);
}

const csrfCache = new Map(); // cookie → 表單裡的 _csrf token

async function csrfFor(cookie) {
  if (!csrfCache.has(cookie)) {
    const r = await fetch(`${WORKER}/queue`, { headers: { cookie }, redirect: "manual" });
    csrfCache.set(cookie, (await r.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "");
  }
  return csrfCache.get(cookie);
}

async function http(path, { method = "GET", cookie, form, origin, noCsrf = false } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  // 需要登入的 POST 自動帶上 CSRF token（和瀏覽器送表單一樣）
  if (method === "POST" && cookie && !noCsrf) form = { _csrf: await csrfFor(cookie), ...(form ?? {}) };
  let body;
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }
  const resp = await fetch(`${WORKER}${path}`, { method, headers, body, redirect: "manual" });
  return { status: resp.status, location: resp.headers.get("location"), setCookie: resp.headers.get("set-cookie"), headers: resp.headers, text: await resp.text() };
}

async function login(pin) {
  const r = await http("/login", { method: "POST", form: { pin, next: "/queue" } });
  return r.setCookie ? r.setCookie.split(";")[0] : null;
}

async function findQuestionId(cookie, studentSuffix) {
  for (let i = 0; i < 40; i++) {
    const r = await http("/queue", { cookie });
    // 清單項目：<a class="item" href="/review/<id>"> ... <b>測試學生-X</b>
    const items = [...r.text.matchAll(/href="\/review\/([0-9a-f-]{36})">[\s\S]*?<b>([^<]+)<\/b>/g)];
    const hit = items.find((m) => m[2] === `R${RUN}-${studentSuffix}`);
    if (hit) return hit[1];
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function main() {
  await new Promise((r) => mock.listen(8790, "127.0.0.1", r));

  // 建立提問：A 一般題目、B 非英文問題、C 含 HTML 的題目（XSS）、D 推播失敗後重送
  await sendWebhook(uid("A"), "since 跟 ever since 有區別嗎");
  await sendWebhook(uid("B"), "老師明天要帶什麼？");
  await sendWebhook(uid("C"), `<img src=x onerror=alert(1)> affect 跟 effect 差在哪`);
  await sendWebhook(uid("D"), "crush 和 crash 差在哪");

  // 1. 未登入 → 導到登入頁，next 帶原路徑
  const anon = await http("/queue");
  check("未登入看清單 → 303 導到 /login", anon.status === 303 && anon.location === "/login?next=%2Fqueue", `${anon.status} ${anon.location}`);
  const loginHtml = await http("/login?next=/queue");
  check("登入頁有『這台裝置會記住你』說明", loginHtml.text.includes("這台手機／電腦會記住你"));
  check("頁面有 CSP 標頭", (loginHtml.headers.get("content-security-policy") ?? "").includes("script-src 'self'"));
  const external = await http("/login", { method: "POST", form: { pin: PIN.tutor, next: "https://evil.example" } });
  check("登入後不會被導到外部網站", external.location === "/queue", external.location);

  // 2. 登入
  const wrong = await http("/login", { method: "POST", form: { pin: "000000", next: "/queue" } });
  check("錯誤 PIN → 401、不發 Cookie", wrong.status === 401 && !wrong.setCookie);
  const cj = await login(PIN.cheng_jie);
  const tutor = await login(PIN.tutor);
  check("兩組 PIN 都能登入", cj && tutor);
  const cookieHeader = (await http("/login", { method: "POST", form: { pin: PIN.tutor, next: "/queue" } })).setCookie ?? "";
  check("Cookie 為 HttpOnly、Secure、SameSite=Lax、一年", /HttpOnly/.test(cookieHeader) && /Secure/.test(cookieHeader) && /SameSite=Lax/.test(cookieHeader) && /Max-Age=31536000/.test(cookieHeader));

  // 3. 等提問建立
  const [qa, qb, qc, qd] = [await findQuestionId(tutor, "A"), await findQuestionId(tutor, "B"), await findQuestionId(tutor, "C"), await findQuestionId(tutor, "D")];
  check("4 題都出現在待審核清單", qa && qb && qc && qd, JSON.stringify({ qa, qb, qc, qd }));

  // 4. 審核頁內容與標已讀
  const pageA = await http(`/review/${qa}`, { cookie: tutor });
  check("審核頁顯示學生問題（在照片／解答之前）", pageA.text.indexOf("since 跟 ever since") < pageA.text.indexOf("要送給學生的解答"));
  check("審核頁顯示目前身分『導師』與切換身分", pageA.text.includes("<b>導師</b> <span class=\"muted\">· 這台裝置已記住") && pageA.text.includes("切換身分"));
  check("導師只看到自己的按鈕，沒有『直接通過』", pageA.text.includes("以導師身分通過") && !pageA.text.includes("name=\"direct\""));
  const pageAcj = await http(`/review/${qa}`, { cookie: cj });
  check("承傑看得到『直接通過』", pageAcj.text.includes("name=\"direct\""));
  await new Promise((r) => setTimeout(r, 500));
  check("打開審核頁後呼叫 LINE 標已讀（只一次）", reads.length === 1, JSON.stringify(reads));

  // 5. XSS
  const pageC = await http(`/review/${qc}`, { cookie: tutor });
  check("學生內容中的 HTML 被跳脫", pageC.text.includes("&lt;img src=x onerror=alert(1)&gt;") && !pageC.text.includes("<img src=x onerror"));

  // 6. Origin 檢查
  const cross = await http(`/review/${qa}/approve`, { method: "POST", cookie: tutor, origin: "https://evil.example", form: { final_answer: "x" } });
  check("跨站 POST → 403", cross.status === 403, String(cross.status));
  const noToken = await http(`/review/${qa}/approve`, { method: "POST", cookie: tutor, noCsrf: true, form: { final_answer: "x" } });
  check("沒有 CSRF token 的 POST → 403（Origin 為 null 也一樣擋）", noToken.status === 403, String(noToken.status));
  const wrongToken = await http(`/review/${qa}/approve`, { method: "POST", cookie: tutor, origin: "null", form: { _csrf: "forged", final_answer: "x" } });
  check("偽造的 CSRF token → 403", wrongToken.status === 403, String(wrongToken.status));

  // 7. 兩位同時通過 → 只推播一次、狀態 sent
  const answer = "since 是「自從」\never since 強調「從那時起一直到現在」";
  const [r1, r2] = await Promise.all([
    http(`/review/${qa}/approve`, { method: "POST", cookie: cj, form: { final_answer: answer } }),
    http(`/review/${qa}/approve`, { method: "POST", cookie: tutor, form: { final_answer: answer } }),
  ]);
  const codes = [r1.location, r2.location].map((l) => new URL(l, WORKER).searchParams.get("m")).sort();
  check("同時通過：一個 waiting、一個 sent", JSON.stringify(codes) === JSON.stringify(["sent", "waiting"]), JSON.stringify(codes));
  const pushesA = pushes.filter((p) => p.to === uid("A"));
  check("同時通過：只推播一次，內容是老師的最終解答", pushesA.length === 1 && pushesA[0].texts[0] === answer,
    `pushesA=${pushesA.length} sent=${JSON.stringify(pushesA[0]?.texts[0])} expected=${JSON.stringify(answer)}`);
  const again = await http(`/review/${qa}/approve`, { method: "POST", cookie: cj, form: { final_answer: "再送一次" } });
  check("已送出的題目再按通過 → already_done、不再推播", again.location.endsWith("m=already_done") && pushes.filter((p) => p.to === uid("A")).length === 1);
  const sentPage = await http(`/review/${qa}`, { cookie: tutor });
  check("審核頁顯示『已於…送出給學生』", sentPage.text.includes("送出給學生"));

  // 8. 推播失敗 → push_failed → 重新推播成功，retry key 相同
  failPushes = 1;
  const direct = await http(`/review/${qd}/approve`, { method: "POST", cookie: cj, form: { final_answer: "crush 是壓碎、crash 是撞擊", direct: "1" } });
  check("承傑直接通過但推播失敗 → push_failed", direct.location.endsWith("m=push_failed"), direct.location);
  const failedPage = await http(`/review/${qd}`, { cookie: cj });
  check("審核頁顯示推播失敗與『重新推播』按鈕", failedPage.text.includes("LINE 推播失敗") && failedPage.text.includes("重新推播"));
  const resend = await http(`/review/${qd}/resend`, { method: "POST", cookie: cj });
  const pushesD = pushes.filter((p) => p.to === uid("D"));
  check("重新推播成功", resend.location.endsWith("m=resend_ok"), resend.location);
  check("重送沿用同一個 retry key", pushesD.length === 2 && pushesD[0].retryKey === pushesD[1].retryKey && pushesD[0].retryKey, JSON.stringify(pushesD));
  const resend2 = await http(`/review/${qd}/resend`, { method: "POST", cookie: cj });
  check("已送出後再按重送 → 不會再推播", resend2.location.endsWith("m=resend_failed") && pushes.filter((p) => p.to === uid("D")).length === 2);

  // 9. 非英文問題 → 產生解答
  const pageB = await http(`/review/${qb}?generate=1`, { cookie: tutor });
  check("非英文問題頁有『產生 AI 草稿』按鈕並醒目標示", pageB.text.includes("產生 AI 草稿") && pageB.text.includes("highlight"));
  const gen = await http(`/review/${qb}/generate`, { method: "POST", cookie: tutor });
  const genPage = await http(`/review/${qb}`, { cookie: tutor });
  const draft = genPage.text.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "";
  check("產生後有草稿", gen.location.endsWith("m=generated") && draft.trim().length > 0, `${gen.location} | ${draft.slice(0, 80)}`);
  console.log(`      （B 的草稿：${draft.replace(/\n/g, " / ").slice(0, 120)}）`);

  // 10. 已送出的老師解答記成前文
  // （A 的追問會在下一次 AI 呼叫時用到；這裡只檢查審核頁的前文區塊能顯示老師訊息）
  await sendWebhook(uid("A"), "那 for 呢");
  const qa2 = await new Promise(async (resolve) => {
    for (let i = 0; i < 40; i++) {
      const r = await http("/queue", { cookie: tutor });
      const ids = [...r.text.matchAll(/href="\/review\/([0-9a-f-]{36})">[\s\S]*?<b>([^<]+)<\/b>/g)]
        .filter((m) => m[2] === `R${RUN}-A` && m[1] !== qa)
        .map((m) => m[1]);
      if (ids.length) return resolve(ids[0]);
      await new Promise((r) => setTimeout(r, 1000));
    }
    resolve(null);
  });
  const followPage = qa2 ? await http(`/review/${qa2}`, { cookie: tutor }) : { text: "" };
  const historyBlock = followPage.text.match(/<details class="card history"[\s\S]*?<\/details>/)?.[0] ?? "(沒有前文區塊)";
  check("追問的審核頁顯示前面的對話（含老師送出的解答）", followPage.text.includes("前面的對話") && followPage.text.includes("ever since 強調"),
    `qa2=${qa2} ${historyBlock.replace(/\s+/g, " ").slice(0, 400)}`);

  // 11. PIN 錯太多次 → 鎖定
  for (let i = 0; i < 5; i++) await http("/login", { method: "POST", form: { pin: "999999", next: "/queue" } });
  const locked = await http("/login", { method: "POST", form: { pin: PIN.tutor, next: "/queue" } });
  check("同一 IP 錯 5 次後，連正確 PIN 也暫時鎖定（429）", locked.status === 429 && !locked.setCookie, String(locked.status));

  mock.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
