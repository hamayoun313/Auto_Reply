"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * Post Picker
 *
 * Grid of Instagram / Facebook post thumbnails.
 * Supports single-select (legacy) or multi-select (specific posts).
 */

import { useI18n } from "@/lib/i18n/provider";
import { useEffect, useState } from "react";
import { readCache, writeCache } from "@/lib/client-cache";
import { MAX_SPECIFIC_POSTS } from "@/lib/automation/post-targets";

const PAGE_SIZE = 60;

interface InstagramPost {
  id: string;
  caption?: string;
  media_type: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp: string;
}

export type PostPick = {
  postId: string;
  postUrl?: string;
  thumbUrl?: string;
  caption?: string;
};

interface PostPickerProps {
  /** Legacy single selection. Ignored when `selectedPostIds` is provided. */
  selectedPostId?: string | null;
  /** Multi-select specific posts (preferred). */
  selectedPostIds?: string[];
  maxSelected?: number;
  channel?: "instagram" | "facebook";
  instagramAccountId?: string | null;
  facebookPageId?: string | null;
  /** postId -> name of the campaign already using it. Flagged in the grid. */
  usedPostIds?: Record<string, string>;
  /** Larger tiles for dual-channel / narrow layouts. */
  dense?: boolean;
  /** Single-select callback (legacy). */
  onSelect?: (
    postId: string | null,
    postUrl?: string,
    thumbUrl?: string,
    caption?: string
  ) => void;
  /** Multi-select callback — receives the full current selection. */
  onSelectMany?: (posts: PostPick[]) => void;
}

