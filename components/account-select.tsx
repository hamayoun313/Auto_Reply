"use client";

import { useI18n } from "@/lib/i18n/provider";
import { useMemo } from "react";
import {
  buildBrandGroups,
  type BrandFacebookPage,
  type BrandGroup,
  type BrandIgAccount,
} from "@/lib/brand-pages";

export interface AccountOption {
  id: string;
  username: string;
  instagramId: string;
  name?: string | null;
}

export interface FacebookPageOption {
  id: string;
  pageId?: string;
  name: string;
}

interface AccountSelectProps {
  accounts: AccountOption[] | BrandIgAccount[];
  /** When provided, brands pair FB+IG (e.g. Topsii) so both channels are controlled together. */
  facebookPages?: FacebookPageOption[] | BrandFacebookPage[];
  value: string;
  onChange: (value: string) => void;
  includeAll?: boolean;
  label?: string;
}

export default function AccountSelect({
  accounts,
  facebookPages,
  value,
  onChange,
  includeAll = true,
  label,
}: AccountSelectProps) {
  const { t } = useI18n();
  const brands: BrandGroup[] = useMemo(() => {
    if (facebookPages && facebookPages.length > 0) {
      return buildBrandGroups(accounts, facebookPages);
    }
    return accounts.map((account) => ({
      key: account.id,
      label: `@${account.username}`,
      facebookPageId: null as string | null,
      instagramAccountId: account.id,
    }));
  }, [accounts, facebookPages]);

  const showBrandMode = Boolean(facebookPages && facebookPages.length > 0);

  return (
    <label className="flex flex-col gap-2 text-sm">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {label ?? (showBrandMode ? t("Page / brand") : t("Instagram account"))}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-52 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
      >
        {includeAll && <option value="all">{t("All accounts")}</option>}
        {brands.map((brand) => (
          <option key={brand.key} value={brand.key}>
            {brand.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export type { BrandGroup };
