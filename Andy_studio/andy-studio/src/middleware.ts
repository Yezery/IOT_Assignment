import { type NextRequest, NextResponse } from "next/server";

export const config = {
  matcher: ["/", "/activate"],
};

export function middleware(request: NextRequest) {
  if (request.method === "POST") {
    const url = request.nextUrl.clone();
    if (request.nextUrl.pathname === "/activate") {
      url.pathname = "/api/v1/internal/activate";
    } else {
      url.pathname = "/api/v1/internal/ota";
    }
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}
