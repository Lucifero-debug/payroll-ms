import { NextResponse, type NextRequest } from "next/server";

/*
  A cheap first gate: no session cookie, no app.

  This only checks that a cookie EXISTS. It cannot verify the signature,
  because middleware runs on the edge runtime where node:crypto is not
  available, and it does not touch the database. Every page and action
  still calls requireUser(), which is where the real check happens.

  So the purpose here is a fast redirect for signed-out visitors, not
  security. Anything that relies on this alone is a hole.
*/

const PUBLIC = ["/login", "/setup"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC.some((path) => pathname.startsWith(path))) return NextResponse.next();

  if (!request.cookies.get("payroll_session")) {
    const login = new URL("/login", request.url);
    // Come back to where they were going once they are in.
    if (pathname !== "/") login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
