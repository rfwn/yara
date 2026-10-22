import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { LiaraCreds } from "../liara";
import { decrypt, encrypt, hashPassword, newId, randomToken, sha256, verifyPassword } from "./crypto";
import { db } from "./db";

const COOKIE = "yara_session";
const SESSION_DAYS = 30;

export type User = {
  id: string;
  email: string;
  name: string;
  teamID: string | null;
  model: string | null;
  hasToken: boolean;
  createdAt: number;
};

type UserRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  liara_token_enc: string | null;
  team_id: string | null;
  model: string | null;
  created_at: number;
};

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  teamID: r.team_id,
  model: r.model,
  hasToken: !!r.liara_token_enc,
  createdAt: r.created_at,
});

export class AuthError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// ---- brute-force guard (per process; fine for a single instance) ----
const attempts = new Map<string, { n: number; reset: number }>();
function throttle(key: string, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) {
    attempts.set(key, { n: 1, reset: now + windowMs });
    return;
  }
  if (++a.n > max) throw new AuthError("تعداد تلاش‌ها زیاد بود. چند دقیقه بعد دوباره امتحان کنید.", 429);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function createUser(input: { name: string; email: string; password: string }, ip: string) {
  throttle(`signup:${ip}`, 5, 60 * 60 * 1000);
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (name.length < 2 || name.length > 60) throw new AuthError("نام باید بین ۲ تا ۶۰ نویسه باشد.");
  if (!EMAIL.test(email)) throw new AuthError("ایمیل معتبر نیست.");
  if (input.password.length < 8) throw new AuthError("رمز عبور باید دست‌کم ۸ نویسه باشد.");
  if (input.password.length > 200) throw new AuthError("رمز عبور بیش از حد طولانی است.");
  const exists = db().prepare("SELECT 1 FROM users WHERE email = ?").get(email);
  if (exists) throw new AuthError("با این ایمیل قبلاً حساب ساخته شده است. وارد شوید.", 409);
  const id = newId();
  db()
    .prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, email, name, hashPassword(input.password), Date.now());
  return id;
}

export function checkCredentials(emailRaw: string, password: string, ip: string) {
  const email = emailRaw.trim().toLowerCase();
  throttle(`login:${ip}`, 30);
  throttle(`login:${email}`);
  const row = db().prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
  // Hash anyway on a miss so timing doesn't reveal which emails exist.
  const ok = row ? verifyPassword(password, row.password_hash) : (verifyPassword(password, hashPassword("x")), false);
  if (!row || !ok) throw new AuthError("ایمیل یا رمز عبور درست نیست.", 401);
  return row.id;
}

export async function startSession(userId: string) {
  const token = randomToken();
  const now = Date.now();
  const expires = now + SESSION_DAYS * 86400_000;
  db().prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(sha256(token), userId, expires, now);
  db().prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expires),
  });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) db().prepare("DELETE FROM sessions WHERE id = ?").run(sha256(token));
  jar.delete(COOKIE);
}

function userRowFromToken(token: string | undefined): UserRow | null {
  if (!token) return null;
  const row = db()
    .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?")
    .get(sha256(token), Date.now()) as UserRow | undefined;
  return row ?? null;
}

export async function currentUser(): Promise<User | null> {
  const row = userRowFromToken((await cookies()).get(COOKIE)?.value);
  return row ? toUser(row) : null;
}

/** For pages: send signed-out visitors to /login, and users without a token to onboarding. */
export async function requireUser(opts: { needToken?: boolean } = {}): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (opts.needToken && !user.hasToken) redirect("/onboarding");
  return user;
}

/** For API routes: the user plus decrypted Liara credentials, or a 401 Response. */
export async function apiUser(): Promise<{ user: User; creds: LiaraCreds } | Response> {
  const row = userRowFromToken((await cookies()).get(COOKIE)?.value);
  if (!row) return Response.json({ error: "ابتدا وارد حساب خود شوید." }, { status: 401 });
  const token = row.liara_token_enc ? decrypt(row.liara_token_enc) : null;
  return { user: toUser(row), creds: { token: token ?? "", teamID: row.team_id ?? undefined } };
}

export function updateUserSettings(userId: string, s: { liaraToken?: string | null; teamID?: string | null; model?: string | null; name?: string }) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (s.liaraToken !== undefined) {
    sets.push("liara_token_enc = ?");
    vals.push(s.liaraToken ? encrypt(s.liaraToken) : null);
  }
  if (s.teamID !== undefined) {
    sets.push("team_id = ?");
    vals.push(s.teamID || null);
  }
  if (s.model !== undefined) {
    sets.push("model = ?");
    vals.push(s.model || null);
  }
  if (s.name !== undefined) {
    sets.push("name = ?");
    vals.push(s.name);
  }
  if (!sets.length) return;
  db()
    .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals, userId);
}

export function deleteUser(userId: string) {
  db().prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export function clientIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}
