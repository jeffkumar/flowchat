"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useActionState, useEffect, useState } from "react";
import { WaitlistForm } from "@/components/waitlist-form";
import { SubmitButton } from "@/components/submit-button";
import { toast } from "@/components/toast";
import {
  type RequestWaitlistActionState,
  requestWaitlist,
} from "../actions";

export default function Page() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [isSuccessful, setIsSuccessful] = useState(false);

  const [state, formAction] = useActionState<
    RequestWaitlistActionState,
    FormData
  >(requestWaitlist, {
    status: "idle",
  });

  const { update: updateSession } = useSession();

  // biome-ignore lint/correctness/useExhaustiveDependencies: router and updateSession are stable refs
  useEffect(() => {
    if (state.status === "already_exists") {
      toast({
        type: "error",
        description: "A request with this email already exists!",
      });
    } else if (state.status === "failed") {
      toast({
        type: "error",
        description: "Failed to submit waitlist request!",
      });
    } else if (state.status === "invalid_data") {
      toast({
        type: "error",
        description: "Failed validating your submission! Please check all required fields are filled.",
      });
    } else if (state.status === "success") {
      setIsSuccessful(true);
      toast({
        type: "success",
        description: "Waitlist request submitted successfully!",
      });
      // Small delay to show success message before redirect
      setTimeout(() => {
        router.push("/waitlist-status");
      }, 500);
    }
  }, [state.status, router]);

  const handleSubmit = (formData: FormData) => {
    setEmail(formData.get("email") as string);
    formAction(formData);
  };

  return (
    <div className="flex h-dvh w-screen items-start justify-center bg-auth-charcoal py-12 md:items-center md:py-0">
      <div className="flex h-full max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-background md:max-h-[85vh]">
        <div className="flex shrink-0 flex-col items-center justify-center gap-2 border-b border-border px-4 py-6 text-center sm:px-16">
          <h1 className="font-semibold text-2xl text-brand">Flow Chat</h1>
          <p className="text-muted-foreground text-sm">
            Build and deploy agents with the right context
          </p>
          <p className="text-muted-foreground text-xs mt-2">
            Request access to Flow Chat
          </p>
        </div>
        <div className="flex-1 overflow-y-auto">
          <WaitlistForm action={handleSubmit} defaultEmail={email}>
            <SubmitButton isSuccessful={isSuccessful}>
              Request Access
            </SubmitButton>
            <p className="mt-4 text-center text-muted-foreground text-sm">
              {"Already have an account? "}
              <Link
                className="font-semibold text-brand hover:underline"
                href="/login"
              >
                Sign in
              </Link>
              {" instead."}
            </p>
          </WaitlistForm>
        </div>
      </div>
    </div>
  );
}