export default function PostPicker({
  selectedPostId = null,
  selectedPostIds,
  maxSelected = MAX_SPECIFIC_POSTS,
  channel = "instagram",
  instagramAccountId,
  facebookPageId,
  usedPostIds,
  dense = false,
  onSelect,
  onSelectMany,
}: PostPickerProps) {
  const { t } = useI18n();
  const multi = Array.isArray(selectedPostIds) || Boolean(onSelectMany);
  const currentIds = multi
    ? selectedPostIds ?? (selectedPostId ? [selectedPostId] : [])
    : selectedPostId
      ? [selectedPostId]
      : [];

  const [limitations, setLimitations] = useState<string[]>([]);
  const [posts, setPosts] = useState<InstagramPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [brokenThumbs, setBrokenThumbs] = useState<Record<string, true>>({});
  const [pickedMeta, setPickedMeta] = useState<Record<string, PostPick>>({});
  const [fbUrl, setFbUrl] = useState("");
  const [fbUrlBusy, setFbUrlBusy] = useState(false);
  const [fbUrlMessage, setFbUrlMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const isFacebook = channel === "facebook";
    setError(null);
    setLimitations([]);
    setFbUrlMessage(null);
    setShown(PAGE_SIZE);
    setBrokenThumbs({});
    if (isFacebook && !facebookPageId) {
      setPosts([]);
      setLoading(false);
      setError("Connect a Facebook Page first.");
      return;
    }
    if (!isFacebook && !instagramAccountId) {
      setPosts([]);
      setLoading(false);
      setError("Connect an Instagram account first.");
      return;
    }
    setLoading(true);
    const params = new URLSearchParams();
    if (isFacebook) {
      params.set("facebookPageId", facebookPageId!);
    } else {
      params.set("instagramAccountId", instagramAccountId!);
      params.set("all", "true");
    }

    // v4: includes Facebook Reels from /video_reels (share/r links).
    const cacheKey = isFacebook
      ? `fb-posts:v4:${facebookPageId ?? "default"}`
      : `ig-posts:v3:${instagramAccountId ?? "default"}`;
    const cached = readCache<InstagramPost[]>(cacheKey, 15 * 60 * 1000);
    /* eslint-disable react-hooks/set-state-in-effect */
    // Never hydrate from an empty cache — it hides real Meta errors for 15 min.
    if (cached.data && cached.data.length > 0) {
      setPosts(cached.data);
      setLoading(false);
    }
    /* eslint-enable react-hooks/set-state-in-effect */

    const endpoint = isFacebook
      ? `/api/facebook/posts${params.size ? `?${params}` : ""}`
      : `/api/instagram/posts${params.size ? `?${params}` : ""}`;

    fetch(endpoint)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) {
          const normalized: InstagramPost[] = isFacebook
            ? (
                data.data as Array<{
                  id: string;
                  caption?: string;
                  mediaType?: string;
                  mediaUrl?: string;
                  permalink?: string;
                  timestamp?: string | null;
                }>
              ).map((p) => ({
                id: p.id,
                caption: p.caption,
                media_type: p.mediaType ?? "IMAGE",
                media_url: p.mediaUrl,
                thumbnail_url: p.mediaUrl,
                permalink: p.permalink,
                timestamp: p.timestamp ?? "",
              }))
            : data.data;
          setPosts(normalized);
          setLimitations(data.limitations ?? []);
          if (normalized.length > 0) writeCache(cacheKey, normalized);
        } else if (!cached.data) {
          const detail =
            typeof data.error === "string"
              ? data.error
              : "Failed to load posts";
          const diag = Array.isArray(data.diagnostics)
            ? ` [diag: ${data.diagnostics
                .map((d: { step?: string }) => d.step)
                .filter(Boolean)
                .join(" → ")}]`
            : "";
          setError(`${detail}${diag}`);
          if (data.diagnostics) {
            console.warn("[PostPicker] Instagram/Facebook diagnostics", data.diagnostics);
          }
        }
      })
      .catch(() => {
        if (!cancelled && !cached.data) setError("Failed to load posts");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [channel, facebookPageId, instagramAccountId]);

  function emitSelection(nextIds: string[], meta: Record<string, PostPick>) {
    const picks = nextIds.map(
      (id) => meta[id] ?? { postId: id }
    );
    if (onSelectMany) {
      onSelectMany(picks);
      return;
    }
    if (onSelect) {
      const first = picks[0];
      if (!first) onSelect(null);
      else onSelect(first.postId, first.postUrl, first.thumbUrl, first.caption);
    }
  }

  async function resolveFacebookUrl() {
    if (channel !== "facebook" || !facebookPageId || !fbUrl.trim()) return;
    setFbUrlBusy(true);
    setFbUrlMessage(null);
    try {
      const params = new URLSearchParams({
        facebookPageId,
        url: fbUrl.trim(),
      });
      const res = await fetch(`/api/facebook/posts?${params}`);
      const data = await res.json();
      if (!data.success || !Array.isArray(data.data) || data.data.length === 0) {
        setFbUrlMessage(
          data.error ?? t("Could not resolve that Facebook link.")
        );
        return;
      }
      if (data.warning) {
        setFbUrlMessage(data.warning);
      }
      const row = data.data[0] as {
        id: string;
        caption?: string;
        mediaUrl?: string;
        permalink?: string;
        mediaType?: string;
        timestamp?: string | null;
      };
      const normalized: InstagramPost = {
        id: row.id,
        caption: row.caption,
        media_type: row.mediaType ?? "IMAGE",
        media_url: row.mediaUrl,
        thumbnail_url: row.mediaUrl,
        permalink: row.permalink,
        timestamp: row.timestamp ?? "",
      };
      setPosts((prev) => {
        if (prev.some((p) => p.id === normalized.id)) return prev;
        return [normalized, ...prev];
      });
      if (data.belongsToSelectedPage !== false) {
        togglePost(normalized);
        if (!data.warning) {
          setFbUrlMessage(t("Post added from link."));
          setFbUrl("");
        }
      }
    } catch {
      setFbUrlMessage(t("Could not resolve that Facebook link."));
    } finally {
      setFbUrlBusy(false);
    }
  }

  function togglePost(post: InstagramPost) {
    const thumb = post.thumbnail_url || post.media_url;
    const pick: PostPick = {
      postId: post.id,
      postUrl: post.permalink,
      thumbUrl: thumb,
      caption: post.caption,
    };
    const isSelected = currentIds.includes(post.id);

    if (!multi) {
      if (isSelected) {
        emitSelection([], {});
        return;
      }
      const meta = { [post.id]: pick };
      setPickedMeta(meta);
      emitSelection([post.id], meta);
      return;
    }

    if (isSelected) {
      const nextIds = currentIds.filter((id) => id !== post.id);
      const nextMeta = { ...pickedMeta };
      delete nextMeta[post.id];
      setPickedMeta(nextMeta);
      emitSelection(nextIds, nextMeta);
      return;
    }

    if (currentIds.length >= maxSelected) return;

    const nextIds = [...currentIds, post.id];
    const nextMeta = { ...pickedMeta, [post.id]: pick };
    setPickedMeta(nextMeta);
    emitSelection(nextIds, nextMeta);
  }

  if (loading) {
    return (
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="aspect-square rounded bg-surface" />
        ))}
      </div>
    );
  }

  if (error) {
    const hint =
      channel === "facebook"
        ? t("Select a Facebook Page above, then pick a post here.")
        : t("Select an Instagram account above, then pick a post or reel here.");
    return (
      <div className="space-y-2 py-6 text-left">
        <p className="text-sm text-muted break-words" dir="auto">
          {error === "Failed to load posts" ? t("Failed to load posts") : error}
        </p>
        <p className="text-xs text-zinc-500">{hint}</p>
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-muted">{t("No posts found")}</p>
      </div>
    );
  }

  const matching = query.trim()
    ? posts.filter((p) =>
        (p.caption ?? "").toLowerCase().includes(query.trim().toLowerCase())
      )
    : posts;

  const visible = matching.slice(0, shown);
  const remaining = matching.length - visible.length;

  return (
    <div className="space-y-2">
      {limitations.map((note) => (
        <p key={note} className="text-xs text-muted">
          {note}
        </p>
      ))}
      {channel === "facebook" ? (
        <div className="space-y-2 rounded-lg border border-border p-2">
          <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            {t("Paste Facebook post / reel link")}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={fbUrl}
              onChange={(e) => setFbUrl(e.target.value)}
              placeholder="https://www.facebook.com/share/r/…"
              className="w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
            />
            <button
              type="button"
              disabled={fbUrlBusy || !fbUrl.trim()}
              onClick={() => void resolveFacebookUrl()}
              className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {fbUrlBusy ? t("Resolving…") : t("Add link")}
            </button>
          </div>
          {fbUrlMessage ? (
            <p className="px-1 text-xs text-muted" dir="auto">
              {fbUrlMessage}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShown(PAGE_SIZE);
          }}
          placeholder={t("Search your posts by caption…")}
          className="w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
        />
        <span className="shrink-0 text-xs text-muted">{posts.length}</span>
      </div>
      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          {t("No posts match “")}
          {query}
          {t("”")}
        </p>
      ) : (
        <>
          {usedPostIds && Object.keys(usedPostIds).length > 0 && (
            <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border border-warning/50" />
              {t("Already used")}
            </p>
          )}
          {currentIds.length > 0 ? (
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-xs text-muted">
                {multi
                  ? t("{count} selected (max {max})", {
                      count: currentIds.length,
                      max: maxSelected,
                    })
                  : t("Selected")}
              </span>
              <button
                type="button"
                onClick={() => {
                  setPickedMeta({});
                  emitSelection([], {});
                }}
                className="text-xs font-medium text-accent hover:underline"
              >
                {t("Clear selection")}
              </button>
            </div>
          ) : multi ? (
            <p className="px-1 text-xs text-muted">
              {t("Select up to {max} posts", { max: maxSelected })}
            </p>
          ) : null}
          <div
            className={`grid gap-2 overflow-x-hidden overflow-y-auto p-1 ${
              dense
                ? "grid-cols-2 sm:grid-cols-3 max-h-[28rem]"
                : "grid-cols-3 sm:grid-cols-4 max-h-80"
            }`}
            style={{ gridAutoRows: "min-content" }}
          >
            {visible.map((post) => {
              const isSelected = currentIds.includes(post.id);
              const usedByName = usedPostIds?.[post.id];
              const isUsed = Boolean(usedByName) && !isSelected;
              const atLimit = multi && !isSelected && currentIds.length >= maxSelected;
              const thumb = post.thumbnail_url || post.media_url;
              const thumbBroken = Boolean(brokenThumbs[post.id]);
              const showThumb = Boolean(thumb) && !thumbBroken;
              const isVideo =
                post.media_type === "VIDEO" ||
                post.media_type === "REELS" ||
                post.media_product_type === "REELS";
              const showVideo =
                isVideo && hoveredId === post.id && Boolean(post.media_url);
              const captionPreview =
                (post.caption ?? "").trim().slice(0, 80) ||
                (channel === "facebook" ? "Facebook post" : "Instagram post");
              return (
                <button
                  key={post.id}
                  type="button"
                  disabled={atLimit}
                  onClick={() => togglePost(post)}
                  onMouseEnter={() => setHoveredId(post.id)}
                  onMouseLeave={() =>
                    setHoveredId((cur) => (cur === post.id ? null : cur))
                  }
                  aria-pressed={isSelected}
                  title={
                    atLimit
                      ? t("Maximum {max} posts", { max: maxSelected })
                      : isUsed && usedByName
                        ? t('Already used by "{name}"', { name: usedByName })
                        : captionPreview
                  }
                  className={`
              relative aspect-square w-full min-w-0 overflow-hidden rounded-lg border-2 bg-surface
              ${
                isSelected
                  ? "border-accent"
                  : isUsed
                    ? "border-warning/40 hover:border-warning/60"
                    : atLimit
                      ? "border-border opacity-40"
                      : "border-border hover:border-border-hover"
              }
            `}
                >
                  {showThumb ? (
                    <img
                      src={thumb}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                      onError={() =>
                        setBrokenThumbs((prev) => ({
                          ...prev,
                          [post.id]: true,
                        }))
                      }
                      className={`absolute inset-0 h-full w-full object-cover ${isUsed ? "opacity-75" : ""}`}
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-end bg-gradient-to-b from-zinc-800 to-zinc-950 p-2">
                      <span
                        className="line-clamp-4 w-full break-words text-left text-[11px] leading-snug text-zinc-100"
                        dir="auto"
                      >
                        {captionPreview}
                      </span>
                    </div>
                  )}
                  {showVideo && (
                    <video
                      src={post.media_url}
                      poster={thumb}
                      autoPlay
                      muted
                      loop
                      playsInline
                      preload="none"
                      className={`absolute inset-0 h-full w-full object-cover ${
                        isUsed ? "opacity-60" : ""
                      }`}
                    />
                  )}
                  {isSelected && (
                    <span className="absolute bottom-0 inset-x-0 bg-accent text-white text-xs py-1">
                      {multi
                        ? `${currentIds.indexOf(post.id) + 1}/${currentIds.length}`
                        : t("Selected")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE_SIZE)}
              className="w-full rounded-lg border border-border py-2 text-sm text-muted hover:text-foreground"
            >
              {t("Show")} {Math.min(PAGE_SIZE, remaining)} {t("more")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
