import { getMetaGraphApiVersion } from "@/lib/env";
import { noteMetaAppUsageFromResponse } from "@/lib/meta/app-rate-limit-circuit";

function facebookGraphBase() {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

async function graphGet<T>(url: URL): Promise<T> {
  const response = await fetch(url.toString());
  await noteMetaAppUsageFromResponse(response).catch(() => {});
  const json = (await response.json()) as T & {
    error?: { message?: string; code?: number };
  };
  if (!response.ok || json.error) {
    throw new Error(json.error?.message ?? `Meta HTTP ${response.status}`);
  }
  return json;
}

function systemUserToken(): string | null {
  const token = process.env.META_SYSTEM_USER_TOKEN?.trim();
  return token || null;
}

function isMissingAccountsFieldError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("nonexisting field (accounts)") ||
    message.includes("nonexisting field (accounts)") ||
    /Tried accessing nonexisting field \(accounts\)/i.test(message)
  );
}

/**
 * Probe whether a token can act as this Facebook Page for read edges.
 * System User tokens often list /me/accounts but fail on /{page-id}/posts.
 */
export async function canReadFacebookPagePosts(
  accessToken: string,
  pageId: string
): Promise<boolean> {
  try {
    const url = new URL(`${facebookGraphBase()}/${pageId}/posts`);
    url.searchParams.set("fields", "id");
    url.searchParams.set("limit", "1");
    url.searchParams.set("access_token", accessToken);
    await graphGet(url);
    return true;
  } catch {
    return false;
  }
}

export async function canReadInstagramMedia(
  accessToken: string,
  instagramId: string
): Promise<boolean> {
  try {
    const url = new URL(`${facebookGraphBase()}/${instagramId}/media`);
    url.searchParams.set("fields", "id");
    url.searchParams.set("limit", "1");
    url.searchParams.set("access_token", accessToken);
    await graphGet(url);
    return true;
  } catch {
    return false;
  }
}

type PageWithTokens = {
  id: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id?: string; username?: string };
};

/**
 * Load Page-scoped tokens via /me/accounts.
 * Only works with User / System User tokens — Page tokens throw (#100 accounts).
 */
export async function listPagesWithAccessTokens(
  accessToken: string
): Promise<PageWithTokens[]> {
  const url = new URL(`${facebookGraphBase()}/me/accounts`);
  url.searchParams.set(
    "fields",
    "id,name,access_token,instagram_business_account{id,username}"
  );
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", accessToken);
  try {
    const data = await graphGet<{ data?: PageWithTokens[] }>(url);
    return data.data ?? [];
  } catch (error) {
    if (isMissingAccountsFieldError(error)) {
      // Page access tokens have no /me/accounts edge.
      return [];
    }
    throw error;
  }
}

/** Resolve a Page access token that can read posts for this Page. */
export async function resolveFacebookPageAccessToken(opts: {
  pageId: string;
  storedToken: string;
}): Promise<{ accessToken: string; refreshed: boolean }> {
  if (await canReadFacebookPagePosts(opts.storedToken, opts.pageId)) {
    return { accessToken: opts.storedToken, refreshed: false };
  }

  // Only System User tokens may call /me/accounts. Never use a Page token here.
  const su = systemUserToken();
  if (su) {
    try {
      const pages = await listPagesWithAccessTokens(su);
      const match = pages.find((p) => p.id === opts.pageId);
      const pageToken = match?.access_token?.trim();
      if (
        pageToken &&
        (await canReadFacebookPagePosts(pageToken, opts.pageId))
      ) {
        return { accessToken: pageToken, refreshed: true };
      }
    } catch (error) {
      console.warn(
        "[Meta] resolveFacebookPageAccessToken via /me/accounts failed:",
        error instanceof Error ? error.message : error
      );
    }

    try {
      const url = new URL(`${facebookGraphBase()}/${opts.pageId}`);
      url.searchParams.set("fields", "id,access_token");
      url.searchParams.set("access_token", su);
      const page = await graphGet<{ id?: string; access_token?: string }>(url);
      const pageToken = page.access_token?.trim();
      if (
        pageToken &&
        (await canReadFacebookPagePosts(pageToken, opts.pageId))
      ) {
        return { accessToken: pageToken, refreshed: true };
      }
    } catch {
      // fall through
    }
  }

  return { accessToken: opts.storedToken, refreshed: false };
}

/**
 * Resolve a token that can list Instagram media for this IG business account.
 * Page-scoped tokens work; never call /me/accounts with a Page token.
 */
