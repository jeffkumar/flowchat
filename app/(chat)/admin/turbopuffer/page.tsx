import { redirect } from "next/navigation";
import { auth } from "@/app/(auth)/auth";
import { isAdminSession } from "@/lib/admin";
import { TurbopufferAdmin } from "@/components/admin/turbopuffer-admin";

export default async function Page() {
  const session = await auth();
  if (!isAdminSession(session)) {
    redirect("/");
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Turbopuffer Admin</h1>
        <p className="text-sm text-muted-foreground">
          List namespaces and permanently delete one.
        </p>
      </div>

      <div className="mt-6">
        <TurbopufferAdmin />
      </div>
    </div>
  );
}


