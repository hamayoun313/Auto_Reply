import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getAllUserMedia, getUserMedia } from "@/lib/instagram/provider";
import { createInstagramContext } from "@/lib/instagram/provider";
import { encryptToken } from "@/lib/meta/oauth";
import { resolveInstagramMediaAccessToken } from "@/lib/meta/page-token";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );

  if (!account) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Instagram account not connected. Please connect your account first.",
      },
      { status: 400 }
    );
  }

  try {
    let context = await createInstagramContext(account);
    let tokenRefreshed = false;

    if (context.provider === "META") {
      const resolved = await resolveInstagramMediaAccessToken({
        instagramId: context.instagramId,
        storedToken: context.accessToken,
      });
      if (resolved.refreshed) {
        tokenRefreshed = true;
        context = {
          provider: "META",
          accessToken: resolved.accessToken,
          instagramId: context.instagramId,
        };
        await prisma.instagramAccount
          .update({
            where: { id: account.id },
            data: {
              accessToken: encryptToken(resolved.accessToken),
              tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
            },
          })
          .catch((error) => {
            console.warn(
              "[Instagram Posts] Failed to persist refreshed page token:",
              error instanceof Error ? error.message : error
            );
          });
      } else {
        context = {
          provider: "META",
          accessToken: resolved.accessToken,
          instagramId: context.instagramId,
        };
      }
    }

    // `all=true` paginates the full library (for the campaign post picker);
    // otherwise return a single recent page.
    const loadAll = request.nextUrl.searchParams.get("all") === "true";
    let posts;
    if (loadAll) {
      // Cap below Meta pagination cost / Railway request time limits.
      posts = await getAllUserMedia({ context, max: 120 });
    } else {
      const limitParam = request.nextUrl.searchParams.get("limit");
      const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 25;
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(parsedLimit, 1), 50)
        : 25;
      posts = await getUserMedia({ context, limit: limit });
    }

    return NextResponse.json({
      success: true,
      data: posts,
      provider: account.provider,
      tokenRefreshed,
      limitations:
        account.provider === "ZERNIO"
          ? ["Zernio returns the 25 most recent Instagram posts."]
          : posts.length === 0
            ? [
                "No Instagram posts returned. Re-connect the account in Settings with the System User token so we can store the linked Page access token.",
              ]
            : [],
    });
  } catch (err) {
    console.error("[Instagram Posts] Error:", err);
    return NextResponse.json(
      {
        success: false,
        error:
          err instanceof Error ? err.message : "Failed to fetch Instagram posts",
      },
      { status: 500 }
    );
  }
}
