// Persian formatting helpers: Jalali dates, Persian digits, case numbers.

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

export const faDigits = (v: string | number) => String(v).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);

const dateFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric", month: "2-digit", day: "2-digit" });
const longDateFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { day: "numeric", month: "long", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit" });

export const jalaliDate = (t: number | Date = Date.now()) => dateFmt.format(t);
export const jalaliLong = (t: number | Date = Date.now()) => longDateFmt.format(t);
export const faTime = (t: number | Date = Date.now()) => timeFmt.format(t);

/** Short, stable case number for a conversation id: «۴۸۲۱-۷۳». */
export function caseNumber(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const n = String(h % 1_000_000).padStart(6, "0");
  return faDigits(`${n.slice(0, 4)}-${n.slice(4)}`);
}

/** «۵ دقیقه پیش», «دیروز», or a Jalali date for older items. */
export function relativeFa(t: number) {
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return "همین حالا";
  if (min < 60) return `${faDigits(min)} دقیقه پیش`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${faDigits(hr)} ساعت پیش`;
  const day = Math.round(hr / 24);
  if (day === 1) return "دیروز";
  if (day < 7) return `${faDigits(day)} روز پیش`;
  return jalaliDate(t);
}

export function bytesFa(n?: number) {
  if (n === undefined || !Number.isFinite(n)) return "–";
  const units = ["بایت", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${faDigits(v.toFixed(v < 10 && u > 0 ? 1 : 0))} ${units[u]}`;
}
