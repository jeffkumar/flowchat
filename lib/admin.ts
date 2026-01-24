import "server-only";

import type { Session } from "next-auth";

export const ADMIN_EMAILS = [
  "jeffkumar.aw@gmail.com",
  "practicalmissions@gmail.com",
] as const;

export function isAdminSession(session: Session | null) {
  const email = session?.user?.email;
  return email !== undefined && ADMIN_EMAILS.includes(email as typeof ADMIN_EMAILS[number]);
}