export async function resolveInstagramMediaAccessToken(opts: {
  instagramId: string;
  storedToken: string;
  /** Optional Facebook Page Graph id if already known. */
  facebookPageId?: string | null;
}): Promise<{ accessToken: string; refreshed: boolean }> {
  if (await canReadInstagramMedia(opts.storedToken, opts.instagramId)) {
    return { accessToken: opts.storedToken, refreshed: false };
  }

  const su = systemUserToken();
  if (su) {
    try {
      const pages = await listPagesWithAccessTokens(su);
      const match =
        pages.find(
          (p) => p.instagram_business_account?.id === opts.instagramId
        ) ??
        (opts.facebookPageId
          ? pages.find((p) => p.id === opts.facebookPageId)
          : undefined);
      const pageToken = match?.access_token?.trim();
      if (
        pageToken &&
        (await canReadInstagramMedia(pageToken, opts.instagramId))
      ) {
        return { accessToken: pageToken, refreshed: true };
      }
    } catch (error) {
      console.warn(
        "[Meta] resolveInstagramMediaAccessToken via /me/accounts failed:",
        error instanceof Error ? error.message : error
      );
    }
  }

  return { accessToken: opts.storedToken, refreshed: false };
}

/** Map Instagram business account id → Page access token from a SU/user token. */
export async function mapInstagramIdsToPageTokens(
  accessToken: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const pages = await listPagesWithAccessTokens(accessToken);
    for (const page of pages) {
      const igId = page.instagram_business_account?.id;
      const pageToken = page.access_token?.trim();
      if (igId && pageToken) map.set(igId, pageToken);
    }
  } catch (error) {
    console.warn(
      "[Meta] mapInstagramIdsToPageTokens failed:",
      error instanceof Error ? error.message : error
    );
  }
  return map;
}

export type LiveInstagramLink = {
  instagramId: string;
  username: string;
  pageId: string;
  pageName: string;
  pageAccessToken: string;
};

/** Live IG accounts linked to Pages for this System User / user token. */
export async function listLiveInstagramLinks(
  accessToken?: string | null
): Promise<LiveInstagramLink[]> {
  // Prefer System User — Page tokens cannot call /me/accounts.
  const token = systemUserToken() || accessToken?.trim() || null;
  if (!token) return [];
  try {
    const pages = await listPagesWithAccessTokens(token);
    const links: LiveInstagramLink[] = [];
    for (const page of pages) {
      const igId = page.instagram_business_account?.id?.trim();
      const username = page.instagram_business_account?.username?.trim();
      const pageToken = page.access_token?.trim();
      if (!igId || !username || !pageToken || !page.id) continue;
      links.push({
        instagramId: igId,
        username,
        pageId: page.id,
        pageName: page.name ?? page.id,
        pageAccessToken: pageToken,
      });
    }
    return links;
  } catch (error) {
    if (isMissingAccountsFieldError(error)) return [];
    throw error;
  }
}

/**
 * Stale DB rows sometimes keep an old Instagram business id (Graph #100/33).
 * Rematch by username against live Page→IG links (System User only).
 */
export async function rematchInstagramByUsername(opts: {
  username: string;
  /** Ignored for /me/accounts — kept for API compat. Always uses System User. */
  accessToken?: string | null;
}): Promise<LiveInstagramLink | null> {
  const needle = opts.username.trim().replace(/^@/, "").toLowerCase();
  if (!needle) return null;
  // Never pass a Page token into /me/accounts.
  const links = await listLiveInstagramLinks(null);
  return (
    links.find((l) => l.username.toLowerCase() === needle) ??
    links.find((l) => brandNameMatches(l.username, needle)) ??
    null
  );
}

export type FacebookPageIgLookup = {
  instagramId: string;
  username?: string;
  pageAccessToken: string;
  pageId: string;
  source: string;
};

export type FacebookPageIgLookupResult = {
  linked: FacebookPageIgLookup | null;
  /** Safe Graph diagnostics for UI / logs (no tokens). */
  probes: Array<Record<string, unknown>>;
  tokenKind: "page" | "system_user_or_user" | "unknown";
};

/**
 * Inspect what kind of token we have. Page tokens cannot call /me/accounts
 * (Meta returns nonexisting field accounts). Do not use listPagesWithAccessTokens
 * here — it swallows that error into [].
 */
