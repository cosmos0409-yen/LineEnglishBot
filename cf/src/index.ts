import {
  clearSessionCookie,
  createSessionCookie,
  csrfToken,
  isLocked,
  matchPin,
  purgeOldFailures,
  readCookie,
  recordFailure,
  SESSION_COOKIE,
  verifyCsrf,
  verifySession,
  type Role,
} from "./auth";
import type { BufferedMessage } from "./buffer";
import { deleteExpiredImages } from "./images";
import { verifySignature } from "./line";
import { loginPage, notFoundPage, queuePage, reviewPage, settingsPage, studentPage, studentsPage } from "./pages";
import { defaultAiConfig, getAiConfig, listOpenAIModels, listSettingsLog, revertSetting, saveAiConfig, validateAiInput, type AiConfigInput } from "./settings";
import { approve, deliver, dismiss, dismissAllNonQuestions, getContextMessages, getQuestion, listQueue, markReadOnce, reopen } from "./review";
import { APP_CSS, APP_JS } from "./static";
import { CLASS_MAX, cleanField, getStudent, listStudentQuestions, listStudents, NAME_MAX, updateStudent } from "./students";

export { StudentBuffer } from "./buffer";

interface LineWebhookBody {
  events?: {
    type: string;
    webhookEventId: string;
    timestamp: number;
    source?: { type: string; userId?: string };
    message?: { id: string; type: string; text?: string; markAsReadToken?: string };
  }[];
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  const ok = await verifySignature(env.LINE_CHANNEL_SECRET, rawBody, request.headers.get("x-line-signature"));
  if (!ok) return new Response("Invalid signature", { status: 401 });

  const body = JSON.parse(rawBody) as LineWebhookBody;
  // 只處理一對一聊天的訊息事件；LINE 後台的「驗證」按鈕會送空的 events
  const jobs = (body.events ?? [])
    .filter((e) => e.type === "message" && e.source?.type === "user" && e.source.userId && e.message)
    .map((e) => {
      const msg: BufferedMessage = {
        webhookEventId: e.webhookEventId,
        timestamp: e.timestamp,
        messageId: e.message!.id,
        type: e.message!.type,
        text: e.message!.type === "text" ? e.message!.text ?? null : null,
        markAsReadToken: e.message!.markAsReadToken ?? null,
      };
      const userId = e.source!.userId!;
      return env.STUDENT_BUFFER.getByName(userId).enqueue(userId, msg);
    });

  await Promise.all(jobs);
  return new Response("ok");
}

// ---------- 審核介面 ----------

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // 不能用 no-referrer：Chrome 會讓表單 POST 的 Origin 變成 "null"，被下方的同源檢查擋掉
  // same-origin 一樣不會把審核網址外流到其他網站
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

function page(htmlText: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(htmlText, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra } });
}

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...SECURITY_HEADERS, ...extra } });
}

/** 只接受站內相對路徑，避免登入後被導到外部網站。 */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/queue";
}

/**
 * 擋掉明確來自其他網站的 POST。Origin 為 "null"（部分內嵌瀏覽器送表單時會這樣）或缺少時放行，
 * 由 CSRF token（需要登入的表單）與 SameSite=Lax Cookie 把關。
 */
function sameOrigin(request: Request, url: URL, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "null" || origin === url.origin) return true;
  try {
    return origin === new URL(env.APP_BASE_URL).origin;
  } catch {
    return false;
  }
}

async function currentRole(request: Request, env: Env): Promise<Role | null> {
  return verifySession(env, readCookie(request, SESSION_COOKIE));
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "local";
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const next = safeNext(String(form.get("next") ?? ""));
  const ip = clientIp(request);
  if (await isLocked(env, ip)) return page(loginPage(next, "locked"), 429);
  const role = await matchPin(env, String(form.get("pin") ?? ""));
  if (!role) {
    await recordFailure(env, ip);
    return page(loginPage(next, "login_failed"), 401);
  }
  return redirect(next, { "Set-Cookie": await createSessionCookie(env, role) });
}

