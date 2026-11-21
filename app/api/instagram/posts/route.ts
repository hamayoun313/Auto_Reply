import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getAllUserMedia, getUserMedia } from "@/lib/instagram/provider";
import { createInstagramContext } from "@/lib/instagram/provider";
import type { InstagramContext } from "@/lib/instagram/context";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { syncInstagramAccountFromFacebookPageDetailed } from "@/lib/instagram/sync-from-facebook-page";
import {
  brandNameMatches,
  canReadInstagramMedia,
  inspectTokenKind,
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

function isHamakalaName(name: string): boolean {
  return (
    brandNameMatches(name, "hamakala") ||
    brandNameMatches(name, "همه کالا") ||
    brandNameMatches(name, "همه‌کالا")
  );
}

async function repairFromWorkspaceFacebookPages(opts: {
  accountId: string;
  username: string;
  storedInstagramId: string;
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
      matchesHamakala: isHamakalaName(p.name),
    })),
  });

  // Only matching brand pages — never spray sync across every connected Page.
  const candidates = pages.filter(
    (page) =>
      brandNameMatches(page.name, opts.username) || isHamakalaName(page.name)
  );
  if (candidates.length === 0) {
    opts.diagnostics.push({
      step: "workspace_facebook_pages",
      note: "No Facebook Page name matched this Instagram username.",
    });
    return null;
  }

  for (const page of candidates) {
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

    const tokenKind = await inspectTokenKind(pageToken);
    opts.diagnostics.push({
      step: "fb_page_token_kind",
      page: page.name,
      pageId: page.pageId,
      tokenKind,
    });

    // A) Stored IG id may still be valid — only the IG-row token was corrupted
    // (e.g. overwritten with System User). Prefer restoring the Page token.
    const storedStillWorks = await canReadInstagramMedia(
      pageToken,
      opts.storedInstagramId
    );
    opts.diagnostics.push({
      step: "page_token_reads_stored_ig",
      page: page.name,
      storedInstagramId: opts.storedInstagramId,
      canRead: storedStillWorks,
    });
    if (storedStillWorks) {
      await prisma.instagramAccount.update({
        where: { id: opts.accountId },
        data: {
          accessToken: encryptToken(pageToken),
          tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        },
      });
      return {
        instagramId: opts.storedInstagramId,
        accessToken: pageToken,
      };
    }

    // B) Discover live IG id from the Page (multiple Graph edges + real errors).
    const { synced, lookup } =
      await syncInstagramAccountFromFacebookPageDetailed({
        workspaceId: opts.workspaceId,
        pageId: page.pageId,
        pageName: page.name,
        pageAccessToken: pageToken,
        targetAccountId: opts.accountId,
      });
    opts.diagnostics.push({
      step: "sync_from_facebook_page",
      page: page.name,
      pageId: page.pageId,
      tokenKind: lookup.tokenKind,
      probes: lookup.probes,
      synced: synced
        ? {
            accountId: synced.accountId,
            username: synced.username,
            instagramId: synced.instagramId,
            previousInstagramId: synced.previousInstagramId,
            source: synced.source,
          }
        : null,
    });

    if (!synced) continue;
    if (
      synced.accountId !== opts.accountId &&
      !brandNameMatches(synced.username, opts.username)
    ) {
      continue;
    }

    // Only accept after media actually works with the Page token.
    const mediaOk = await canReadInstagramMedia(
      pageToken,
      synced.instagramId
    );
    opts.diagnostics.push({
      step: "verify_synced_media",
      page: page.name,
      instagramId: synced.instagramId,
      canRead: mediaOk,
    });
    if (!mediaOk) continue;

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

  const loadAll = request.nextUrl.searchParams.get("all") === "true";
  const limitParam = request.nextUrl.searchParams.get("limit");
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 25;
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 50)
    : 25;

  try {
    let context = await createInstagramContext(account);
    let tokenRefreshed = false;
    let idRepaired = false;

    // 1) Prefer the simple path: load media with whatever is stored.
    // Morning token-refresh/repair logic was skipping this and corrupting state.
    try {
      const posts = await loadPosts(context, loadAll, limit);
      return NextResponse.json({
        success: true,
        data: posts,
        provider: account.provider,
        tokenRefreshed: false,
        idRepaired: false,
        instagramId:
          context.provider === "META"
            ? context.instagramId
            : account.instagramId,
        diagnostics: [
          ...diagnostics,
          { step: "media_direct", ok: true, count: posts.length },
        ],
        limitations:
          account.provider === "ZERNIO"
            ? ["Zernio returns the 25 most recent Instagram posts."]
            : posts.length === 0
              ? [
                  "No Instagram posts returned. Re-connect the account in Settings with the System User token (or the Page token for همه کالا).",
                ]
              : [],
      });
    } catch (directError) {
      diagnostics.push({
        step: "media_direct",
        ok: false,
        error:
          directError instanceof Error
            ? directError.message
            : String(directError),
      });
      if (context.provider !== "META") throw directError;
    }

    // 2) Soft resolve (may swap to a Page token from System User /me/accounts).
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
      storedTokenKind: await inspectTokenKind(context.accessToken).catch(
        () => "unknown"
      ),
    });

    if (readable) {
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
      const posts = await loadPosts(context, loadAll, limit);
      return NextResponse.json({
        success: true,
        data: posts,
        provider: account.provider,
        tokenRefreshed,
        idRepaired: false,
        instagramId: context.instagramId,
        diagnostics,
        limitations: [],
      });
    }

    // 3) Rematch via System User (never with a Page token).
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

    const match = await rematchInstagramByUsername({
      username: account.username,
    }).catch((error) => {
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

    if (match) {
      const mediaOk = await canReadInstagramMedia(
        match.pageAccessToken,
        match.instagramId
      );
      diagnostics.push({
        step: "verify_rematch_media",
        canRead: mediaOk,
        instagramId: match.instagramId,
      });
      if (mediaOk) {
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
        const posts = await loadPosts(context, loadAll, limit);
        return NextResponse.json({
          success: true,
          data: posts,
          provider: account.provider,
          tokenRefreshed,
          idRepaired,
          instagramId: context.instagramId,
          diagnostics,
          limitations: [],
        });
      }
    }

    // 4) Pages not on System User (e.g. همه کالا): repair from matching FB Page only.
    const fromFb = await repairFromWorkspaceFacebookPages({
      accountId: account.id,
      username: account.username,
      storedInstagramId: account.instagramId,
      workspaceId,
      diagnostics,
    });
    if (fromFb) {
      context = {
        provider: "META",
        accessToken: fromFb.accessToken,
        instagramId: fromFb.instagramId,
      };
      tokenRefreshed = true;
      idRepaired = fromFb.instagramId !== account.instagramId;
      account = (await prisma.instagramAccount.findUnique({
        where: { id: account.id },
      }))!;
      const posts = await loadPosts(context, loadAll, limit);
      return NextResponse.json({
        success: true,
        data: posts,
        provider: account.provider,
        tokenRefreshed,
        idRepaired,
        instagramId: context.instagramId,
        diagnostics,
        limitations: [],
      });
    }

    throw new Error(
      `Unsupported get request. Object with ID '${account.instagramId}' does not exist (code=100 sub=33)`
    );
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
        (d.pages as Array<{ matchesUsername?: boolean; matchesHamakala?: boolean; name?: string }>).some(
          (p) =>
            p.matchesUsername ||
            p.matchesHamakala ||
            isHamakalaName(String(p.name ?? ""))
        )
    );
    const pageTokenIsSu = diagnostics.some(
      (d) =>
        d.step === "fb_page_token_kind" &&
        d.tokenKind === "system_user_or_user"
    );
    const pageProbeError = diagnostics
      .filter((d) => d.step === "sync_from_facebook_page")
      .flatMap((d) =>
        Array.isArray(d.probes) ? (d.probes as Array<Record<string, unknown>>) : []
      )
      .find((p) => p.ok === false && typeof p.error === "string")?.error as
      | string
      | undefined;

    const cleaned = isDeadInstagramObjectError(err)
      ? [
          `Instagram id for @${account.username} is stale (${account.instagramId}).`,
          !seesHamakalaOnSystemUser
            ? "META_SYSTEM_USER_TOKEN cannot see همه کالا / @hamakala.af right now."
            : null,
          !hasHamakalaFacebook
            ? "No matching Facebook Page is connected in this workspace."
            : pageTokenIsSu
              ? "Matching Facebook Page is connected, but its stored token behaves like System User (not a Page token) — so IG sync cannot read the Page."
              : pageProbeError
                ? `Matching Facebook Page IG lookup failed: ${pageProbeError}`
                : "A matching Facebook Page exists but IG sync did not return a live id.",
          "Fix: Meta Business Suite → assign Page «همه کالا» to the System User → new token → Settings → Connect Facebook (Instagram syncs automatically). Or paste the همه کالا Page access token in Settings.",
        ]
          .filter(Boolean)
          .join(" ")
      : /nonexisting field \(accounts\)/i.test(message)
        ? `Could not load Instagram posts for @${account.username}. Re-connect همه کالا via Facebook Page token in Settings.`
        : message;

    return NextResponse.json(
      {
        success: false,
        error: cleaned,
        diagnostics,
      },
      { status: 500 }
    );
  }
}
