import { prisma } from "@/lib/db/client";
import {
  createInstagramContext,
  hasInstagramCredentials,
  getUserMedia,
  type InstagramMedia,
} from "@/lib/instagram/provider";
import { createFacebookContext, hasFacebookCredentials } from "@/lib/facebook/context";
import { listFacebookPagePosts } from "@/lib/meta/facebook-messages";
import { resolveFacebookPageAccessToken } from "@/lib/meta/page-token";

function isReel(media: InstagramMedia): boolean {
  return media.media_product_type === "REELS";
}

export type AttachNextReelResult = {
  checked: number;
  bound: number;
  failedAccounts: number;
};

/**
 * Bind each pending "next post/reel" campaign to the earliest media published
 * after it was created.
 * - Instagram: next REEL (existing behaviour)
 * - Facebook: next Page post or reel
 */
export async function attachPendingNextReels(): Promise<AttachNextReelResult> {
  const pending = await prisma.automation.findMany({
    where: { pendingNextReel: true },
    include: { instagramAccount: true, facebookPage: true },
  });

  let checked = 0;
  let bound = 0;
  const failures = new Set<string>();

  // --- Instagram (by account) ---
  const byIgAccount = new Map<
    string,
    {
      account: NonNullable<(typeof pending)[number]["instagramAccount"]>;
      automations: typeof pending;
    }
  >();
  for (const automation of pending) {
    const key = automation.instagramAccountId;
    if (!key || !automation.instagramAccount || automation.facebookPageId) {
      continue;
    }
    const entry = byIgAccount.get(key);
    if (entry) entry.automations.push(automation);
    else
      byIgAccount.set(key, {
        account: automation.instagramAccount,
        automations: [automation],
      });
  }

  for (const { account, automations } of byIgAccount.values()) {
    checked += automations.length;
    if (!hasInstagramCredentials(account)) continue;

    let reels: InstagramMedia[];
    try {
      const context = await createInstagramContext(account);
      const media = await getUserMedia({ context, limit: 25 });
      reels = media
        .filter(isReel)
        .sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
    } catch (error) {
      failures.add(account.id);
      console.error("[attach-next-reel] IG media fetch failed", account.id, error);
      continue;
    }

    for (const automation of automations) {
      const nextReel = reels.find(
        (reel) => new Date(reel.timestamp) > automation.createdAt
      );
      if (!nextReel) continue;

      await prisma.automation.update({
        where: { id: automation.id },
        data: {
          postId: nextReel.id,
          postUrl: nextReel.permalink ?? null,
          pendingNextReel: false,
        },
      });
      bound += 1;
    }
  }

  // --- Facebook (by Page) ---
  const byFbPage = new Map<
    string,
    {
      page: NonNullable<(typeof pending)[number]["facebookPage"]>;
      automations: typeof pending;
    }
  >();
  for (const automation of pending) {
    const key = automation.facebookPageId;
    if (!key || !automation.facebookPage || automation.instagramAccountId) {
      continue;
    }
    const entry = byFbPage.get(key);
    if (entry) entry.automations.push(automation);
    else
      byFbPage.set(key, {
        page: automation.facebookPage,
        automations: [automation],
      });
  }

  for (const { page, automations } of byFbPage.values()) {
    checked += automations.length;
    if (!hasFacebookCredentials(page)) continue;

    let posts: Awaited<ReturnType<typeof listFacebookPagePosts>>;
    try {
      const ctx = createFacebookContext(page);
      const resolved = await resolveFacebookPageAccessToken({
        pageId: ctx.pageId,
        storedToken: ctx.accessToken,
      });
      posts = await listFacebookPagePosts(resolved.accessToken, ctx.pageId, 40);
      // Oldest-first so "next" = earliest after campaign creation.
      posts = [...posts].sort((a, b) => {
        const ta = a.created_time ? Date.parse(a.created_time) : 0;
        const tb = b.created_time ? Date.parse(b.created_time) : 0;
        return ta - tb;
      });
    } catch (error) {
      failures.add(page.id);
      console.error(
        "[attach-next-reel] FB posts fetch failed",
        page.id,
        error
      );
      continue;
    }

    for (const automation of automations) {
      const nextPost = posts.find((post) => {
        if (!post.created_time) return false;
        return Date.parse(post.created_time) > automation.createdAt.getTime();
      });
      if (!nextPost) continue;

      await prisma.automation.update({
        where: { id: automation.id },
        data: {
          postId: nextPost.id,
          postUrl: nextPost.permalink_url ?? null,
          pendingNextReel: false,
        },
      });
      bound += 1;
    }
  }

  return { checked, bound, failedAccounts: failures.size };
}
