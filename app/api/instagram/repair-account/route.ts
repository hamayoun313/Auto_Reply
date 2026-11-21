import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { syncInstagramAccountFromFacebookPageDetailed } from "@/lib/instagram/sync-from-facebook-page";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import {
  brandNameMatches,
  canReadInstagramMedia,
  inspectTokenKind,
  listLiveInstagramLinks,
  rematchInstagramByUsername,
} from "@/lib/meta/page-token";
import { requireSettingsUnlock } from "@/lib/settings-access";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

function isHamakalaName(name: string): boolean {
  return (
    brandNameMatches(name, "hamakala") ||
    brandNameMatches(name, "همه کالا") ||
    brandNameMatches(name, "همه‌کالا")
  );
}

/**
 * Diagnose + repair a stale Instagram business id (Graph #100/33).
 * Tries System User rematch, then linked Facebook Pages in the workspace.
 */
export async function POST(request: NextRequest) {
  const locked = await requireSettingsUnlock();
  if (locked) return locked;

  const context = await getCurrentWorkspaceContext();
  if (!context || !canManageWorkspace(context.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    instagramAccountId?: string;
    username?: string;
  } | null;

  const account = body?.instagramAccountId
    ? await prisma.instagramAccount.findFirst({
        where: { id: body.instagramAccountId, workspaceId },
      })
    : body?.username
      ? await prisma.instagramAccount.findFirst({
          where: {
            workspaceId,
            username: {
              equals: body.username.replace(/^@/, ""),
              mode: "insensitive",
            },
          },
        })
      : await prisma.instagramAccount.findFirst({
          where: {
            workspaceId,
            OR: [
              { username: { contains: "hamakala", mode: "insensitive" } },
              { username: { contains: "hama", mode: "insensitive" } },
            ],
          },
        });

  if (!account) {
    return NextResponse.json(
      {
        success: false,
        error: "instagram_account_not_found",
        message: "No matching Instagram account in this workspace.",
      },
      { status: 404 }
    );
  }

  const steps: Array<Record<string, unknown>> = [];
  let tokenOk = false;
  let storedToken: string | null = null;
  try {
    storedToken = decryptToken(account.accessToken);
    tokenOk = await canReadInstagramMedia(storedToken, account.instagramId);
    steps.push({
      step: "probe_stored",
      instagramId: account.instagramId,
      canRead: tokenOk,
      tokenKind: await inspectTokenKind(storedToken).catch(() => "unknown"),
    });
  } catch (error) {
    steps.push({
      step: "probe_stored",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (tokenOk) {
    return NextResponse.json({
      success: true,
      repaired: false,
      account: {
        id: account.id,
        username: account.username,
        instagramId: account.instagramId,
      },
      steps,
      message: "Stored Instagram id already works.",
    });
  }

  const liveLinks = await listLiveInstagramLinks(null).catch((error) => {
    steps.push({
      step: "list_live_links",
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  });
  steps.push({
    step: "list_live_links",
    count: liveLinks.length,
    usernames: liveLinks.map((l) => l.username),
  });

  const rematch = await rematchInstagramByUsername({
    username: account.username,
  }).catch((error) => {
    steps.push({
      step: "rematch_username",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  steps.push({
    step: "rematch_username",
    found: Boolean(rematch),
    match: rematch
      ? {
          username: rematch.username,
          instagramId: rematch.instagramId,
          pageName: rematch.pageName,
        }
      : null,
  });

  if (rematch) {
    const mediaOk = await canReadInstagramMedia(
      rematch.pageAccessToken,
      rematch.instagramId
    );
    steps.push({
      step: "verify_rematch_media",
      canRead: mediaOk,
      instagramId: rematch.instagramId,
    });
    if (mediaOk) {
      const updated = await prisma.instagramAccount.update({
        where: { id: account.id },
        data: {
          instagramId: rematch.instagramId,
          accessToken: encryptToken(rematch.pageAccessToken),
          tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
          username: rematch.username,
        },
      });
      return NextResponse.json({
        success: true,
        repaired: true,
        via: "system_user",
        account: {
          id: updated.id,
          username: updated.username,
          instagramId: updated.instagramId,
          previousInstagramId: account.instagramId,
        },
        steps,
      });
    }
  }

  const pages = await prisma.facebookPage.findMany({
    where: { workspaceId },
    select: { id: true, pageId: true, name: true, accessToken: true },
  });
  steps.push({
    step: "workspace_facebook_pages",
    pages: pages.map((p) => ({
      name: p.name,
      pageId: p.pageId,
      nameMatch: brandNameMatches(p.name, account.username),
      matchesHamakala: isHamakalaName(p.name),
    })),
  });

  for (const page of pages) {
    if (
      !brandNameMatches(page.name, account.username) &&
      !isHamakalaName(page.name)
    ) {
      continue;
    }
    let pageToken: string;
    try {
      pageToken = decryptToken(page.accessToken);
    } catch (error) {
      steps.push({
        step: "decrypt_page_token",
        page: page.name,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const tokenKind = await inspectTokenKind(pageToken);
    steps.push({
      step: "fb_page_token_kind",
      page: page.name,
      tokenKind,
    });

    const storedStillWorks = await canReadInstagramMedia(
      pageToken,
      account.instagramId
    );
    steps.push({
      step: "page_token_reads_stored_ig",
      page: page.name,
      canRead: storedStillWorks,
      storedInstagramId: account.instagramId,
    });
    if (storedStillWorks) {
      const updated = await prisma.instagramAccount.update({
        where: { id: account.id },
        data: {
          accessToken: encryptToken(pageToken),
          tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        },
      });
      return NextResponse.json({
        success: true,
        repaired: true,
        via: "facebook_page_token_restore",
        account: {
          id: updated.id,
          username: updated.username,
          instagramId: updated.instagramId,
          previousInstagramId: account.instagramId,
        },
        steps,
      });
    }

    const { synced, lookup } =
      await syncInstagramAccountFromFacebookPageDetailed({
        workspaceId,
        pageId: page.pageId,
        pageName: page.name,
        pageAccessToken: pageToken,
        targetAccountId: account.id,
      });
    steps.push({
      step: "sync_from_facebook_page",
      page: page.name,
      tokenKind: lookup.tokenKind,
      probes: lookup.probes,
      synced,
    });
    if (synced) {
      const mediaOk = await canReadInstagramMedia(
        pageToken,
        synced.instagramId
      );
      steps.push({
        step: "verify_synced_media",
        canRead: mediaOk,
        instagramId: synced.instagramId,
      });
      if (!mediaOk) continue;
      return NextResponse.json({
        success: true,
        repaired: true,
        via: "facebook_page",
        account: {
          id: synced.accountId,
          username: synced.username,
          instagramId: synced.instagramId,
          previousInstagramId: synced.previousInstagramId,
        },
        steps,
      });
    }
  }

  const pageTokenIsSu = steps.some(
    (s) =>
      s.step === "fb_page_token_kind" && s.tokenKind === "system_user_or_user"
  );

  return NextResponse.json(
    {
      success: false,
      repaired: false,
      error: "repair_failed",
      account: {
        id: account.id,
        username: account.username,
        instagramId: account.instagramId,
      },
      steps,
      message: pageTokenIsSu
        ? "Instagram id is stale and the connected همه کالا Facebook Page token behaves like System User, not a Page token. Paste the همه کالا Page access token in Settings (or assign the Page to the System User and reconnect)."
        : "Instagram id is stale and همه کالا is not available on META_SYSTEM_USER_TOKEN. In Meta Business Suite assign Page «همه کالا» to the System User, generate a new token, paste it in Settings → connect the Facebook Page (Instagram will sync automatically). Or paste the همه کالا Page access token directly.",
      hint: {
        expectedUsername: "hamakala.af",
        staleInstagramId: account.instagramId,
        systemUserSeesHamakala: liveLinks.some((l) =>
          brandNameMatches(l.username, "hamakala")
        ),
        workspaceHasHamakalaFacebookPage: pages.some(
          (p) =>
            brandNameMatches(p.name, "hamakala") || isHamakalaName(p.name)
        ),
        pageTokenLooksLikeSystemUser: pageTokenIsSu,
      },
    },
    { status: 422 }
  );
}
