// 審核介面的靜態檔（獨立路徑提供，讓 CSP 可以禁止所有行內 script／style）

export const APP_CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2129;--muted:#6b7280;--line:#e5e7eb;--primary:#2563eb;--primary-text:#fff;
--ok-bg:#ecfdf5;--ok:#047857;--warn-bg:#fffbeb;--warn:#b45309;--err-bg:#fef2f2;--err:#b91c1c;--note-bg:#eff6ff;--note:#1e40af}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1b1e25;--text:#e6e8ec;--muted:#9aa1ad;--line:#2c313b;--primary:#3b82f6;
--ok-bg:#0f2a22;--ok:#6ee7b7;--warn-bg:#2d2310;--warn:#fcd34d;--err-bg:#2f1517;--err:#fca5a5;--note-bg:#172238;--note:#93c5fd}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC","Microsoft JhengHei",sans-serif}
main{max-width:720px;margin:0 auto;padding:12px 16px 48px}
h1{font-size:1.3rem;margin:16px 0 12px}h2{font-size:1.1rem;margin:20px 0 10px}
.topbar{position:sticky;top:0;z-index:1;display:flex;flex-wrap:nowrap;gap:8px;align-items:center;justify-content:space-between;
padding:10px 16px;background:var(--card);border-bottom:1px solid var(--line);font-size:.92rem}
.topbar a{color:var(--primary);text-decoration:none;font-weight:600}
.topbar .back{white-space:nowrap}
.who{display:flex;flex-direction:column;align-items:flex-end;gap:0;text-align:right;font-size:.85rem;line-height:1.35}.who form{margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:12px 0}
.card.narrow{max-width:420px;margin:32px auto}
.card.highlight{border:2px solid var(--primary)}
.card.note{background:var(--note-bg);color:var(--note);border-color:transparent}.card.note p{margin:4px 0 0;white-space:pre-wrap}
.card.success{background:var(--ok-bg);border-color:transparent}.card.success h2{color:var(--ok);margin-top:0}
.card.error{background:var(--err-bg);border-color:transparent}.card.error h2{color:var(--err);margin-top:0}
.meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.qtext{font-size:1.15rem;font-weight:600;white-space:pre-wrap;margin:10px 0}
.photos{display:grid;gap:8px}.photos img,.card a>img{width:100%;border-radius:8px;border:1px solid var(--line);display:block}
.muted{color:var(--muted);font-size:.88rem}.hint{color:var(--muted);font-size:.85rem;margin:6px 0}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.78rem;font-weight:600;background:var(--line);color:var(--text)}
.badge.kind-question{background:var(--note-bg);color:var(--note)}.badge.kind-need_more_info,.badge.status-approved{background:var(--warn-bg);color:var(--warn)}
.badge.kind-non_question{background:var(--line);color:var(--muted)}.badge.error,.badge.status-push_failed{background:var(--err-bg);color:var(--err)}
.badge.status-sent{background:var(--ok-bg);color:var(--ok)}
.flash{padding:10px 14px;border-radius:10px;margin:12px 0;font-weight:600}
.flash.success{background:var(--ok-bg);color:var(--ok)}.flash.warn{background:var(--warn-bg);color:var(--warn)}.flash.error{background:var(--err-bg);color:var(--err)}
.history ul{list-style:none;margin:8px 0 0;padding:0}.history li{padding:6px 0;border-top:1px solid var(--line)}
.history li .msg{display:block;white-space:pre-wrap}.history li.teacher .msg{color:var(--note)}
summary{cursor:pointer;font-weight:600}
label{font-weight:600}
textarea{width:100%;min-height:45vh;margin-top:8px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text);
font:inherit;line-height:1.7;resize:vertical}
input[type=password]{width:100%;padding:12px;font-size:1.2rem;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text)}
.stack{display:grid;gap:10px}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 0}
.check{display:flex;gap:8px;align-items:center;font-weight:500;margin:10px 0}.check input{width:20px;height:20px}
button{font:inherit;cursor:pointer}
.primary{width:100%;padding:14px;border:0;border-radius:10px;background:var(--primary);color:var(--primary-text);font-weight:700;font-size:1.05rem}
.primary:disabled{opacity:.55;cursor:default}
.secondary{padding:10px 14px;border:1px solid var(--primary);border-radius:10px;background:transparent;color:var(--primary);font-weight:600}
.link{border:0;background:none;color:var(--primary);padding:0;font-weight:600}
.warn{color:var(--warn)!important}
pre.final{white-space:pre-wrap;font:inherit;margin:8px 0}
.list{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
.item{display:block;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;color:inherit;text-decoration:none}
.item-top{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.item-text{margin:6px 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.approvals{font-size:.88rem;color:var(--muted)}
.count{display:inline-block;min-width:1.6em;padding:0 6px;border-radius:999px;background:var(--primary);color:var(--primary-text);font-size:.9rem;text-align:center}
.empty{color:var(--muted);display:flex;align-items:center}
.ic{display:inline-block;flex-shrink:0;vertical-align:-3px;margin-right:.35em}
.primary,.secondary,.link,.back,.flash,.who-name{display:inline-flex;align-items:center;justify-content:center}
.primary{display:flex}.flash{display:flex;justify-content:flex-start}.flash .ic{margin-top:1px}
.card h2,.card.note b{display:flex;align-items:center}
.approvals{display:inline-flex;flex-wrap:wrap;gap:4px 14px}
.approver{display:inline-flex;align-items:center}.approver.done{color:var(--ok)}
.photos img,.card a>img{min-height:160px;background:var(--line)}
.who-name .muted{margin-left:.35em}
.nav{display:flex;gap:14px;white-space:nowrap}
.filter{display:flex;align-items:center;gap:8px;margin:12px 0 0}
.filter label{display:inline-flex;align-items:center;font-weight:600;white-space:nowrap}
.filter select{flex:1;min-width:0;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);font:inherit}
.badge.class{background:var(--note-bg);color:var(--note);font-weight:500}
.links{display:flex;flex-wrap:wrap;gap:6px 16px;margin:4px 0 8px}.links a{color:var(--primary);font-weight:600;text-decoration:none;display:inline-flex;align-items:center}
.item-answer{display:flex;align-items:flex-start;color:var(--ok);font-size:.88rem;margin-top:4px}.item-answer span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
h1.inline{display:inline;margin:0}
.title{display:flex;align-items:center}
input[type=text]{width:100%;padding:12px;font:inherit;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text)}
a.student-link{color:inherit;text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px}
.msg .ic,.item-text .ic,.hint .ic{color:var(--muted)}
`;

export const APP_JS = `
document.querySelectorAll("form").forEach(function (form) {
  form.addEventListener("submit", function (e) {
    var direct = form.querySelector("input[name=direct]");
    if (direct && direct.checked && !confirm("確定直接通過？解答會立刻送給學生。")) { e.preventDefault(); return; }
    // 防止連點重複送出
    form.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    var main = form.querySelector("button.primary, button.secondary");
    if (main) main.textContent = "處理中…";
  });
});
// 選了學生就直接篩選
document.querySelectorAll("select[data-autosubmit]").forEach(function (sel) {
  sel.addEventListener("change", function () { sel.form.submit(); });
});
var ta = document.querySelector("textarea[name=final_answer]");
if (ta) {
  var counter = document.querySelector("[data-counter]");
  var update = function () {
    var n = ta.value.trim().length;
    var bubbles = Math.ceil(n / 5000);
    counter.textContent = n + " 字" + (bubbles > 1 ? "（會分成 " + bubbles + " 則 LINE 訊息）" : "");
    counter.classList.toggle("warn", bubbles > 1);
  };
  ta.addEventListener("input", update);
  update();
  var restore = document.querySelector("[data-restore]");
  if (restore) restore.addEventListener("click", function () {
    if (confirm("還原成 AI 原稿？你目前的修改會被取代。")) { ta.value = ta.dataset.ai; update(); }
  });
}
`;

/** 依內容算出的版本號，放在網址上：內容一改就換網址，瀏覽器不會用到舊的快取。 */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
export const ASSET_VERSION = hash(APP_CSS + APP_JS);
