import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { syncInstagramAccountFromFacebookPage } from "@/lib/instagram/sync-from-facebook-page";
import { decryptToken } from "@/lib/meta/oauth";
import {
  brandNameMatches,
  canReadInstagramMedia,
  listLiveInstagramLinks,
  rematchInstagramByUsername,
} from "@/lib/meta/page-token";
import { requireSettingsUnlock } from "@/lib/settings-access";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";

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
            username: { equals: body.username.replace(/^@/, ""), mode: "insensitive" },
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
  try {
    const stored = decryptToken(account.accessToken);
    tokenOk = await canReadInstagramMedia(stored, account.instagramId);
    steps.push({
      step: "probe_stored",
      instagramId: account.instagramId,
      canRead: tokenOk,
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
    const updated = await prisma.instagramAccount.update({
      where: { id: account.id },
      data: {
        instagramId: rematch.instagramId,
        accessToken: (await import("@/lib/meta/oauth")).encryptToken(
          rematch.pageAccessToken
        ),
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
    })),
  });

  for (const page of pages) {
    if (
      !brandNameMatches(page.name, account.username) &&
      !brandNameMatches(page.name, "hamakala") &&
      !brandNameMatches(page.name, "همه کالا")
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
    const synced = await syncInstagramAccountFromFacebookPage({
      workspaceId,
      pageId: page.pageId,
      pageName: page.name,
      pageAccessToken: pageToken,
    });
    steps.push({
      step: "sync_from_facebook_page",
      page: page.name,
      synced,
    });
    if (synced) {
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
      message:
        "Instagram id is stale and همه کالا is not available on META_SYSTEM_USER_TOKEN. In Meta Business Suite assign Page «همه کالا» to the System User, generate a new token, paste it in Settings → connect the Facebook Page (Instagram will sync automatically). Or paste the همه کالا Page access token directly.",
      hint: {
        expectedUsername: "hamakala.af",
        staleInstagramId: account.instagramId,
        systemUserSeesHamakala: liveLinks.some((l) =>
          brandNameMatches(l.username, "hamakala")
        ),
        workspaceHasHamakalaFacebookPage: pages.some(
          (p) =>
            brandNameMatches(p.name, "hamakala") ||
            brandNameMatches(p.name, "همه کالا")
        ),
      },
    },
    { status: 422 }
  );
}
