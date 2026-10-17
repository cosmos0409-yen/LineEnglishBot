// 審核介面的 HTML（伺服器端產生；所有動態內容經 html`` 自動跳脫）
import { ROLE_LABEL, type Role } from "./auth";
import { formatTaipei, html, raw, timeAgo, type SafeHtml } from "./html";
import type { ContextMessage, ReviewQuestion } from "./review";
import { ASSET_VERSION } from "./static";

type FlashType = "success" | "warn" | "error";
export const FLASH: Record<string, { type: FlashType; text: string }> = {
  waiting: { type: "success", text: "✅ 已通過，等待另一位老師審核" },
  sent: { type: "success", text: "✅ 解答已送出給學生" },
  push_failed: { type: "error", text: "⚠️ 審核完成，但 LINE 推播失敗。請按下方的「重新推播」" },
  resend_ok: { type: "success", text: "✅ 重新推播成功，學生已收到解答" },
  resend_failed: { type: "error", text: "⚠️ 重新推播仍然失敗，請稍後再試，或直接在 LINE 後台回覆學生" },
  already_done: { type: "warn", text: "這一題已經處理完成，沒有再送出" },
  already_you: { type: "warn", text: "你已經審核過這一題了，等待另一位老師" },
  empty: { type: "error", text: "解答不能是空白" },
  direct_not_allowed: { type: "error", text: "只有承傑可以直接通過" },
  generated: { type: "success", text: "🤖 已產生 AI 草稿，請檢查後再通過" },
  generate_failed: { type: "error", text: "AI 產生失敗，請稍後再試，或直接手寫解答" },
  login_failed: { type: "error", text: "PIN 不正確" },
  locked: { type: "error", text: "輸錯太多次，請 15 分鐘後再試" },
  logged_out: { type: "success", text: "已登出，請重新輸入 PIN" },
};

const KIND_LABEL: Record<string, string> = { question: "題目", need_more_info: "需要補資訊", non_question: "非英文問題" };
const STATUS_LABEL: Record<string, string> = { pending: "待審核", approved: "推播中", push_failed: "推播失敗", sent: "已送出" };

const csrfField = (token: string) => html`<input type="hidden" name="_csrf" value="${token}">`;

function flash(code: string | null): SafeHtml | string {
  const f = code ? FLASH[code] : undefined;
  return f ? html`<div class="flash ${f.type}" role="status">${f.text}</div>` : "";
}

function kindBadge(q: ReviewQuestion): SafeHtml {
  if (q.ai_status === "error") return html`<span class="badge error">AI 失敗</span>`;
  return html`<span class="badge kind-${q.kind ?? "none"}">${KIND_LABEL[q.kind ?? ""] ?? "未分類"}</span>`;
}

function statusBadge(q: ReviewQuestion): SafeHtml {
  return html`<span class="badge status-${q.status}">${STATUS_LABEL[q.status] ?? q.status}</span>`;
}

function approvals(q: ReviewQuestion): SafeHtml {
  const mark = (done: number) => (done ? "✅" : "⏳");
  return html`<span class="approvals">${mark(q.approver_cheng_jie)} 承傑　${mark(q.approver_tutor)} 導師</span>`;
}

function layout(title: string, body: SafeHtml, role: Role | null, csrf = ""): string {
  const who = role
    ? html`<div class="who">
        <span>👤 <b>${ROLE_LABEL[role]}</b> <span class="muted">· 這台裝置已記住</span></span>
        <form method="post" action="/logout">${csrfField(csrf)}<button class="link" type="submit">不是我？切換身分</button></form>
      </div>`
    : "";
  return html`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<link rel="stylesheet" href="/static/app.css?v=${ASSET_VERSION}">
<script src="/static/app.js?v=${ASSET_VERSION}" defer></script>
</head>
<body>
<header class="topbar">
  ${role ? html`<a class="back" href="/queue">☰ 清單</a>` : html`<span class="brand">英文解題助手</span>`}
  ${who}
</header>
<main>${body}</main>
</body>
</html>`.value;
}

