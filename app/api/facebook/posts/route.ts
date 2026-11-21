import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { createFacebookContext } from "@/lib/facebook/context";
import {
  getFacebookPostCommentCount,
  listFacebookPagePosts,
  resolveFacebookPostFromUrl,
} from "@/lib/meta/facebook-messages";
import { encryptToken } from "@/lib/meta/oauth";
import { resolveFacebookPageAccessToken } from "@/lib/meta/page-token";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const pageRowId = request.nextUrl.searchParams.get("facebookPageId");
  const page = pageRowId
    ? await prisma.facebookPage.findFirst({
        where: { id: pageRowId, workspaceId },
      })
    : await prisma.facebookPage.findFirst({
        where: { workspaceId },
        orderBy: { connectedAt: "desc" },
      });

  if (!page) {
    return NextResponse.json(
      {
        success: false,
        error: "Facebook Page not connected. Connect a Page in Settings first.",
      },
      { status: 400 }
    );
  }

  try {
    const ctx = createFacebookContext(page);
    // Stored token is sometimes the System User token; Graph needs the Page token.
    const resolved = await resolveFacebookPageAccessToken({
      pageId: ctx.pageId,
      storedToken: ctx.accessToken,
    });
    if (resolved.refreshed) {
      await prisma.facebookPage
        .update({
          where: { id: page.id },
          data: {
            accessToken: encryptToken(resolved.accessToken),
            tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
          },
        })
        .catch((error) => {
          console.warn(
            "[Facebook Posts] Failed to persist refreshed page token:",
            error instanceof Error ? error.message : error
          );
        });
    }

    const accessToken = resolved.accessToken;
    const postId = request.nextUrl.searchParams.get("postId");
    if (postId) {
      const commentsCount = await getFacebookPostCommentCount(
        accessToken,
        postId
      );
      return NextResponse.json({
        success: true,
        data: [{ id: postId, commentsCount }],
        page: { id: page.id, pageId: page.pageId, name: page.name },
      });
    }

    const shareUrl = request.nextUrl.searchParams.get("url")?.trim();
    if (shareUrl) {
      let resolvedPost = await resolveFacebookPostFromUrl(
        accessToken,
        ctx.pageId,
        shareUrl
      );

      // If the selected Page token cannot resolve it, try other connected Pages
      // (e.g. paste while Topsii is selected but the reel is from همه کالا).
      const workspacePages = await prisma.facebookPage.findMany({
        where: { workspaceId },
        select: { id: true, pageId: true, name: true, accessToken: true },
      });
      if (!resolvedPost) {
        for (const other of workspacePages) {
          if (other.id === page.id) continue;
          try {
            const otherCtx = createFacebookContext(other);
            const otherResolved = await resolveFacebookPageAccessToken({
              pageId: otherCtx.pageId,
              storedToken: otherCtx.accessToken,
            });
            resolvedPost = await resolveFacebookPostFromUrl(
              otherResolved.accessToken,
              otherCtx.pageId,
              shareUrl
            );
            if (resolvedPost) break;
          } catch {
            // try next page
          }
        }
      }

      if (!resolvedPost) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Could not resolve that Facebook link. Open the post as the Page, copy the URL, and make sure همه کالا (or the owning Page) is connected in Settings.",
          },
          { status: 404 }
        );
      }
      const fromId = resolvedPost.fromPageId ?? null;
      const connectedOwner = workspacePages.find(
        (p) =>
          p.pageId === fromId ||
          resolvedPost!.id.startsWith(`${p.pageId}_`) ||
          (resolvedPost!.fromPageName &&
            p.name
              .toLowerCase()
              .includes(resolvedPost!.fromPageName.toLowerCase().slice(0, 6)))
      );
      const belongsToSelected =
        !fromId ||
        fromId === ctx.pageId ||
        resolvedPost.id.startsWith(`${ctx.pageId}_`);
      let warning: string | null = null;
      if (!belongsToSelected) {
        warning = connectedOwner
          ? `This post belongs to “${resolvedPost.fromPageName ?? connectedOwner.name}”. Switch the Facebook Page selector to “${connectedOwner.name}”, then add the link again.`
          : `This post belongs to “${resolvedPost.fromPageName ?? fromId}”, not “${page.name}”. Connect that Facebook Page in Settings, then select it here.`;
      }
      return NextResponse.json({
        success: true,
        data: [
          {
            id: resolvedPost.id,
            caption: resolvedPost.message ?? "",
            timestamp: resolvedPost.created_time ?? null,
            permalink: resolvedPost.permalink_url ?? shareUrl,
            mediaUrl: resolvedPost.full_picture ?? resolvedPost.picture ?? null,
            mediaType:
              resolvedPost.status_type === "added_video" ? "VIDEO" : "IMAGE",
            commentsCount: resolvedPost.commentsCount ?? 0,
          },
        ],
        page: { id: page.id, pageId: page.pageId, name: page.name },
        fromPage: {
          id: fromId,
          name: resolvedPost.fromPageName ?? null,
          connectedPageRowId: connectedOwner?.id ?? null,
          connectedPageName: connectedOwner?.name ?? null,
        },
        belongsToSelectedPage: belongsToSelected,
        warning,
      });
    }

    const posts = await listFacebookPagePosts(accessToken, ctx.pageId, 80);
    return NextResponse.json({
      success: true,
      data: posts.map((p) => ({
        id: p.id,
        caption: p.message ?? "",
        timestamp: p.created_time ?? null,
        permalink: p.permalink_url ?? null,
        mediaUrl: p.full_picture ?? p.picture ?? null,
        mediaType:
          p.status_type === "added_video" ||
          p.status_type === "mobile_status_update"
            ? "VIDEO"
            : "IMAGE",
        commentsCount: p.commentsCount ?? 0,
      })),
      page: { id: page.id, pageId: page.pageId, name: page.name },
      tokenRefreshed: resolved.refreshed,
      limitations:
        posts.length === 0
          ? [
              "No Facebook posts returned for this Page. Re-paste the System User token in Settings so we can store each Page access token, and confirm pages_read_engagement is granted.",
            ]
          : [],
    });
  } catch (err) {
    console.error("[Facebook Posts] Error:", err);
    return NextResponse.json(
      {
        success: false,
        error:
          err instanceof Error ? err.message : "Failed to fetch Facebook posts",
      },
      { status: 500 }
    );
  }
}
