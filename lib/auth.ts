import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cache } from "react";
import { db } from "./db";

/*
  Sessions and passwords, with nothing installed.

  Payroll holds the most sensitive data a small business has, so the two
  decisions that matter are made here and nowhere else:

  1. PASSWORDS ARE SCRYPT HASHES with a per-password salt. Not SHA, not
     MD5, not a plain string. A payroll database that leaks must not hand
     over working logins along with the salaries.

  2. EVERY QUERY IS SCOPED BY THE SESSION'S COMPANY. `requireUser()`
     returns the company id and no screen is allowed to look anything up
     without it. One tenant seeing another's salaries is the failure this
     product cannot recover from, so the scoping lives at the door rather
     than being remembered page by page.

  No library for either, because both are small, and a payroll product
  that cannot be audited by the person selling it is worth less.
*/

const COOKIE = "payroll_session";
/** Eight hours: a working day, so nobody comes back to a live session. */
const MAX_AGE = 60 * 60 * 8;

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error(
      "SESSION_SECRET is missing or too short. Put at least 32 random characters in .env.",
    );
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Passwords                                                           */
/* ------------------------------------------------------------------ */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const attempt = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  // Constant time: a comparison that returns early leaks how much of a
  // hash was right, one byte at a time.
  return attempt.length === expected.length && timingSafeEqual(attempt, expected);
}

/* ------------------------------------------------------------------ */
/* The session cookie                                                  */
/* ------------------------------------------------------------------ */

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

/**
 * A signed, self-contained cookie: user id and expiry, with an HMAC.
 *
 * No session table, because there is nothing to look up that the token
 * does not carry and the user record is read on every request anyway.
 * Signing is what stops someone editing the user id in their own cookie.
 */
function issue(userId: string) {
  const expires = Date.now() + MAX_AGE * 1000;
  const payload = `${userId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

function openToken(token: string | undefined): string | null {
  if (!token) return null;
  const [userId, expires, signature] = token.split(".");
  if (!userId || !expires || !signature) return null;

  const expected = sign(`${userId}.${expires}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expires) < Date.now()) return null;
  return userId;
}

/* ------------------------------------------------------------------ */
/* Reading the session                                                 */
/* ------------------------------------------------------------------ */

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: "OWNER" | "PAYROLL" | "VIEWER";
  companyId: string;
  companyName: string;
};

/**
 * The signed-in user, or null.
 *
 * Wrapped in React's `cache` so a page that checks the session three
 * times still makes one query per request.
 */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  const userId = openToken(token);
  if (!userId) return null;

  const user = await db.user.findUnique({
    where: { id: userId },
    include: { company: { select: { id: true, name: true } } },
  });
  // A disabled account stops working immediately, without waiting for
  // the cookie to expire.
  if (!user || !user.active) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
    companyName: user.company.name,
  };
});

/** For pages and actions: the user, or straight to the login screen. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/** For actions only payroll staff may take. */
export async function requirePayroll(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role === "VIEWER") {
    throw new Error("Your account can see reports, not change payroll.");
  }
  return user;
}

/**
 * Whether this person may see what an individual is paid.
 *
 * A viewer gets headcount and totals. Hiding figures in the markup is
 * not enough on its own, but it is the half that belongs in the screens;
 * the other half is that no query returns another company's rows at all.
 */
export const canSeeSalaries = (role: SessionUser["role"]) => role !== "VIEWER";

/* ------------------------------------------------------------------ */
/* Signing in and out                                                  */
/* ------------------------------------------------------------------ */

export async function signIn(email: string, password: string) {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });

  // The same message either way, and the hash is still computed when the
  // address is unknown: a faster "no such user" tells an attacker which
  // addresses exist.
  const ok = user?.active ? verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) {
    if (!user) verifyPassword(password, hashPassword("decoy"));
    return { error: "That email and password do not match." };
  }

  (await cookies()).set(COOKIE, issue(user.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });

  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return { error: null };
}

export async function signOut() {
  (await cookies()).delete(COOKIE);
}
