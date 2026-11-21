/** Resolve all specific post ids for an automation (primary + extras). */
export function automationPostTargets(automation: {
  postId?: string | null;
  postIds?: string[] | null;
}): string[] {
  const ids: string[] = [];
  const primary = automation.postId?.trim();
  if (primary) ids.push(primary);
  for (const id of automation.postIds ?? []) {
    const trimmed = id?.trim();
    if (trimmed && !ids.includes(trimmed)) ids.push(trimmed);
  }
  return ids;
}

/** Normalize UI selection into primary postId + postIds extras. */
export function splitPrimaryAndExtraPostIds(postIds: string[]): {
  postId: string | null;
  postIds: string[];
} {
  const unique = Array.from(
    new Set(postIds.map((id) => id.trim()).filter(Boolean))
  );
  if (unique.length === 0) return { postId: null, postIds: [] };
  return { postId: unique[0], postIds: unique.slice(1) };
}

export const MAX_SPECIFIC_POSTS = 5;
