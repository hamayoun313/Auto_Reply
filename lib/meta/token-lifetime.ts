/**
 * Resolve real Meta token lifetime via debug_token.
 *
 * Settings paste used to stamp +60 days blindly. Short-lived Graph Explorer
 * page tokens then died in ~1–2h while the UI still showed 2027 — that is what
 * produced the mass TokenExpiredError 190 this morning.
 */

import {
  getFacebookAppId,
  getFacebookAppSecret,
  getMetaGraphApiVersion,
} from "@/lib/env";

export type TokenLifetime = {
  /** null = Meta reports no expiry (typical durable Page / System User token). */
  expiresAt: Date | null;
  type: string | null;
  isValid: boolean;
  /** True when Meta will kill this token within the next 24 hours. */
  isShortLived: boolean;
};

const SHORT_LIVED_MAX_MS = 24 * 60 * 60 * 1000;

export class ShortLivedTokenError extends Error {
  constructor(expiresAt: Date | null) {
    const when = expiresAt ? expiresAt.toISOString() : "unknown";
    super(
      `Short-lived Meta token (expires ${when}). Do not paste Graph Explorer tokens from a short User session. Exchange the User token to long-lived first (fb_exchange_token), then re-run me/accounts and paste those Page tokens — or use a Business Manager System User token.`
    );
    this.name = "ShortLivedTokenError";
  }
}

function appAccessToken(): string {
  const appId = getFacebookAppId();
  const appSecret = getFacebookAppSecret();
  if (!appId || !appSecret) {
    throw new Error("FACEBOOK_APP_ID / FACEBOOK_APP_SECRET are required");
  }
  return `${appId}|${appSecret}`;
}

/**
 * Ask Meta how long this token actually lives.
 */
export async function inspectTokenLifetime(
  inputToken: string
): Promise<TokenLifetime> {
  const version = getMetaGraphApiVersion();
  const url = new URL(`https://graph.facebook.com/${version}/debug_token`);
  url.searchParams.set("input_token", inputToken);
  url.searchParams.set("access_token", appAccessToken());

  const response = await fetch(url.toString());
  const json = (await response.json()) as {
    data?: {
      is_valid?: boolean;
      expires_at?: number;
      data_access_expires_at?: number;
      type?: string;
      error?: { message?: string };
    };
    error?: { message?: string };
  };

  if (!response.ok || json.error) {
    throw new Error(
      `debug_token failed: ${json.error?.message || JSON.stringify(json)}`
    );
  }

  const data = json.data;
  if (!data) {
    throw new Error("debug_token returned no data");
  }

  // expires_at === 0 means never expires.
  const expiresAt =
    data.expires_at && data.expires_at > 0
      ? new Date(data.expires_at * 1000)
      : null;

  const isValid = data.is_valid !== false;
  const msLeft = expiresAt ? expiresAt.getTime() - Date.now() : Number.POSITIVE_INFINITY;
  const isShortLived = isValid && Number.isFinite(msLeft) && msLeft < SHORT_LIVED_MAX_MS;

  return {
    expiresAt,
    type: data.type ?? null,
    isValid,
    isShortLived,
  };
}

/**
 * Expiry to store in DB. Rejects short-lived tokens so we never again stamp
 * a fake +60 days on a 1–2 hour Graph Explorer session token.
 */
export async function resolveStoredTokenExpiry(
  accessToken: string
): Promise<Date | null> {
  const life = await inspectTokenLifetime(accessToken);
  if (!life.isValid) {
    throw new Error("Meta reports this access token is not valid");
  }
  if (life.isShortLived) {
    throw new ShortLivedTokenError(life.expiresAt);
  }
  // Durable Page/System User tokens often have expires_at=0. Keep a far
  // sentinel so dashboards that expect a date still work; cron refresh skips
  // null/far-future as needed.
  return life.expiresAt ?? new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
}
