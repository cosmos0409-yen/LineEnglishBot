import { verifySignature } from "./line";
import type { BufferedMessage } from "./buffer";

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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ service: "line-tutor", phase: 1 });
    }
    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
