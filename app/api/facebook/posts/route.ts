import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { createFacebookContext } from "@/lib/facebook/context";
import {
  getFacebookPostCommentCount,
  listFacebookPagePosts,
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

    const posts = await listFacebookPagePosts(accessToken, ctx.pageId, 60);
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
