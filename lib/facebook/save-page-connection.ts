import { prisma } from "@/lib/db/client";
import { canConnectFacebookPage } from "@/lib/facebook-pages";
import { syncInstagramAccountFromFacebookPage } from "@/lib/instagram/sync-from-facebook-page";
import { subscribeFacebookPageToWebhooks } from "@/lib/meta/facebook-pages";
import { encryptToken } from "@/lib/meta/oauth";
import { resolveStoredTokenExpiry } from "@/lib/meta/token-lifetime";

export type SaveFacebookPageInput = {
  workspaceId: string;
  page: { id: string; name: string; accessToken: string };
};

export type SaveFacebookPageResult =
  | {
      ok: true;
      pageId: string;
      name: string;
      webhookSubscribed: boolean;
      syncedInstagram?: {
        username: string;
        instagramId: string;
        previousInstagramId: string | null;
      } | null;
    }
  | { ok: false; reason: "already_connected" };

/**
 * Upsert one Facebook Page into the workspace and subscribe webhooks.
 */
export async function saveFacebookPageConnection(
  input: SaveFacebookPageInput
): Promise<SaveFacebookPageResult> {
  const connection = await canConnectFacebookPage({
    workspaceId: input.workspaceId,
    pageId: input.page.id,
  });
  if (!connection.allowed) {
    return { ok: false, reason: "already_connected" };
  }

  let webhookSubscribed = false;
  try {
    const subscription = await subscribeFacebookPageToWebhooks(
      input.page.id,
      input.page.accessToken
    );
    webhookSubscribed = Boolean(
      (subscription as { success?: boolean }).success ?? true
    );
  } catch (subscriptionError) {
    console.warn(
      "[Facebook Connect] Webhook subscription failed:",
      subscriptionError
    );
  }

  const encryptedToken = encryptToken(input.page.accessToken);
  // Real Meta lifetime — never stamp a fake +60 days on short-lived tokens.
  const tokenExpiresAt = await resolveStoredTokenExpiry(input.page.accessToken, {
    pageId: input.page.id,
  });
  const data = {
    name: input.page.name,
    accessToken: encryptedToken,
    tokenExpiresAt,
    webhookSubscribed,
  };

  const existing = await prisma.facebookPage.findUnique({
    where: { pageId: input.page.id },
  });
  if (existing) {
    const updated = await prisma.facebookPage.updateMany({
      where: {
        id: existing.id,
        workspaceId: input.workspaceId,
      },
      data,
    });
    if (!updated.count) {
      return { ok: false, reason: "already_connected" };
    }
  } else {
    await prisma.facebookPage.create({
      data: {
        ...data,
        pageId: input.page.id,
        workspaceId: input.workspaceId,
      },
    });
  }

  let syncedInstagram: {
    username: string;
    instagramId: string;
    previousInstagramId: string | null;
  } | null = null;
  try {
    const synced = await syncInstagramAccountFromFacebookPage({
      workspaceId: input.workspaceId,
      pageId: input.page.id,
      pageName: input.page.name,
      pageAccessToken: input.page.accessToken,
    });
    if (synced) {
      syncedInstagram = {
        username: synced.username,
        instagramId: synced.instagramId,
        previousInstagramId: synced.previousInstagramId,
      };
    }
  } catch (error) {
    console.warn(
      "[Facebook Connect] IG sync from Page failed:",
      error instanceof Error ? error.message : error
    );
  }

  return {
    ok: true,
    pageId: input.page.id,
    name: input.page.name,
    webhookSubscribed,
    syncedInstagram,
  };
}
