"use client";

import { Check, Copy, Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  formatVersionSummary,
  shortCommit,
  type PublicBuildMetadata,
} from "@/lib/build-metadata";

type VersionInformationProps = Readonly<{
  metadata: PublicBuildMetadata;
}>;

export function VersionInformation({ metadata }: VersionInformationProps) {
  const t = useTranslations("settings.versionInfo");
  const common = useTranslations("common");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const displayedCommit = shortCommit(metadata.commit) ?? t("development");
  const displayedBuildTime = metadata.buildTime ?? t("notProvided");

  async function copyVersionInformation() {
    const summary = formatVersionSummary(metadata, {
      appName: common("appName"),
      version: t("version"),
      commit: t("commit"),
      buildTime: t("buildTime"),
      development: t("development"),
      notProvided: t("notProvided"),
    });

    try {
      await navigator.clipboard.writeText(summary);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <section className="rounded-2xl border border-[--border-subtle] bg-white p-5" aria-labelledby="version-information-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Info className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <h2 id="version-information-title" className="font-display text-sm font-semibold text-[--text-primary]">
              {t("title")}
            </h2>
            <p className="mt-1 text-xs text-[--text-muted]">{t("description")}</p>
          </div>
        </div>
        <Button variant="outline" size="lg" onClick={copyVersionInformation}>
          {copyStatus === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {t("copy")}
        </Button>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetadataItem label={t("version")} value={metadata.version} />
        <MetadataItem label={t("commit")} value={displayedCommit} title={metadata.commit ?? undefined} />
        <MetadataItem label={t("buildTime")} value={displayedBuildTime} />
      </dl>

      <p role="status" aria-live="polite" className="mt-3 min-h-4 text-xs text-[--text-muted]">
        {copyStatus === "copied" ? t("copied") : copyStatus === "failed" ? t("copyFailed") : ""}
      </p>
    </section>
  );
}

function MetadataItem({ label, value, title }: Readonly<{ label: string; value: string; title?: string }>) {
  return (
    <div className="min-w-0 rounded-xl bg-[--surface] p-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[--text-muted]">{label}</dt>
      <dd className="mt-1 break-all font-mono text-xs text-[--text-primary]" title={title}>{value}</dd>
    </div>
  );
}