export function loginPage(next: string, code: string | null): string {
  const body = html`
  <section class="card narrow">
    <h1>導師登入</h1>
    <p>第一次使用請輸入你的 PIN。之後<b>這台手機／電腦會記住你，一年內不用再輸入</b>。</p>
    ${flash(code)}
    <form method="post" action="/login" class="stack">
      <input type="hidden" name="next" value="${next}">
      <label for="pin">PIN</label>
      <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required autofocus>
      <button class="primary" type="submit">登入</button>
    </form>
    <p class="hint">提醒：在 Telegram 裡點開連結，和用手機瀏覽器（Chrome、Safari）打開，記憶是分開的。兩邊都會用的話，各輸入一次即可。</p>
  </section>`;
  return layout("導師登入", body, null);
}

export function queuePage(role: Role, open: ReviewQuestion[], recent: ReviewQuestion[], csrf: string, now = Date.now()): string {
  const item = (q: ReviewQuestion) => html`
    <a class="item" href="/review/${q.id}">
      <div class="item-top">${kindBadge(q)} ${statusBadge(q)} <b>${q.student_name}</b> <span class="muted">${timeAgo(q.created_at, now)}</span></div>
      <div class="item-text">${q.question_text ? q.question_text.slice(0, 60) : "📷 只傳了照片"}</div>
      ${q.status === "pending" ? approvals(q) : ""}
    </a>`;
  const body = html`
  <h1>待處理 <span class="count">${open.length}</span></h1>
  ${open.length === 0 ? html`<p class="empty">目前沒有待處理的提問 🎉</p>` : html`<div class="list">${open.map(item)}</div>`}
  <h2>最近送出</h2>
  ${recent.length === 0 ? html`<p class="empty">還沒有送出的解答</p>` : html`<div class="list">${recent.map(item)}</div>`}`;
  return layout("待審核清單", body, role, csrf);
}

export interface ReviewPageData {
  role: Role;
  q: ReviewQuestion;
  context: ContextMessage[];
  flashCode: string | null;
  highlightGenerate: boolean;
  csrf: string;
  now?: number;
}

