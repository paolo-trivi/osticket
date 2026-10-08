import "server-only";

import { jwtVerify, SignJWT } from "jose";
import { cookies, headers } from "next/headers";

import { sessionSecret } from "../env";

/**
 * Sessioni della app Next: cookie firmati (JWT HS256), separati dalla sessione PHP (OSTSESSID).
 * Le regole replicano quelle di osTicket (doc 09 §7): timeout di inattività da config
 * (staff_/client_session_timeout), binding all'IP opzionale, invalidazione se cambia la password
 * (campo passwdreset) o se l'account viene disattivato (verificato a ogni richiesta).
 */
export type Realm = "staff" | "client";

export interface SessionPayload {
  realm: Realm;
  /** staff_id oppure user_id */
  uid: number;
  /** valore di passwdreset al login: se cambia, la sessione decade */
  pwv: string;
  ip: string;
  /** ultimo accesso (secondi epoch) per il timeout di inattività */
  last: number;
  /** login iniziato ma secondo fattore non ancora verificato */
  mfa?: "pending";
}

const COOKIE: Record<Realm, string> = {
  staff: "ostn_staff",
  client: "ostn_client",
};

export async function clientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : h.get("x-real-ip") ?? "").trim() || "0.0.0.0";
}

export async function writeSession(payload: SessionPayload): Promise<void> {
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .sign(sessionSecret());
  (await cookies()).set(COOKIE[payload.realm], token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

export async function readSession(realm: Realm): Promise<SessionPayload | null> {
  const token = (await cookies()).get(COOKIE[realm])?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSecret(), { algorithms: ["HS256"] });
    if (payload.realm !== realm || typeof payload.uid !== "number") return null;
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export async function clearSession(realm: Realm): Promise<void> {
  (await cookies()).delete(COOKIE[realm]);
}
