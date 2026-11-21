import { getMetaGraphApiVersion } from "@/lib/env";
import { noteMetaAppUsageFromResponse } from "@/lib/meta/app-rate-limit-circuit";
import type { LinkButton } from "@/lib/meta/client";

function facebookGraphBase() {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

async function handleResponse<T>(response: Response): Promise<T> {
  await noteMetaAppUsageFromResponse(response).catch(() => {});
  const json = (await response.json()) as T & {
    error?: { message?: string; code?: number; type?: string };
  };
  if (!response.ok || json.error) {
    const message = json.error?.message ?? `Meta HTTP ${response.status}`;
    const error = new Error(message) as Error & { code?: number };
    error.code = json.error?.code;
    throw error;
  }
  return json;
}

function toWebUrlButtons(buttons: LinkButton[]) {
  return buttons.slice(0, 3).map((b) => ({
    type: "web_url" as const,
    title: b.title.slice(0, 20),
    url: b.url,
  }));
}

/** Private reply to a Page comment via Messenger (comment_id recipient). */
export async function sendFacebookPrivateReply(
  accessToken: string,
  pageId: string,
  commentId: string,
  message: string
): Promise<{ recipient_id?: string; message_id?: string }> {
  const response = await fetch(`${facebookGraphBase()}/${pageId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: { text: message },
    }),
  });
  return handleResponse(response);
}

export async function sendFacebookPrivateReplyWithLinkButton(
  accessToken: string,
  pageId: string,
  commentId: string,
  text: string,
  buttons: LinkButton[]
): Promise<{ recipient_id?: string; message_id?: string }> {
  const response = await fetch(`${facebookGraphBase()}/${pageId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: text.slice(0, 640),
            buttons: toWebUrlButtons(buttons),
          },
        },
      },
    }),
  });
  return handleResponse(response);
}

/** Public reply under a Page comment. */
export async function sendFacebookCommentReply(
  accessToken: string,
  commentId: string,
  message: string
): Promise<{ id?: string }> {
  const response = await fetch(`${facebookGraphBase()}/${commentId}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ message }),
  });
  return handleResponse(response);
}

export type FacebookPagePost = {
  id: string;
  message?: string | null;
  created_time?: string;
  permalink_url?: string | null;
  full_picture?: string | null;
  picture?: string | null;
  status_type?: string | null;
  attachments?: {
    data?: Array<{
      type?: string;
      media?: { image?: { src?: string } };
      media_type?: string;
      url?: string;
      subattachments?: {
        data?: Array<{ media?: { image?: { src?: string } } }>;
      };
    }>;
  };
  comments?: {
    summary?: { total_count?: number; can_comment?: boolean };
  };
  commentsCount?: number;
};

function facebookPostThumb(post: FacebookPagePost): string | null {
  if (post.full_picture) return post.full_picture;
  if (post.picture) return post.picture;
  const attachment = post.attachments?.data?.[0];
  const fromAttachment =
    attachment?.media?.image?.src ??
    attachment?.subattachments?.data?.[0]?.media?.image?.src ??
    null;
  return fromAttachment;
}

export type FacebookPostComment = {
  id: string;
  message?: string | null;
  created_time?: string;
  from?: { id?: string; name?: string } | null;
};

/** List comments on a Page post (needs pages_read_user_content). */
export async function listFacebookPostComments(
  accessToken: string,
  postId: string,
  options?: { limit?: number; after?: string }
): Promise<{
  comments: FacebookPostComment[];
  nextCursor?: string;
}> {
  const url = new URL(`${facebookGraphBase()}/${postId}/comments`);
  // from{id,name} needs Business Asset User Profile Access for public users;
  // without it Meta omits `from` (webhooks still include the name).
  url.searchParams.set("fields", "id,from{id,name},message,created_time");
  url.searchParams.set("filter", "stream");
  url.searchParams.set("order", "chronological");
  url.searchParams.set("limit", String(options?.limit ?? 50));
  if (options?.after) url.searchParams.set("after", options.after);
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{
    data?: FacebookPostComment[];
    paging?: { cursors?: { after?: string }; next?: string };
  }>(response);

  return {
    comments: data.data ?? [],
    nextCursor: data.paging?.cursors?.after,
  };
}

/** Resolve a Messenger user's display name after a private reply. */
export async function getFacebookMessengerParticipantName(
  accessToken: string,
  pageId: string,
  psid: string
): Promise<{ id: string; name: string } | null> {
  const url = new URL(`${facebookGraphBase()}/${pageId}/conversations`);
  url.searchParams.set("user_id", psid);
  url.searchParams.set("fields", "participants");
  url.searchParams.set("limit", "1");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{
    data?: Array<{
      participants?: { data?: Array<{ id?: string; name?: string }> };
    }>;
  }>(response);

  const participants = data.data?.[0]?.participants?.data ?? [];
  const person = participants.find((p) => p.id && p.id !== pageId && p.name);
  if (!person?.id || !person.name) return null;
  return { id: person.id, name: person.name };
}

/**
 * After a private reply, the thread's system message embeds `comment_id=…`.
 * Scan a few newest conversations to recover the commenter name when
 * `conversations?user_id=` is empty or Graph omits `from` on the comment.
 */
export async function resolveFacebookCommenterByCommentId(
  accessToken: string,
  pageId: string,
  commentId: string
): Promise<{ id: string; name: string } | null> {
  const shortId = commentId.includes("_")
    ? commentId.slice(commentId.lastIndexOf("_") + 1)
    : commentId;

  const url = new URL(`${facebookGraphBase()}/${pageId}/conversations`);
  url.searchParams.set(
    "fields",
    "participants,messages.limit(3){message}"
  );
  url.searchParams.set("limit", "25");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{
    data?: Array<{
      participants?: { data?: Array<{ id?: string; name?: string }> };
      messages?: { data?: Array<{ message?: string }> };
    }>;
  }>(response);

  for (const row of data.data ?? []) {
    const linked = (row.messages?.data ?? []).some((msg) => {
      const text = msg.message ?? "";
      return (
        text.includes(`comment_id=${shortId}`) ||
        text.includes(`comment_id=${commentId}`)
      );
    });
    if (!linked) continue;
    const person = (row.participants?.data ?? []).find(
      (p) => p.id && p.id !== pageId && p.name
    );
    if (person?.id && person.name) {
      return { id: person.id, name: person.name };
    }
  }
  return null;
}

/**
 * Walk recent Page conversations and map comment_id → commenter name.
 * Private-reply threads include a system message with `comment_id=` in the URL.
 */
export async function mapFacebookCommentersFromConversations(
  accessToken: string,
  pageId: string,
  options?: { maxPages?: number }
): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  const maxPages = options?.maxPages ?? 30;
  let after: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${facebookGraphBase()}/${pageId}/conversations`);
    url.searchParams.set(
      "fields",
      "participants,messages.limit(4){message,from}"
    );
    url.searchParams.set("limit", "50");
    if (after) url.searchParams.set("after", after);
    url.searchParams.set("access_token", accessToken);

    const response = await fetch(url.toString());
    const data = await handleResponse<{
      data?: Array<{
        participants?: { data?: Array<{ id?: string; name?: string }> };
        messages?: { data?: Array<{ message?: string }> };
      }>;
      paging?: { cursors?: { after?: string }; next?: string };
    }>(response);

    const rows = data.data ?? [];
    if (!rows.length) break;

    for (const row of rows) {
      const person = (row.participants?.data ?? []).find(
        (p) => p.id && p.id !== pageId && p.name
      );
      if (!person?.id || !person.name) continue;

      for (const msg of row.messages?.data ?? []) {
        const text = msg.message ?? "";
        const match = text.match(/comment_id=(\d+)/i);
        if (!match?.[1]) continue;
        const shortId = match[1];
        out.set(shortId, { id: person.id, name: person.name });
      }
    }

    after = data.paging?.cursors?.after;
    if (!after || !data.paging?.next) break;
  }

  return out;
}