async function handleReviewRoutes(request: Request, env: Env, ctx: ExecutionContext, url: URL, role: Role, csrf: string): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // review/:id[/action] 或 img/:id/:n
  const id = parts[1] ?? "";
  const q = await getQuestion(env, id);
  if (!q) return page(notFoundPage(role, csrf), 404);

  if (parts[0] === "img") {
    const which = parts[2] ?? "";
    const imageId = which === "ctx" ? q.context_image_id : (JSON.parse(q.image_ids) as string[])[Number(which)];
    if (!imageId) return new Response("Not found", { status: 404 });
    const img = await env.STUDENT_BUFFER.getByName(q.student_line_id).getImage(imageId);
    if (!img) return new Response("照片已過保存期限或不存在", { status: 404 });
    return new Response(img.bytes, {
      headers: { "Content-Type": img.contentType, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
    });
  }

  const action = parts[2];
  if (request.method === "GET" && !action) {
    ctx.waitUntil(markReadOnce(env, q).catch((err) => console.log(JSON.stringify({ event: "mark_as_read_error", error: String(err) }))));
    const context = await getContextMessages(env, q);
    return page(reviewPage({ role, q, context, flashCode: url.searchParams.get("m"), highlightGenerate: url.searchParams.get("generate") === "1", csrf }));
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const back = (code: string) => redirect(`/review/${q.id}?m=${code}`);
  const form = await request.formData();
  if (!(await verifyCsrf(env, readCookie(request, SESSION_COOKIE), String(form.get("_csrf") ?? "")))) {
    console.log(JSON.stringify({ event: "csrf_rejected", path: url.pathname }));
    return new Response("Forbidden", { status: 403 });
  }

  if (action === "approve") {
    const outcome = await approve(env, q.id, role, String(form.get("final_answer") ?? ""), form.get("direct") === "1");
    console.log(JSON.stringify({ event: "approve", questionId: q.id, role, outcome: outcome.kind }));
    if (outcome.kind === "waiting") return back("waiting");
    if (outcome.kind === "approved") return back((await deliver(env, q.id)).ok ? "sent" : "push_failed");
    const map: Record<string, string> = {
      empty_answer: "empty",
      already_done: "already_done",
      already_approved_by_you: "already_you",
      direct_not_allowed: "direct_not_allowed",
      not_found: "already_done",
    };
    return back(map[outcome.reason]);
  }
  if (action === "resend") return back((await deliver(env, q.id)).ok ? "resend_ok" : "resend_failed");
  if (action === "dismiss") {
    const ok = await dismiss(env, q.id, role);
    // 從清單直接標記時，學生還沒看過已讀：順手標已讀
    if (ok) ctx.waitUntil(markReadOnce(env, q).catch(() => undefined));
    console.log(JSON.stringify({ event: "dismiss", questionId: q.id, role, ok }));
    // from = "queue" 或 "queue:<學生ID>"：標記完回到原本的清單
    const from = String(form.get("from") ?? "");
    if (from.startsWith("queue")) {
      const student = from.slice("queue:".length);
      return redirect(`/queue?${student ? `student=${encodeURIComponent(student)}&` : ""}m=${ok ? "dismissed" : "already_done"}`);
    }
    return back(ok ? "dismissed" : "already_done");
  }
  if (action === "reopen") return back((await reopen(env, q.id)) ? "reopened" : "already_done");
  if (action === "generate") {
    if (q.status !== "pending") return back("already_done");
    const result = await env.STUDENT_BUFFER.getByName(q.student_line_id).regenerate(q.id);
    return back(result.ok ? "generated" : `generate_failed_${result.kind}`);
  }
  return new Response("Not found", { status: 404 });
}

/** /settings：AI 設定。所有老師都能看；只有老師1（cheng_jie）能測試、套用、恢復預設、改回。 */
async function handleSettingsRoute(request: Request, env: Env, url: URL, role: Role, csrf: string): Promise<Response> {
  const show = async (extra: Partial<Parameters<typeof settingsPage>[0]> = {}) => {
    const [config, models, log] = await Promise.all([getAiConfig(env), listOpenAIModels(env), listSettingsLog(env)]);
    return page(settingsPage({ role, csrf, config, defaults: defaultAiConfig(env), models, log, flashCode: url.searchParams.get("m"), ...extra }));
  };
  if (request.method === "GET" && url.pathname === "/settings") return show();
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const form = await request.formData();
  if (!(await verifyCsrf(env, readCookie(request, SESSION_COOKIE), String(form.get("_csrf") ?? "")))) {
    console.log(JSON.stringify({ event: "csrf_rejected", path: url.pathname }));
    return new Response("Forbidden", { status: 403 });
  }
  if (role !== "cheng_jie") return redirect("/settings?m=settings_forbidden");

  const input: AiConfigInput = {
    modelImage: String(form.get("model_image") ?? "").trim(),
    modelText: String(form.get("model_text") ?? "").trim(),
    effort: String(form.get("effort") ?? "").trim(),
  };

  if (url.pathname === "/settings/test") {
    if (validateAiInput(input)) return redirect("/settings?m=settings_invalid");
    // 照片轉 base64 需要的 CPU 超過 Worker 上限，測試在 DO 裡跑
    const results = await env.STUDENT_BUFFER.getByName("__ai_settings_test__").testAiConfig(input);
    console.log(JSON.stringify({ event: "settings_tested", input, ok: results.map((r) => r.ok) }));
    return show({ tested: { input, results } });
  }
  if (url.pathname === "/settings") {
    if (validateAiInput(input)) return redirect("/settings?m=settings_invalid");
    await saveAiConfig(env, role, input);
    console.log(JSON.stringify({ event: "settings_saved", input }));
    return redirect("/settings?m=settings_saved");
  }
  if (url.pathname === "/settings/reset") {
    const d = defaultAiConfig(env);
    await saveAiConfig(env, role, { modelImage: d.modelImage, modelText: d.modelText, effort: d.effort });
    return redirect("/settings?m=settings_reset");
  }
  const revert = url.pathname.match(/^\/settings\/revert\/(\d+)$/);
  if (revert) return redirect(`/settings?m=${(await revertSetting(env, role, Number(revert[1]))) ? "settings_reverted" : "settings_invalid"}`);
  return new Response("Not found", { status: 404 });
}

/** /students/:lineId：GET 看學生資料與提問紀錄；POST 儲存老師設定的備註名稱、班級。 */
async function handleStudentRoute(request: Request, env: Env, url: URL, role: Role, csrf: string): Promise<Response> {
  const lineId = decodeURIComponent(url.pathname.slice("/students/".length));
  const student = await getStudent(env, lineId);
  if (!student) return page(notFoundPage(role, csrf), 404);

  if (request.method === "POST") {
    const form = await request.formData();
    if (!(await verifyCsrf(env, readCookie(request, SESSION_COOKIE), String(form.get("_csrf") ?? "")))) {
      console.log(JSON.stringify({ event: "csrf_rejected", path: url.pathname }));
      return new Response("Forbidden", { status: 403 });
    }
    await updateStudent(env, lineId, cleanField(form.get("display_name"), NAME_MAX), cleanField(form.get("class_name"), CLASS_MAX));
    console.log(JSON.stringify({ event: "student_updated", role }));
    return redirect(`/students/${encodeURIComponent(lineId)}?m=saved`);
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  return page(studentPage(role, student, await listStudentQuestions(env, lineId), csrf, url.searchParams.get("m")));
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/") return Response.json({ service: "line-tutor", phase: 3 });
    if (request.method === "POST" && pathname === "/webhook") return handleWebhook(request, env);

    if (pathname === "/static/app.css") return new Response(APP_CSS, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } });
    if (pathname === "/static/app.js") return new Response(APP_JS, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } });

    if (request.method === "POST" && !sameOrigin(request, url, env)) {
      console.log(JSON.stringify({ event: "origin_rejected", origin: request.headers.get("origin"), expected: url.origin, path: pathname }));
      return new Response("Forbidden", { status: 403 });
    }

    if (pathname === "/login") {
      if (request.method === "POST") return handleLogin(request, env);
      return page(loginPage(safeNext(url.searchParams.get("next")), url.searchParams.get("m")));
    }
    if (pathname === "/logout" && request.method === "POST") {
      const cookie = readCookie(request, SESSION_COOKIE);
      const form = await request.formData();
      if (cookie && !(await verifyCsrf(env, cookie, String(form.get("_csrf") ?? "")))) return new Response("Forbidden", { status: 403 });
      return redirect("/login?m=logged_out", { "Set-Cookie": clearSessionCookie() });
    }

    const protectedPath =
      pathname === "/queue" || pathname === "/students" || pathname === "/settings" || ["/queue/", "/review/", "/img/", "/students/", "/settings/"].some((p) => pathname.startsWith(p));
    if (protectedPath) {
      const role = await currentRole(request, env);
      if (!role) {
        if (request.method !== "GET") return redirect("/login");
        return redirect(`/login?next=${encodeURIComponent(pathname + url.search)}`);
      }
      const csrf = await csrfToken(env, readCookie(request, SESSION_COOKIE) ?? "");
      if (pathname === "/queue") {
        const studentId = url.searchParams.get("student") || null;
        const [lists, students, selected] = await Promise.all([
          listQueue(env, studentId),
          listStudents(env),
          studentId ? getStudent(env, studentId) : Promise.resolve(null),
        ]);
        return page(queuePage(role, lists, csrf, { students, selected }, url.searchParams.get("m")));
      }
      if (pathname === "/queue/dismiss-others" && request.method === "POST") {
        const form = await request.formData();
        if (!(await verifyCsrf(env, readCookie(request, SESSION_COOKIE), String(form.get("_csrf") ?? "")))) return new Response("Forbidden", { status: 403 });
        const student = String(form.get("student") ?? "") || null;
        const n = await dismissAllNonQuestions(env, role, student);
        console.log(JSON.stringify({ event: "dismiss_all_non_questions", role, count: n }));
        return redirect(`/queue?${student ? `student=${encodeURIComponent(student)}&` : ""}m=dismissed_all`);
      }
      if (pathname === "/students") return page(studentsPage(role, await listStudents(env), csrf));
      if (pathname.startsWith("/students/")) return handleStudentRoute(request, env, url, role, csrf);
      if (pathname === "/settings" || pathname.startsWith("/settings/")) return handleSettingsRoute(request, env, url, role, csrf);
      return handleReviewRoutes(request, env, ctx, url, role, csrf);
    }

    return new Response("Not found", { status: 404 });
  },

  // 每天：清除超過保存期限的照片與過期的 PIN 錯誤紀錄（排程見 wrangler.jsonc 的 triggers.crons）
  async scheduled(_controller, env): Promise<void> {
    const deleted = await deleteExpiredImages(env);
    await purgeOldFailures(env);
    console.log(JSON.stringify({ event: "daily_cleanup", deletedImages: deleted }));
  },
} satisfies ExportedHandler<Env>;
