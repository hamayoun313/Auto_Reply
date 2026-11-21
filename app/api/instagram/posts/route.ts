import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getAllUserMedia, getUserMedia } from "@/lib/instagram/provider";
import { createInstagramContext } from "@/lib/instagram/provider";
import type { InstagramContext } from "@/lib/instagram/context";
import { encryptToken } from "@/lib/meta/oauth";
import {
  canReadInstagramMedia,
  rematchInstagramByUsername,
  resolveInstagramMediaAccessToken,
} from "@/lib/meta/page-token";

async function loadPosts(
  context: InstagramContext,
  loadAll: boolean,
  limit: number
) {
  if (loadAll) {
    return getAllUserMedia({ context, max: 120 });
  }
  return getUserMedia({ context, limit });
}

function isDeadInstagramObjectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("does not exist") ||
    message.includes("code=100") ||
    message.includes("sub=33") ||
    message.includes("Unsupported get request")
  );
}

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let account = await getWorkspaceInstagramAccount(
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
    let idRepaired = false;

    if (context.provider === "META") {
      let resolved = await resolveInstagramMediaAccessToken({
        instagramId: context.instagramId,
        storedToken: context.accessToken,
      });

      // Dead / wrong Instagram business id in DB → rematch by @username.
      const readable = await canReadInstagramMedia(
        resolved.accessToken,
        context.instagramId
      );
      if (!readable) {
        const match = await rematchInstagramByUsername({
          username: account.username,
          accessToken: resolved.accessToken,
        });
        if (match && match.instagramId !== account.instagramId) {
          console.warn(
            `[Instagram Posts] Repairing stale IG id for @${account.username}: ${account.instagramId} → ${match.instagramId}`
          );
          account = await prisma.instagramAccount.update({
            where: { id: account.id },
            data: {
              instagramId: match.instagramId,
              accessToken: encryptToken(match.pageAccessToken),
              tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
            },
          });
          context = {
            provider: "META",
            accessToken: match.pageAccessToken,
            instagramId: match.instagramId,
          };
          tokenRefreshed = true;
          idRepaired = true;
          resolved = {
            accessToken: match.pageAccessToken,
            refreshed: true,
          };
        }
      }

      if (!idRepaired) {
        context = {
          provider: "META",
          accessToken: resolved.accessToken,
          instagramId: context.instagramId,
        };
        if (resolved.refreshed) {
          tokenRefreshed = true;
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
        }
      }
    }

    const loadAll = request.nextUrl.searchParams.get("all") === "true";
    const limitParam = request.nextUrl.searchParams.get("limit");
    const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 25;
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 50)
      : 25;

    let posts;
    try {
      posts = await loadPosts(context, loadAll, limit);
    } catch (error) {
      if (context.provider !== "META" || !isDeadInstagramObjectError(error)) {
        throw error;
      }
      const match = await rematchInstagramByUsername({
        username: account.username,
        accessToken: context.accessToken,
      });
      if (!match) throw error;

      console.warn(
        `[Instagram Posts] Media failed for stale id; rematched @${account.username} → ${match.instagramId}`
      );
      account = await prisma.instagramAccount.update({
        where: { id: account.id },
        data: {
          instagramId: match.instagramId,
          accessToken: encryptToken(match.pageAccessToken),
          tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        },
      });
      context = {
        provider: "META",
        accessToken: match.pageAccessToken,
        instagramId: match.instagramId,
      };
      tokenRefreshed = true;
      idRepaired = true;
      posts = await loadPosts(context, loadAll, limit);
    }

    return NextResponse.json({
      success: true,
      data: posts,
      provider: account.provider,
      tokenRefreshed,
      idRepaired,
      instagramId: account.instagramId,
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
    const message =
      err instanceof Error ? err.message : "Failed to fetch Instagram posts";
    const hint = isDeadInstagramObjectError(err)
      ? ` Instagram id for @${account.username} is stale or not assigned to this System User. Re-connect that account in Settings (paste the System User token again).`
      : "";
    return NextResponse.json(
      {
        success: false,
        error: `${message}${hint}`,
      },
      { status: 500 }
    );
  }
}
