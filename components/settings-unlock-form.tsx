"use client";

import { useState } from "react";

export function SettingsUnlockForm({ onUnlocked }: { onUnlocked: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings-unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        setError(res.status === 401 ? "Incorrect password" : "Unlock failed");
        setBusy(false);
        return;
      }
      onUnlocked();
    } catch {
      setError("Unlock failed");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-6 py-10">
      <div className="space-y-2 text-center">
        <h1 className="text-xl font-semibold text-foreground">Settings locked</h1>
        <p className="text-sm text-muted">
          Enter the settings password to view connections and tokens.
        </p>
      </div>
      <form onSubmit={onSubmit} className="space-y-5 panel rounded p-6">
        <div className="space-y-2">
          <label
            htmlFor="settings-code"
            className="block text-sm font-medium text-foreground"
          >
            Password
          </label>
          <input
            id="settings-code"
            type="password"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
            className="w-full rounded border border-border bg-surface px-4 py-3 text-sm text-foreground focus:border-accent/40 focus:outline-none"
          />
        </div>
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="inline-flex w-full items-center justify-center rounded bg-accent px-6 py-3.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Checking…" : "Unlock Settings"}
        </button>
      </form>
    </div>
  );
}