export function reviewPage({ role, q, context, flashCode, highlightGenerate, csrf, now = Date.now() }: ReviewPageData): string {
  const imageCount = (JSON.parse(q.image_ids) as string[]).length;
  const photos = Array.from({ length: imageCount }, (_, i) => html`
    <a href="/img/${q.id}/${i}" target="_blank" rel="noopener"><img src="/img/${q.id}/${i}" alt="學生傳的照片 ${i + 1}" loading="lazy"></a>`);
  const ctxPhoto = q.context_image_id
    ? html`<p class="hint">📎 學生這次沒傳照片，AI 參考了前面傳的這張：</p>
      <a href="/img/${q.id}/ctx" target="_blank" rel="noopener"><img src="/img/${q.id}/ctx" alt="前面傳的照片" loading="lazy"></a>`
    : "";

  // 本題之前的對話（本題自己的訊息已顯示在上方）
  const earlier = context.filter((m) => m.question_id !== q.id);
  const history = earlier.length
    ? html`<details class="card history"${earlier.length <= 4 ? raw(" open") : ""}>
        <summary>前面的對話（${earlier.length} 則）</summary>
        <ul>${earlier.map(
          (m) => html`<li class="${m.role}"><span class="muted">${formatTaipei(m.ts)} ${m.role === "teacher" ? "老師" : "學生"}</span>
            <span class="msg">${m.type === "image" ? "📷 照片" : m.text ?? `［${m.type}］`}</span></li>`,
        )}</ul>
      </details>`
    : "";

  const done = q.status === "sent" || q.status === "approved" || q.status === "push_failed";
  const myDone = role === "cheng_jie" ? q.approver_cheng_jie : q.approver_tutor;
  const needsDraft = q.ai_status === "error" || q.kind === "non_question" || !q.ai_answer;

  const generateForm =
    !done && (needsDraft || highlightGenerate)
      ? html`<form method="post" action="/review/${q.id}/generate" class="card ${highlightGenerate ? "highlight" : ""}">${csrfField(csrf)}
          <p>${q.ai_status === "error"
            ? html`⚠️ AI 處理失敗（${q.ai_error ?? "原因不明"}）。可以重新產生，或直接在下方手寫解答。`
            : q.kind === "non_question"
              ? "AI 判斷這則不是英文問題，所以沒有寫草稿。如果其實是題目，請按下方按鈕。"
              : "還沒有 AI 草稿。"}</p>
          <button class="secondary" type="submit">🤖 ${q.ai_answer ? "重新產生 AI 草稿" : "產生 AI 草稿"}</button>
        </form>`
      : "";

  const note = q.tutor_note && q.tutor_note !== "無" ? html`<div class="card note"><b>📌 AI 給老師的提醒</b><p>${q.tutor_note}</p></div>` : "";

  let action: SafeHtml;
  if (q.status === "sent") {
    action = html`<section class="card success">
      <h2>✅ 已於 ${formatTaipei(q.sent_at ?? q.created_at)} 送出給學生</h2>
      <pre class="final">${q.final_answer}</pre></section>`;
  } else if (q.status === "push_failed" || q.status === "approved") {
    action = html`<section class="card error">
      <h2>${q.status === "push_failed" ? "⚠️ 審核完成，但 LINE 推播失敗" : "⏳ 審核完成，正在推播"}</h2>
      ${q.push_error ? html`<p class="muted">${q.push_error}</p>` : ""}
      <pre class="final">${q.final_answer}</pre>
      <form method="post" action="/review/${q.id}/resend">${csrfField(csrf)}<button class="primary" type="submit">🔁 重新推播</button></form>
      <p class="hint">重新推播不會讓學生收到兩次（LINE 會自動去除 24 小時內的重複發送）。</p></section>`;
  } else {
    const otherLabel = role === "cheng_jie" ? "導師" : "承傑";
    action = html`<form method="post" action="/review/${q.id}/approve" class="card answer">${csrfField(csrf)}
      <label for="final">要送給學生的解答</label>
      <textarea id="final" name="final_answer" data-ai="${q.ai_answer ?? ""}" required>${q.final_answer ?? ""}</textarea>
      <div class="row">
        ${q.ai_answer ? html`<button type="button" class="link" data-restore>↩ 還原 AI 原稿</button>` : html`<span></span>`}
        <span class="muted" data-counter></span>
      </div>
      <div class="row">${approvals(q)}</div>
      ${myDone
        ? html`<button class="primary" type="submit" disabled>你已審核，等待${otherLabel}</button>`
        : html`${role === "cheng_jie"
            ? html`<label class="check"><input type="checkbox" name="direct" value="1"> 直接通過（不等導師，馬上送給學生）</label>`
            : ""}
          <button class="primary" type="submit">✅ 以${ROLE_LABEL[role]}身分通過</button>`}
    </form>`;
  }

  const body = html`
  ${flash(flashCode)}
  <section class="card">
    <div class="meta">${kindBadge(q)} ${statusBadge(q)} <b>${q.student_name}</b>
      <span class="muted">${formatTaipei(q.created_at)}（${timeAgo(q.created_at, now)}）</span></div>
    <p class="qtext">${q.question_text ?? "（學生只傳了照片，沒有附文字）"}</p>
    ${imageCount ? html`<div class="photos">${photos}</div><p class="hint">點照片可以開新分頁放大</p>` : ""}
    ${ctxPhoto}
  </section>
  ${history}
  ${generateForm}
  ${note}
  ${action}`;
  return layout(`審核：${q.student_name}`, body, role, csrf);
}