export async function inspectTokenKind(
  accessToken: string
): Promise<"page" | "system_user_or_user" | "unknown"> {
  try {
    const url = new URL(`${facebookGraphBase()}/me/accounts`);
    url.searchParams.set("fields", "id");
    url.searchParams.set("limit", "1");
    url.searchParams.set("access_token", accessToken);
    await graphGet(url);
    return "system_user_or_user";
  } catch (error) {
    if (isMissingAccountsFieldError(error)) return "page";
  }
  try {
    const me = new URL(`${facebookGraphBase()}/me`);
    me.searchParams.set("fields", "id,name");
    me.searchParams.set("access_token", accessToken);
    await graphGet(me);
    // /me works for Page tokens too (returns the Page). Reaching here means
    // /me/accounts failed for a non-accounts-field reason.
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Read Instagram business account linked to a Facebook Page using a Page token.
 * Tries several Graph shapes because Meta returns IG under different fields
 * depending on Page experience / permissions.
 */
export async function fetchInstagramLinkedToFacebookPage(opts: {
  pageId: string;
  pageAccessToken: string;
}): Promise<FacebookPageIgLookup | null> {
  const result = await fetchInstagramLinkedToFacebookPageDetailed(opts);
  return result.linked;
}

export async function fetchInstagramLinkedToFacebookPageDetailed(opts: {
  pageId: string;
  pageAccessToken: string;
}): Promise<FacebookPageIgLookupResult> {
  const probes: Array<Record<string, unknown>> = [];
  const tokenKind = await inspectTokenKind(opts.pageAccessToken);
  probes.push({ step: "token_kind", tokenKind, pageId: opts.pageId });

  const tryParseIg = (
    source: string,
    ig?: { id?: string; username?: string } | null,
    pageId?: string
  ): FacebookPageIgLookup | null => {
    const igId = ig?.id?.trim();
    if (!igId) return null;
    return {
      instagramId: igId,
      username: ig?.username,
      pageAccessToken: opts.pageAccessToken,
      pageId: pageId ?? opts.pageId,
      source,
    };
  };

  // 1) Classic Page field
  try {
    const url = new URL(`${facebookGraphBase()}/${opts.pageId}`);
    url.searchParams.set(
      "fields",
      "id,name,instagram_business_account{id,username}"
    );
    url.searchParams.set("access_token", opts.pageAccessToken);
    const page = await graphGet<{
      id?: string;
      name?: string;
      instagram_business_account?: { id?: string; username?: string };
    }>(url);
    probes.push({
      step: "instagram_business_account",
      ok: true,
      pageGraphId: page.id,
      pageName: page.name,
      hasIg: Boolean(page.instagram_business_account?.id),
      igId: page.instagram_business_account?.id ?? null,
      igUsername: page.instagram_business_account?.username ?? null,
    });
    const linked = tryParseIg(
      "instagram_business_account",
      page.instagram_business_account,
      page.id
    );
    if (linked) return { linked, probes, tokenKind };
  } catch (error) {
    probes.push({
      step: "instagram_business_account",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 2) Page-backed IG accounts edge (common for New Pages Experience)
  try {
    const url = new URL(
      `${facebookGraphBase()}/${opts.pageId}/page_backed_instagram_accounts`
    );
    url.searchParams.set("fields", "id,username,name");
    url.searchParams.set("access_token", opts.pageAccessToken);
    const data = await graphGet<{
      data?: Array<{ id?: string; username?: string }>;
    }>(url);
    const first = data.data?.[0];
    probes.push({
      step: "page_backed_instagram_accounts",
      ok: true,
      count: data.data?.length ?? 0,
      firstId: first?.id ?? null,
      firstUsername: first?.username ?? null,
    });
    const linked = tryParseIg("page_backed_instagram_accounts", first);
    if (linked) return { linked, probes, tokenKind };
  } catch (error) {
    probes.push({
      step: "page_backed_instagram_accounts",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 3) connected_instagram_account
  try {
    const url = new URL(`${facebookGraphBase()}/${opts.pageId}`);
    url.searchParams.set(
      "fields",
      "id,name,connected_instagram_account{id,username}"
    );
    url.searchParams.set("access_token", opts.pageAccessToken);
    const page = await graphGet<{
      id?: string;
      connected_instagram_account?: { id?: string; username?: string };
    }>(url);
    probes.push({
      step: "connected_instagram_account",
      ok: true,
      hasIg: Boolean(page.connected_instagram_account?.id),
      igId: page.connected_instagram_account?.id ?? null,
    });
    const linked = tryParseIg(
      "connected_instagram_account",
      page.connected_instagram_account,
      page.id
    );
    if (linked) return { linked, probes, tokenKind };
  } catch (error) {
    probes.push({
      step: "connected_instagram_account",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 4) If token looks like System User, explain why Page IG lookup fails.
  if (tokenKind === "system_user_or_user") {
    probes.push({
      step: "diagnosis",
      issue:
        "Stored token behaves like System User/User token, not a Page token. System User cannot read همه کالا unless that Page is assigned. Re-paste the همه کالا Page access token in Settings.",
    });
  }

  return { linked: null, probes, tokenKind };
}

export function brandNameMatches(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0640\u200c\u200d]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "");
  const stems = (s: string) => {
    const full = norm(s);
    const head = norm((s.split(/[._\s-]+/)[0] ?? s).trim());
    return Array.from(new Set([full, head].filter((x) => x.length >= 3)));
  };
  const as = stems(a);
  const bs = stems(b);
  for (const x of as) {
    for (const y of bs) {
      if (x === y || x.includes(y) || y.includes(x)) return true;
    }
  }
  return false;
}
