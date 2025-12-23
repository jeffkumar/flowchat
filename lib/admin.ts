import "server-only";

import type { Session } from "next-auth";

export const ADMIN_EMAIL = "jeffkumar.aw@gmail.com" as const;

export function isAdminSession(session: Session | null) {
  return session?.user?.email === ADMIN_EMAIL;
}