export async function getFacebookPostCommentCount(
  accessToken: string,
  postId: string
): Promise<number | null> {
  const url = new URL(`${facebookGraphBase()}/${postId}`);
  url.searchParams.set("fields", "comments.summary(true).limit(0)");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<{
    comments?: { summary?: { total_count?: number } };
  }>(response);
  const total = data.comments?.summary?.total_count;
  return typeof total === "number" ? total : null;
}

type VideoReelRow = {
  id?: string;
  description?: string | null;
  created_time?: string;
  permalink_url?: string | null;
  picture?: string | null;
  source?: string | null;
};

/**
 * List Page posts + Reels. Facebook Reels often never appear on
 * /published_posts — they live on /video_reels — so we merge both.
 */
export async function listFacebookPagePosts(
  accessToken: string,
  pageId: string,
  limit = 60
): Promise<FacebookPagePost[]> {
  // Avoid deprecated attachment field combos that 500 the whole edge on v25.
  const postFields =
    "id,message,created_time,permalink_url,full_picture,picture,status_type,comments.summary(true).limit(0)";
  const reelFields =
    "id,description,created_time,permalink_url,picture,source";

  async function fetchEdge(
    edge: "published_posts" | "posts" | "feed" | "video_reels" | "videos",
    fields: string
  ): Promise<FacebookPagePost[]> {
    const url = new URL(`${facebookGraphBase()}/${pageId}/${edge}`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("limit", String(Math.min(100, Math.max(1, limit))));
    url.searchParams.set("access_token", accessToken);
    const response = await fetch(url.toString());
    if (edge === "video_reels" || edge === "videos") {
      const data = await handleResponse<{ data?: VideoReelRow[] }>(response);
      return (data.data ?? [])
        .filter((row) => Boolean(row.id))
        .map((row) => ({
          id: row.id!,
          message: row.description ?? "",
          created_time: row.created_time,
          permalink_url: row.permalink_url
            ? row.permalink_url.startsWith("http")
              ? row.permalink_url
              : `https://www.facebook.com${row.permalink_url}`
            : `https://www.facebook.com/reel/${row.id}`,
          full_picture: row.picture ?? null,
          picture: row.picture ?? null,
          status_type: "added_video",
          commentsCount: 0,
        }));
    }
    const data = await handleResponse<{ data?: FacebookPagePost[] }>(response);
    return data.data ?? [];
  }

  async function safeEdge(
    edge: "published_posts" | "posts" | "feed" | "video_reels" | "videos",
    fields: string
  ) {
    try {
      return await fetchEdge(edge, fields);
    } catch (error) {
      console.warn(
        `[Facebook] ${edge} failed:`,
        error instanceof Error ? error.message : error
      );
      return [] as FacebookPagePost[];
    }
  }

  const [published, posts, reels, videos] = await Promise.all([
    safeEdge("published_posts", postFields),
    safeEdge("posts", postFields),
    safeEdge("video_reels", reelFields),
    safeEdge("videos", reelFields),
  ]);

  let rows = [...published, ...posts, ...reels, ...videos];
  if (rows.length === 0) {
    rows = await safeEdge("feed", postFields);
  }

  const seen = new Set<string>();
  const merged = rows
    .filter((post) => {
      if (!post.id || seen.has(post.id)) return false;
      // Also dedupe pageId_postId vs bare video id when both appear.
      const bare = post.id.includes("_") ? post.id.split("_").pop()! : post.id;
      if (seen.has(bare)) return false;
      seen.add(post.id);
      seen.add(bare);
      return true;
    })
    .map((post) => ({
      ...post,
      full_picture: facebookPostThumb(post) ?? post.full_picture ?? null,
      commentsCount: post.comments?.summary?.total_count ?? 0,
    }));

  merged.sort((a, b) => {
    const ta = a.created_time ? Date.parse(a.created_time) : 0;
    const tb = b.created_time ? Date.parse(b.created_time) : 0;
    return tb - ta;
  });

  return merged.slice(0, Math.max(limit, 60));
}

export type ResolvedFacebookPost = FacebookPagePost & {
  fromPageId?: string | null;
  fromPageName?: string | null;
};

/**
 * Resolve facebook.com/share/… or story.php links to a Graph post object.
 * Share/r short links redirect to story_fbid + page id.
 */
export async function resolveFacebookPostFromUrl(
  accessToken: string,
  pageId: string,
  rawUrl: string
): Promise<ResolvedFacebookPost | null> {
  const input = rawUrl.trim();
  if (!input) return null;

  let storyFbid: string | null = null;
  let sharePageId: string | null = null;

  const storyMatch = input.match(/[?&]story_fbid=(\d+)/i);
  const idMatch = input.match(/[?&]id=(\d+)/i);
  const reelMatch = input.match(/\/reel\/(\d+)/i);
  const postsMatch = input.match(/\/posts\/(\d+)/i);
  const pfbidMatch = input.match(/\/posts\/(pfbid\w+)/i);

  if (storyMatch) storyFbid = storyMatch[1];
  if (idMatch) sharePageId = idMatch[1];
  if (reelMatch) storyFbid = reelMatch[1];
  if (postsMatch) storyFbid = postsMatch[1];

  if (!storyFbid && /facebook\.com\/share\//i.test(input)) {
    try {
      const redirected = await fetch(input, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0" },
      });
      const location = redirected.headers.get("location") ?? "";
      const locStory = location.match(/[?&]story_fbid=(\d+)/i);
      const locId = location.match(/[?&]id=(\d+)/i);
      const locReel = location.match(/\/reel\/(\d+)/i);
      if (locStory) storyFbid = locStory[1];
      if (locId) sharePageId = locId[1];
      if (locReel) storyFbid = locReel[1];
    } catch (error) {
      console.warn(
        "[Facebook] share redirect failed:",
        error instanceof Error ? error.message : error
      );
    }
  }

  const candidates = new Set<string>();
  if (storyFbid && sharePageId) candidates.add(`${sharePageId}_${storyFbid}`);
  if (storyFbid) {
    candidates.add(`${pageId}_${storyFbid}`);
    candidates.add(storyFbid);
  }
  if (pfbidMatch) candidates.add(`${pageId}_${pfbidMatch[1]}`);
  // Bare Graph id pasted by the user.
  if (/^\d+(?:_\d+)?$/.test(input)) candidates.add(input);

  for (const candidate of candidates) {
    try {
      const url = new URL(`${facebookGraphBase()}/${candidate}`);
      url.searchParams.set(
        "fields",
        "id,message,created_time,permalink_url,full_picture,picture,status_type,from{id,name},comments.summary(true).limit(0)"
      );
      url.searchParams.set("access_token", accessToken);
      const response = await fetch(url.toString());
      const post = await handleResponse<
        FacebookPagePost & { from?: { id?: string; name?: string } }
      >(response);
      if (!post.id) continue;
      return {
        ...post,
        full_picture: facebookPostThumb(post) ?? post.full_picture ?? null,
        commentsCount: post.comments?.summary?.total_count ?? 0,
        fromPageId: post.from?.id ?? sharePageId,
        fromPageName: post.from?.name ?? null,
      };
    } catch {
      // try next candidate
    }
  }

  return null;
}
