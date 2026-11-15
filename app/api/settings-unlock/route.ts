import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  SETTINGS_UNLOCK_COOKIE,
  getSettingsAccessCode,
  isSettingsUnlockCookieValue,
} from "@/lib/settings-access";

export const runtime = "nodejs";

function cookieSecure(): boolean {
  return (process.env.NEXTAUTH_URL ?? "").startsWith("https");
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ unlocked: false }, { status: 401 });
  }

  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SETTINGS_UNLOCK_COOKIE}=`))
    ?.split("=")[1];

  return NextResponse.json({
    unlocked: isSettingsUnlockCookieValue(cookie),
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expected = getSettingsAccessCode();
  if (!expected) {
    return NextResponse.json(
      { error: "Settings lock is disabled" },
      { status: 404 }
    );
  }

  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const code = String(body.code ?? "").trim();
  if (!code || code !== expected) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const res = NextResponse.json({ success: true, unlocked: true });
  res.cookies.set(SETTINGS_UNLOCK_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: cookieSecure(),
    maxAge: 12 * 60 * 60,
  });
  return res;
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const res = NextResponse.json({ success: true, unlocked: false });
  res.cookies.set(SETTINGS_UNLOCK_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: cookieSecure(),
    maxAge: 0,
  });
  return res;
}
