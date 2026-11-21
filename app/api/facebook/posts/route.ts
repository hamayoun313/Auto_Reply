import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { createFacebookContext } from "@/lib/facebook/context";
import {
  getFacebookPostCommentCount,
  listFacebookPagePosts,
} from "@/lib/meta/facebook-messages";

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
    const postId = request.nextUrl.searchParams.get("postId");
    if (postId) {
      const commentsCount = await getFacebookPostCommentCount(
        ctx.accessToken,
        postId
      );
      return NextResponse.json({
        success: true,
        data: [{ id: postId, commentsCount }],
        page: { id: page.id, pageId: page.pageId, name: page.name },
      });
    }

    const posts = await listFacebookPagePosts(ctx.accessToken, ctx.pageId, 60);
    return NextResponse.json({
      success: true,
      data: posts.map((p) => ({
        id: p.id,
        caption: p.message ?? "",
        timestamp: p.created_time ?? null,
        permalink: p.permalink_url ?? null,
        mediaUrl: p.full_picture ?? p.picture ?? null,
        mediaType:
          p.status_type === "added_video" || p.status_type === "mobile_status_update"
            ? "VIDEO"
            : "IMAGE",
        commentsCount: p.commentsCount ?? 0,
      })),
      page: { id: page.id, pageId: page.pageId, name: page.name },
      limitations:
        posts.length === 0
          ? [
              "No Facebook posts returned for this Page. Check Page token permissions (pages_read_engagement / pages_read_user_content) or publish a post as the Page.",
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
