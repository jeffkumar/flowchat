"use client";

import Link from "next/link";

export default function Page() {
  return (
    <div className="flex h-dvh w-screen items-start justify-center bg-auth-charcoal py-12 md:items-center md:py-0">
      <div className="flex w-full max-w-md flex-col gap-8 overflow-hidden rounded-2xl border border-border bg-background py-10">
        <div className="flex flex-col items-center justify-center gap-4 px-4 text-center sm:px-16">
          <h1 className="font-semibold text-2xl text-brand">Flow Chat</h1>
          <p className="text-muted-foreground text-sm">
            Build and deploy agents with the right context
          </p>
        </div>

        <div className="flex flex-col gap-4 px-4 sm:px-16">
          <div className="flex flex-col gap-2 text-center">
            <h2 className="font-semibold text-lg">You&apos;ve joined the waitlist</h2>
            <p className="text-muted-foreground text-sm">
              Thank you for your interest in Flow Chat. We&apos;ve received your
              request and will review it shortly.
            </p>
            <p className="text-muted-foreground text-sm mt-2">
              You&apos;ll be notified when you&apos;re verified and approved. Once
              approved, you&apos;ll be able to create your account and start using
              Flow Chat.
            </p>
          </div>

          <div className="mt-4">
            <Link
              className="flex w-full items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
              href="/login"
            >
              Back to Login
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
