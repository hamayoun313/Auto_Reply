import { prisma } from "@/lib/db/client";
import { encryptToken } from "@/lib/meta/oauth";
import {
  brandNameMatches,
  fetchInstagramLinkedToFacebookPageDetailed,
  type FacebookPageIgLookupResult,
} from "@/lib/meta/page-token";

export type SyncedInstagramFromPage = {
  accountId: string;
  username: string;
  instagramId: string;
  previousInstagramId: string | null;
  created: boolean;
  source: string;
};

export type SyncInstagramFromPageResult = {
  synced: SyncedInstagramFromPage | null;
  lookup: FacebookPageIgLookupResult;
};

/**
 * After a Facebook Page is connected, upsert the linked Instagram professional
 * account using the Page token (works even when System User /me/accounts omits
 * the Page — e.g. همه کالا / @hamakala.af).
 */
export async function syncInstagramAccountFromFacebookPage(opts: {
  workspaceId: string;
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  /** When set, only update this account row (never create/overwrite others). */
  targetAccountId?: string;
}): Promise<SyncedInstagramFromPage | null> {
  const result = await syncInstagramAccountFromFacebookPageDetailed(opts);
  return result.synced;
}

export async function syncInstagramAccountFromFacebookPageDetailed(opts: {
  workspaceId: string;
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  targetAccountId?: string;
}): Promise<SyncInstagramFromPageResult> {
  const lookup = await fetchInstagramLinkedToFacebookPageDetailed({
    pageId: opts.pageId,
    pageAccessToken: opts.pageAccessToken,
  });
  const linked = lookup.linked;
  if (!linked?.instagramId) {
    console.warn(
      `[IG Sync] No Instagram linked on FB Page ${opts.pageName} (${opts.pageId}) tokenKind=${lookup.tokenKind}`,
      lookup.probes
    );
    return { synced: null, lookup };
  }

  const username = (linked.username ?? opts.pageName).replace(/^@/, "");
  const encrypted = encryptToken(linked.pageAccessToken);
  // Prefer parent Page token lifetime; fall back only if debug_token fails.
  let tokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  try {
    const { resolveStoredTokenExpiry } = await import(
      "@/lib/meta/token-lifetime"
    );
    tokenExpiresAt =
      (await resolveStoredTokenExpiry(linked.pageAccessToken)) ??
      tokenExpiresAt;
  } catch (err) {
    console.warn(
      "[IG Sync] Could not resolve token lifetime; keeping 60d sentinel:",
      err instanceof Error ? err.message : err
    );
  }

  const workspaceAccounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: opts.workspaceId, provider: "META" },
    select: { id: true, username: true, instagramId: true },
  });

  const byExactId = workspaceAccounts.find(
    (a) => a.instagramId === linked.instagramId
  );
  const byUsername = workspaceAccounts.find((a) =>
    brandNameMatches(a.username, username)
  );
  const byTarget = opts.targetAccountId
    ? workspaceAccounts.find((a) => a.id === opts.targetAccountId)
    : null;
  const target = byTarget ?? byExactId ?? byUsername ?? null;

  if (target) {
    const previousInstagramId = target.instagramId;
    // instagramId is unique: if another row already holds the live id, refresh
    // that row instead of moving the id onto the stale target (P2002).
    // Must run even when targetAccountId is set — posts repair previously
    // skipped this and crashed with Unique constraint failed.
    if (
      previousInstagramId !== linked.instagramId &&
      byExactId &&
      byExactId.id !== target.id
    ) {
      console.warn(
        `[IG Sync] @${username}: stale row ${target.id} (${previousInstagramId}) vs live row ${byExactId.id}; refreshing live row`
      );
      await prisma.instagramAccount.update({
        where: { id: byExactId.id },
        data: {
          username,
          accessToken: encrypted,
          tokenExpiresAt,
        },
      });
      return {
        synced: {
          accountId: byExactId.id,
          username,
          instagramId: linked.instagramId,
          previousInstagramId,
          created: false,
          source: linked.source,
        },
        lookup,
      };
    }

    console.info(
      `[IG Sync] Updating @${username}: ${previousInstagramId} → ${linked.instagramId} via ${linked.source}`
    );
    await prisma.instagramAccount.update({
      where: { id: target.id },
      data: {
        instagramId: linked.instagramId,
        username,
        accessToken: encrypted,
        tokenExpiresAt,
      },
    });
    return {
      synced: {
        accountId: target.id,
        username,
        instagramId: linked.instagramId,
        previousInstagramId,
        created: false,
        source: linked.source,
      },
      lookup,
    };
  }

  if (opts.targetAccountId) {
    return { synced: null, lookup };
  }

  console.info(
    `[IG Sync] Creating Instagram @${username} (${linked.instagramId}) from FB Page ${opts.pageName}`
  );
  const created = await prisma.instagramAccount.create({
    data: {
      workspaceId: opts.workspaceId,
      instagramId: linked.instagramId,
      username,
      name: opts.pageName,
      accessToken: encrypted,
      tokenExpiresAt,
      provider: "META",
      webhookSubscribed: false,
    },
  });
  return {
    synced: {
      accountId: created.id,
      username,
      instagramId: linked.instagramId,
      previousInstagramId: null,
      created: true,
      source: linked.source,
    },
    lookup,
  };
}
