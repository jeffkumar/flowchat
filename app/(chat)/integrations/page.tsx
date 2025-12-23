import { redirect } from "next/navigation";
import { Suspense } from "react";
import { auth } from "@/app/(auth)/auth";
import { IntegrationsHeader } from "@/components/integrations/integrations-header";
import { MicrosoftIntegrationCard } from "@/components/integrations/microsoft-integration-card";
import { SlackRetrievalToggle } from "@/components/integrations/slack-retrieval-toggle";

export default function Page() {
  return (
    <Suspense fallback={<div className="flex h-dvh" />}>
      <IntegrationsPage />
    </Suspense>
  );
}

async function IntegrationsPage() {
  const session = await auth();
  if (!session) {
    redirect("/api/auth/guest?redirectUrl=/integrations");
  }

  return (
    <>
      <IntegrationsHeader />
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Integrations</h1>
          <p className="text-sm text-muted-foreground">
            Connect external document sources and import files into your projects.
          </p>
        </div>

        <SlackRetrievalToggle />

        <div className="mt-6 space-y-4">
          <MicrosoftIntegrationCard />
        </div>
      </div>
    </>
  );
}


