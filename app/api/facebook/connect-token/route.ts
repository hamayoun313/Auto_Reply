import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { saveFacebookPageConnection } from "@/lib/facebook/save-page-connection";
import {
  fetchFacebookPageById,
  listFacebookPagesForToken,
  type DiscoverableFacebookPage,
} from "@/lib/meta/facebook-pages";
import { ShortLivedTokenError } from "@/lib/meta/token-lifetime";
import { requireSettingsUnlock } from "@/lib/settings-access";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

/**
 * Connect one or more Facebook Pages via System User / Page token paste.
 * When multiple pages are available and none were selected, returns
 * `multiple_pages` with a picker list for the UI.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const locked = await requireSettingsUnlock();
  if (locked) return locked;

  const context = await getCurrentWorkspaceContext();
  if (!context || !canManageWorkspace(context.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    accessToken?: string;
    pageId?: string;
    pageIds?: string[];
  } | null;

  const accessToken = body?.accessToken?.trim();
  if (!accessToken) {
    return NextResponse.json({ error: "access_token_required" }, { status: 400 });
  }

  const requestedIds = [
    ...new Set(
      [
        ...(Array.isArray(body?.pageIds) ? body.pageIds : []),
        body?.pageId?.trim() || "",
      ]
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ];

  try {
    // Page-scoped tokens often cannot call /me/accounts ("could not be
    // decrypted"). When the user already supplied pageId(s), skip listing and
    // resolve each page directly.
    let pages: DiscoverableFacebookPage[] = [];
    try {
      pages = await listFacebookPagesForToken(accessToken);
    } catch (listError) {
      if (requestedIds.length === 0) {
        throw listError;
      }
      console.warn(
        "[Facebook Token Connect] /me/accounts failed; falling back to pageId:",
        listError instanceof Error ? listError.message : listError
      );
    }

    if (requestedIds.length === 0) {
      if (pages.length === 0) {
        return NextResponse.json(
          {
            error: "no_facebook_page",
            message:
              "Token is valid but no Facebook Page was found. Assign the Page to the System User with pages_show_list + pages_messaging, regenerate the token, then try again.",
          },
          { status: 400 }
        );
      }
      if (pages.length > 1) {
        return NextResponse.json(
          {
            error: "multiple_pages",
            message: "Multiple Facebook Pages found. Select the pages to connect.",
            pages: pages.map((p) => ({ id: p.id, name: p.name })),
          },
          { status: 400 }
        );
      }
      requestedIds.push(pages[0]!.id);
    }

    const connected: Array<{
      pageId: string;
      name: string;
      webhookSubscribed: boolean;
      syncedInstagram?: {
        username: string;
        instagramId: string;
        previousInstagramId: string | null;
      } | null;
    }> = [];
    const skipped: Array<{ pageId: string; reason: string }> = [];

    for (const pageId of requestedIds) {
      let page: DiscoverableFacebookPage | null =
        pages.find((p) => p.id === pageId) ?? null;
      if (!page) {
        page = await fetchFacebookPageById(accessToken, pageId);
      }
      // Last resort: trust the pasted Page token + id (Graph list/debug can
      // fail on some Page tokens even though messaging works).
      if (!page?.id) {
        page = { id: pageId, name: pageId, accessToken };
      }

      const result = await saveFacebookPageConnection({
        workspaceId: context.workspaceId,
        page: {
          id: page.id,
          name: page.name,
          accessToken: page.accessToken || accessToken,
        },
      });

      if (!result.ok) {
        skipped.push({ pageId: page.id, reason: result.reason });
        continue;
      }

      connected.push({
        pageId: result.pageId,
        name: result.name,
        webhookSubscribed: result.webhookSubscribed,
        syncedInstagram: result.syncedInstagram ?? null,
      });
      if (result.syncedInstagram) {
        console.info(
          `[Facebook Token Connect] Synced IG @${result.syncedInstagram.username}: ${result.syncedInstagram.previousInstagramId} → ${result.syncedInstagram.instagramId}`
        );
      }
    }

    if (connected.length === 0) {
      const onlyAlready =
        skipped.length > 0 && skipped.every((s) => s.reason === "already_connected");
      return NextResponse.json(
        {
          error: onlyAlready ? "already_connected" : "connection_failed",
          message: onlyAlready
            ? "Selected pages are already connected to another workspace."
            : "Could not connect the selected Facebook Pages.",
          skipped,
        },
        { status: onlyAlready ? 409 : 400 }
      );
    }

    return NextResponse.json({
      success: true,
      pages: connected,
      skipped,
      page: connected[0],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed";
    console.error("[Facebook Token Connect]", message);
    const shortLived = error instanceof ShortLivedTokenError;
    return NextResponse.json(
      {
        error: shortLived ? "short_lived_token" : "connection_failed",
        message,
      },
      { status: 400 }
    );
  }
}
