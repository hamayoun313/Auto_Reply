/**
 * Soft-pair Facebook Pages with Instagram accounts by display name / username
 * so a brand like "Topsii" can be controlled as one unit (FB + IG).
 */

export type BrandIgAccount = {
  id: string;
  username: string;
  name?: string | null;
  instagramId?: string;
};

export type BrandFacebookPage = {
  id: string;
  pageId?: string;
  name: string;
};

export type BrandGroup = {
  /** Stable select value, e.g. brand:cuidFb:cuidIg or ig:… / fb:… */
  key: string;
  label: string;
  facebookPageId: string | null;
  instagramAccountId: string | null;
};

/** Keep letters/digits from any script (Persian + Latin) for fuzzy matching. */
export function normalizeBrandKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0640\u200c\u200d]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function scorePair(pageName: string, username: string, igName?: string | null): number {
  const page = normalizeBrandKey(pageName);
  const user = normalizeBrandKey(username);
  const name = normalizeBrandKey(igName ?? "");
  if (!page) return 0;
  if (user && (page === user || page.includes(user) || user.includes(page))) return 100;
  if (name && (page === name || page.includes(name) || name.includes(page))) return 90;
  const userStem = user.slice(0, Math.min(8, user.length));
  if (userStem.length >= 3 && page.includes(userStem)) return 70;
  const pageStem = page.slice(0, Math.min(8, page.length));
  if (pageStem.length >= 3 && user.includes(pageStem)) return 65;
  return 0;
}

/**
 * Build brand options: paired FB+IG first, then leftover singles.
 */
export function buildBrandGroups(
  accounts: BrandIgAccount[],
  facebookPages: BrandFacebookPage[]
): BrandGroup[] {
  const usedIg = new Set<string>();
  const usedFb = new Set<string>();
  const brands: BrandGroup[] = [];

  const candidates = facebookPages
    .flatMap((page) =>
      accounts.map((account) => ({
        page,
        account,
        score: scorePair(page.name, account.username, account.name),
      }))
    )
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const row of candidates) {
    if (usedFb.has(row.page.id) || usedIg.has(row.account.id)) continue;
    usedFb.add(row.page.id);
    usedIg.add(row.account.id);
    brands.push({
      key: `brand:${row.page.id}:${row.account.id}`,
      label: `${row.page.name} · FB + IG @${row.account.username}`,
      facebookPageId: row.page.id,
      instagramAccountId: row.account.id,
    });
  }

  for (const page of facebookPages) {
    if (usedFb.has(page.id)) continue;
    brands.push({
      key: `fb:${page.id}`,
      label: `Facebook · ${page.name}`,
      facebookPageId: page.id,
      instagramAccountId: null,
    });
  }

  for (const account of accounts) {
    if (usedIg.has(account.id)) continue;
    brands.push({
      key: `ig:${account.id}`,
      label: `Instagram · @${account.username}`,
      facebookPageId: null,
      instagramAccountId: account.id,
    });
  }

  return brands;
}

export function parseBrandSelectValue(value: string): {
  facebookPageId: string | null;
  instagramAccountId: string | null;
} {
  if (!value || value === "all") {
    return { facebookPageId: null, instagramAccountId: null };
  }
  if (value.startsWith("brand:")) {
    const parts = value.split(":");
    return {
      facebookPageId: parts[1] || null,
      instagramAccountId: parts[2] || null,
    };
  }
  if (value.startsWith("fb:")) {
    return { facebookPageId: value.slice(3) || null, instagramAccountId: null };
  }
  if (value.startsWith("ig:")) {
    return { facebookPageId: null, instagramAccountId: value.slice(3) || null };
  }
  // Legacy: raw Instagram account id from old AccountSelect
  return { facebookPageId: null, instagramAccountId: value };
}

export function findBrandKeyForPair(
  brands: BrandGroup[],
  facebookPageId: string | null | undefined,
  instagramAccountId: string | null | undefined
): string | null {
  if (facebookPageId && instagramAccountId) {
    const both = brands.find(
      (b) =>
        b.facebookPageId === facebookPageId &&
        b.instagramAccountId === instagramAccountId
    );
    if (both) return both.key;
  }
  if (facebookPageId) {
    const fb = brands.find(
      (b) => b.facebookPageId === facebookPageId && !b.instagramAccountId
    );
    if (fb) return fb.key;
    const paired = brands.find((b) => b.facebookPageId === facebookPageId);
    if (paired) return paired.key;
  }
  if (instagramAccountId) {
    const ig = brands.find(
      (b) => b.instagramAccountId === instagramAccountId && !b.facebookPageId
    );
    if (ig) return ig.key;
    const paired = brands.find((b) => b.instagramAccountId === instagramAccountId);
    if (paired) return paired.key;
  }
  return null;
}
