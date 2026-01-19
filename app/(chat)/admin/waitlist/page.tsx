import { redirect } from "next/navigation";
import { auth } from "@/app/(auth)/auth";
import { isAdminSession } from "@/lib/admin";
import { WaitlistAdmin } from "@/components/admin/waitlist-admin";

export default async function Page() {
  const session = await auth();
  if (!isAdminSession(session)) {
    redirect("/");
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Waitlist Management</h1>
        <p className="text-sm text-muted-foreground">
          Review and approve waitlist requests for Flowchat access.
        </p>
      </div>

      <div className="mt-6">
        <WaitlistAdmin />
      </div>
    </div>
  );
}
