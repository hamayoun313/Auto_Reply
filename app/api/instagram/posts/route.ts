import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getAllUserMedia, getUserMedia } from "@/lib/instagram/provider";
import { createInstagramContext } from "@/lib/instagram/provider";
import type { InstagramContext } from "@/lib/instagram/context";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { syncInstagramAccountFromFacebookPage } from "@/lib/instagram/sync-from-facebook-page";
import {
  brandNameMatches,
  canReadInstagramMedia,
  listLiveInstagramLinks,
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
  diagnostics: Array<Record<string, unknown>>;
}): Promise<{
  instagramId: string;
  accessToken: string;
} | null> {
  const pages = await prisma.facebookPage.findMany({
    where: { workspaceId: opts.workspaceId },
    select: { id: true, pageId: true, name: true, accessToken: true },
  });
  opts.diagnostics.push({
    step: "workspace_facebook_pages",
    pages: pages.map((p) => ({
      name: p.name,
      pageId: p.pageId,
      matchesUsername: brandNameMatches(p.name, opts.username),
    })),
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
    } catch (error) {
      opts.diagnostics.push({
        step: "decrypt_page_token",
        page: page.name,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const synced = await syncInstagramAccountFromFacebookPage({
      workspaceId: opts.workspaceId,
      pageId: page.pageId,
      pageName: page.name,
      pageAccessToken: pageToken,
    });
    opts.diagnostics.push({
      step: "sync_from_facebook_page",
      page: page.name,
      synced,
    });
    if (!synced) continue;
    if (
      synced.accountId !== opts.accountId &&
      !brandNameMatches(synced.username, opts.username)
    ) {
      continue;
    }
    return {
      instagramId: synced.instagramId,
      accessToken: pageToken,
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

  const diagnostics: Array<Record<string, unknown>> = [
    {
      step: "start",
      accountId: account.id,
      username: account.username,
      storedInstagramId: account.instagramId,
    },
  ];

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
      diagnostics.push({
        step: "probe_stored",
        canRead: readable,
        tokenRefreshedFromResolve: resolved.refreshed,
      });

      if (!readable) {
        const live = await listLiveInstagramLinks(null).catch((error) => {
          diagnostics.push({
            step: "list_live_links",
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        });
        diagnostics.push({
          step: "list_live_links",
          count: live.length,
          usernames: live.map((l) => l.username),
          seesHamakala: live.some((l) => brandNameMatches(l.username, "hamakala")),
        });

        // 1) Rematch via System User /me/accounts (never with Page token).
        const match = await rematchInstagramByUsername({
          username: account.username,
        }).catch((error) => {
          console.warn(
            "[Instagram Posts] rematch failed:",
            error instanceof Error ? error.message : error
          );
          diagnostics.push({
            step: "rematch_username",
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        diagnostics.push({
          step: "rematch_username",
          found: Boolean(match),
          match: match
            ? {
                username: match.username,
                instagramId: match.instagramId,
                pageName: match.pageName,
              }
            : null,
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
            diagnostics,
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
        diagnostics,
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
      diagnostics,
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
    console.error("[Instagram Posts] Error:", err, { diagnostics });
    const message =
      err instanceof Error ? err.message : "Failed to fetch Instagram posts";
    const seesHamakalaOnSystemUser = diagnostics.some(
      (d) => d.step === "list_live_links" && d.seesHamakala === true
    );
    const hasHamakalaFacebook = diagnostics.some(
      (d) =>
        d.step === "workspace_facebook_pages" &&
        Array.isArray(d.pages) &&
        (d.pages as Array<{ matchesUsername?: boolean; name?: string }>).some(
          (p) =>
            p.matchesUsername ||
            brandNameMatches(String(p.name ?? ""), "hamakala") ||
            brandNameMatches(String(p.name ?? ""), "همه کالا")
        )
    );
    const cleaned = isDeadInstagramObjectError(err)
      ? [
          `Instagram id for @${account.username} is stale (${account.instagramId}).`,
          !seesHamakalaOnSystemUser
            ? "META_SYSTEM_USER_TOKEN cannot see همه کالا / @hamakala.af right now."
            : null,
          !hasHamakalaFacebook
            ? "No matching Facebook Page is connected in this workspace."
            : "A matching Facebook Page exists but IG sync did not return a live id.",
          "Fix: Meta Business Suite → assign Page «همه کالا» to the System User → new token → Settings → Connect Facebook (Instagram syncs automatically). Or paste the همه کالا Page access token in Settings.",
        ]
          .filter(Boolean)
          .join(" ")
      : /nonexisting field \(accounts\)/i.test(message)
        ? `Could not load Instagram posts for @${account.username}. Re-connect همه کالا via Facebook Page token in Settings.`
        : message;
    return NextResponse.json(
      { success: false, error: cleaned, diagnostics },
      { status: 500 }
    );
  }
}
