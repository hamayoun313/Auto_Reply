import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getAllUserMedia, getUserMedia } from "@/lib/instagram/provider";
import { createInstagramContext } from "@/lib/instagram/provider";
import type { InstagramContext } from "@/lib/instagram/context";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import {
  brandNameMatches,
  canReadInstagramMedia,
  fetchInstagramLinkedToFacebookPage,
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
  if (/nonexisting field \(accounts\)/i.test(message)) return false;
  return (
    message.includes("does not exist") ||
    message.includes("Unsupported get request") ||
    (message.includes("code=100") && message.includes("sub=33"))
  );
}

async function repairFromWorkspaceFacebookPages(opts: {
  accountId: string;
  username: string;
  workspaceId: string;
}): Promise<{
  instagramId: string;
  accessToken: string;
} | null> {
  const pages = await prisma.facebookPage.findMany({
    where: { workspaceId: opts.workspaceId },
    select: { id: true, pageId: true, name: true, accessToken: true },
  });
  const candidates = pages.filter(
    (page) =>
      brandNameMatches(page.name, opts.username) ||
      brandNameMatches(page.name, "hamakala") ||
      brandNameMatches(page.name, "همه کالا") ||
      brandNameMatches(page.name, "همه‌کالا")
  );
  const ordered = [
    ...candidates,
    ...pages.filter((p) => !candidates.some((c) => c.id === p.id)),
  ];

  for (const page of ordered) {
    let pageToken: string;
    try {
      pageToken = decryptToken(page.accessToken);
    } catch {
      continue;
    }
    const linked = await fetchInstagramLinkedToFacebookPage({
      pageId: page.pageId,
      pageAccessToken: pageToken,
    });
    if (!linked) continue;
    if (
      linked.username &&
      !brandNameMatches(linked.username, opts.username) &&
      !brandNameMatches(opts.username, linked.username)
    ) {
      // Prefer username match; still allow if page name already matched.
      if (!candidates.some((c) => c.id === page.id)) continue;
    }
    await prisma.instagramAccount.update({
      where: { id: opts.accountId },
      data: {
        instagramId: linked.instagramId,
        accessToken: encryptToken(linked.pageAccessToken),
        tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        ...(linked.username ? { username: linked.username } : {}),
      },
    });
    return {
      instagramId: linked.instagramId,
      accessToken: linked.pageAccessToken,
    };
  }
  return null;
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

      const readable = await canReadInstagramMedia(
        resolved.accessToken,
        context.instagramId
      );

      if (!readable) {
        // 1) Rematch via System User /me/accounts (never with Page token).
        const match = await rematchInstagramByUsername({
          username: account.username,
        }).catch((error) => {
          console.warn(
            "[Instagram Posts] rematch failed:",
            error instanceof Error ? error.message : error
          );
          return null;
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
        } else {
          // 2) Pages not on System User (e.g. همه کالا): repair from connected FB Page token.
          const fromFb = await repairFromWorkspaceFacebookPages({
            accountId: account.id,
            username: account.username,
            workspaceId,
          });
          if (fromFb) {
            console.warn(
              `[Instagram Posts] Repaired @${account.username} from linked Facebook Page → ${fromFb.instagramId}`
            );
            context = {
              provider: "META",
              accessToken: fromFb.accessToken,
              instagramId: fromFb.instagramId,
            };
            tokenRefreshed = true;
            idRepaired = true;
            resolved = {
              accessToken: fromFb.accessToken,
              refreshed: true,
            };
            account = (await prisma.instagramAccount.findUnique({
              where: { id: account.id },
            }))!;
          }
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
      const fromFb = await repairFromWorkspaceFacebookPages({
        accountId: account.id,
        username: account.username,
        workspaceId,
      });
      if (!fromFb) throw error;
      context = {
        provider: "META",
        accessToken: fromFb.accessToken,
        instagramId: fromFb.instagramId,
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
      instagramId: context.provider === "META" ? context.instagramId : account.instagramId,
      limitations:
        account.provider === "ZERNIO"
          ? ["Zernio returns the 25 most recent Instagram posts."]
          : posts.length === 0
            ? [
                "No Instagram posts returned. Re-connect the account in Settings with the System User token (or the Page token for همه کالا).",
              ]
            : [],
    });
  } catch (err) {
    console.error("[Instagram Posts] Error:", err);
    const message =
      err instanceof Error ? err.message : "Failed to fetch Instagram posts";
    const cleaned = /nonexisting field \(accounts\)/i.test(message)
      ? `Could not load Instagram posts for @${account.username}. Re-connect همه کالا in Settings (paste System User token, then select the Page + Instagram).`
      : isDeadInstagramObjectError(err)
        ? `${message} Instagram id for @${account.username} is stale. Re-connect that account in Settings.`
        : message;
    return NextResponse.json({ success: false, error: cleaned }, { status: 500 });
  }
}
