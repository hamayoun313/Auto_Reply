import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const SETTINGS_UNLOCK_COOKIE = "rahbin-settings-unlock";

/** Password for the Settings page (token paste / connections). */
export function getSettingsAccessCode(): string {
  return (process.env.SETTINGS_ACCESS_CODE ?? "rahbin@123").trim();
}

export function isSettingsUnlockCookieValue(value: string | undefined): boolean {
  return value === "1";
}

export async function hasSettingsUnlock(): Promise<boolean> {
  const jar = await cookies();
  return isSettingsUnlockCookieValue(jar.get(SETTINGS_UNLOCK_COOKIE)?.value);
}

/** Block token connect/disconnect APIs until Settings is unlocked. */
export async function requireSettingsUnlock(): Promise<NextResponse | null> {
  if (await hasSettingsUnlock()) return null;
  return NextResponse.json(
    { error: "settings_locked", message: "Unlock Settings with the password first." },
    { status: 403 }
  );
}
