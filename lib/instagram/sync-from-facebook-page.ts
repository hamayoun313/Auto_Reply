import { prisma } from "@/lib/db/client";
import { encryptToken } from "@/lib/meta/oauth";
import {
  brandNameMatches,
  fetchInstagramLinkedToFacebookPage,
} from "@/lib/meta/page-token";

export type SyncedInstagramFromPage = {
  accountId: string;
  username: string;
  instagramId: string;
  previousInstagramId: string | null;
  created: boolean;
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
}): Promise<SyncedInstagramFromPage | null> {
  const linked = await fetchInstagramLinkedToFacebookPage({
    pageId: opts.pageId,
    pageAccessToken: opts.pageAccessToken,
  });
  if (!linked?.instagramId) {
    console.warn(
      `[IG Sync] No instagram_business_account on FB Page ${opts.pageName} (${opts.pageId})`
    );
    return null;
  }

  const username = (linked.username ?? opts.pageName).replace(/^@/, "");
  const encrypted = encryptToken(linked.pageAccessToken);
  const tokenExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

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
  const target = byExactId ?? byUsername ?? null;

  if (target) {
    const previousInstagramId = target.instagramId;
    // If another row already owns the correct id, update that row's token instead.
    if (
      previousInstagramId !== linked.instagramId &&
      byExactId &&
      byUsername &&
      byExactId.id !== byUsername.id
    ) {
      console.warn(
        `[IG Sync] @${username}: stale row ${byUsername.id} (${previousInstagramId}) vs live row ${byExactId.id}; refreshing live row`
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
        accountId: byExactId.id,
        username,
        instagramId: linked.instagramId,
        previousInstagramId: byUsername.instagramId,
        created: false,
      };
    }

    console.info(
      `[IG Sync] Updating @${username}: ${previousInstagramId} → ${linked.instagramId}`
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
      accountId: target.id,
      username,
      instagramId: linked.instagramId,
      previousInstagramId,
      created: false,
    };
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
    accountId: created.id,
    username,
    instagramId: linked.instagramId,
    previousInstagramId: null,
    created: true,
  };
}
