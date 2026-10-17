// 安全的 HTML 樣板：插入的值預設全部跳脫，只有用 raw() 包起來的（自己產生的 HTML 片段）才原樣輸出
import { escapeHtml } from "./text";

export class SafeHtml {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

/** 標記為可信任的 HTML（只能用在程式自己產生的片段，絕不能包學生或 AI 的內容）。 */
export const raw = (value: string) => new SafeHtml(value);

function render(v: unknown): string {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return new SafeHtml(out);
}

/** 台灣時間（UTC+8，無日光節約）：10/18 15:49 */
export function formatTaipei(ms: number): string {
  const d = new Date(ms + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 多久以前：剛剛、5 分鐘前、3 小時前、2 天前 */
export function timeAgo(ms: number, now = Date.now()): string {
  const min = Math.floor((now - ms) / 60000);
  if (min < 1) return "剛剛";
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  return `${Math.floor(hr / 24)} 天前`;
}
