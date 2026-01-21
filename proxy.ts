import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { guestRegex, isDevelopmentEnvironment } from "./lib/constants";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  /*
   * Playwright starts the dev server and requires a 200 status to
   * begin the tests, so this ensures that the tests can start
   */
  if (pathname.startsWith("/ping")) {
    return new Response("pong", { status: 200 });
  }

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Fast-path for API routes: avoid `getToken()` (expensive in dev) and let each API route
  // enforce authorization as needed. We only block obviously-unauthenticated requests here.
  if (pathname.startsWith("/api/")) {
    const hasSessionCookie =
      request.cookies.get("authjs.session-token")?.value ||
      request.cookies.get("__Secure-authjs.session-token")?.value ||
      request.cookies.get("next-auth.session-token")?.value ||
      request.cookies.get("__Secure-next-auth.session-token")?.value;

    if (!hasSessionCookie) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.next();
  }

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  const isGuest = guestRegex.test(token?.email ?? "");

  // If not logged in (or guest), require sign-in / registration.
  if (!token || isGuest) {
    // Don't redirect auth API routes, return 401 so client fetches don't get HTML.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Allow access to auth pages.
    if (["/login", "/register"].includes(pathname)) {
      return NextResponse.next();
    }

    const redirectUrl = encodeURIComponent(request.url);
    return NextResponse.redirect(
      new URL(`/login?callbackUrl=${redirectUrl}`, request.url)
    );
  }

  // If logged in (non-guest), keep them out of auth pages.
  if (token && ["/login", "/register"].includes(pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/:path*",
    "/login",
    "/register",

    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.svg, sitemap.xml, robots.txt (metadata files)
     */
    "/((?!_next/static|_next/image|favicon.svg|sitemap.xml|robots.txt).*)",
  ],
};
