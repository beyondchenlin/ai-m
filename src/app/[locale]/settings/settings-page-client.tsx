"use client";

import { LanguageSwitcher } from "@/components/language-switcher";
import { AgentSection } from "@/components/settings/agent-section";
import { DefaultModelPicker } from "@/components/settings/default-model-picker";
import { ProviderSection } from "@/components/settings/provider-section";
import { VersionInformation } from "@/components/settings/version-information";
import type { PublicBuildMetadata } from "@/lib/build-metadata";
import { ArrowLeft, Settings, Zap, Type, ImageIcon, VideoIcon, AudioLines, Wand2, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";

type SettingsPageClientProps = Readonly<{
  metadata: PublicBuildMetadata;
}>;

export function SettingsPageClient({ metadata }: SettingsPageClientProps) {
  const t = useTranslations("settings");
  const common = useTranslations("common");
  const router = useRouter();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex h-14 flex-shrink-0 items-center justify-between border-b border-[--border-subtle] bg-white/80 backdrop-blur-xl px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.back()}
            aria-label={common("back")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[--text-muted] transition-colors hover:bg-[--surface] hover:text-[--text-primary]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Settings className="h-3.5 w-3.5" />
            </div>
            <span className="font-display text-sm font-semibold text-[--text-primary]">{t("title")}</span>
          </div>
        </div>
        <LanguageSwitcher />
      </header>

      <main className="flex-1 bg-[--surface] p-4 lg:p-6">
        <div className="mx-auto max-w-4xl animate-page-in space-y-5">
          <div className="rounded-2xl border border-[--border-subtle] bg-white p-5">
            <h3 className="mb-4 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-[--text-muted]">
              <Zap className="h-3.5 w-3.5" />
              {t("defaultModels")}
            </h3>
            <DefaultModelPicker />
          </div>

          <Link
            href="/settings/prompts"
            className="flex items-center gap-3 rounded-2xl border border-[--border-subtle] bg-white p-5 transition-all duration-200 hover:border-[--border-hover] hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)]"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Wand2 className="h-4 w-4" />
            </div>
            <div>
              <div className="font-display text-sm font-semibold">{t("promptTemplates")}</div>
              <div className="text-xs text-[--text-muted]">{t("promptTemplatesDesc")}</div>
            </div>
          </Link>

          <Link
            href="/operations"
            className="flex items-center gap-3 rounded-2xl border border-amber-300/70 bg-amber-50 p-5 transition-all duration-200 hover:border-amber-500 hover:shadow-[0_2px_12px_rgba(120,78,0,0.10)]"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-200/70 text-amber-900">
              <ShieldAlert className="h-4 w-4" />
            </div>
            <div>
              <div className="font-display text-sm font-semibold">不确定任务处置台</div>
              <div className="text-xs text-[--text-muted]">查看 NEEDS_ATTENTION / SUBMISSION_UNKNOWN，并登记证据引用</div>
            </div>
          </Link>

          <AgentSection />

          <ProviderSection capability="text" label={t("languageModels")} icon={<Type className="h-3.5 w-3.5" />} defaultProtocol="openai" defaultBaseUrl="https://api.openai.com" />
          <ProviderSection capability="image" label={t("imageModels")} icon={<ImageIcon className="h-3.5 w-3.5" />} defaultProtocol="kling" defaultBaseUrl="https://api.klingai.com" />
          <ProviderSection capability="video" label={t("videoModels")} icon={<VideoIcon className="h-3.5 w-3.5" />} defaultProtocol="kling" defaultBaseUrl="https://api.klingai.com" />
          <ProviderSection capability="speech" label={t("speechModels")} icon={<AudioLines className="h-3.5 w-3.5" />} defaultProtocol="comfyui" defaultBaseUrl="" />

          <VersionInformation metadata={metadata} />
        </div>
      </main>
    </div>
  );
}
