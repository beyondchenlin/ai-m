"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Check,
  ChevronDown,
  Cpu,
  ImageIcon,
  Type,
  VideoIcon,
} from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";
import { useModelStore, type Capability, type ModelRef } from "@/stores/model-store";
import {
  buildModelPickerOptions,
  modelRefStableId,
  type LocalProfileOption,
  type ModelPickerOption,
} from "./model-picker-options";

const ICONS: Record<Capability, React.ReactNode> = {
  text: <Type className="h-3 w-3" />,
  image: <ImageIcon className="h-3 w-3" />,
  video: <VideoIcon className="h-3 w-3" />,
  speech: <AudioLines className="h-3 w-3" />,
};

const COLORS: Record<Capability, string> = {
  text: "bg-blue-500/10 text-blue-600",
  image: "bg-emerald-500/10 text-emerald-600",
  video: "bg-purple-500/10 text-purple-600",
  speech: "bg-amber-500/10 text-amber-700",
};

const SETTERS: Record<Capability, "setDefaultTextModel" | "setDefaultImageModel" | "setDefaultVideoModel" | "setDefaultSpeechModel"> = {
  text: "setDefaultTextModel",
  image: "setDefaultImageModel",
  video: "setDefaultVideoModel",
  speech: "setDefaultSpeechModel",
};

const GETTERS: Record<Capability, "defaultTextModel" | "defaultImageModel" | "defaultVideoModel" | "defaultSpeechModel"> = {
  text: "defaultTextModel",
  image: "defaultImageModel",
  video: "defaultVideoModel",
  speech: "defaultSpeechModel",
};

interface InlineModelPickerProps {
  capability: Capability;
  value?: ModelRef | null;
  onChange?: (ref: ModelRef) => void;
  showLocalProfiles?: boolean;
}

function parseProfilesResponse(data: unknown): LocalProfileOption[] {
  if (!data || typeof data !== "object") throw new Error("Profile listing response is invalid");
  const profiles = (data as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles)) throw new Error("Profile listing response is invalid");
  return profiles.flatMap((profile): LocalProfileOption[] => {
    if (!profile || typeof profile !== "object") return [];
    const candidate = profile as Record<string, unknown>;
    if (
      typeof candidate.id !== "string"
      || !candidate.id.trim()
      || typeof candidate.displayName !== "string"
      || !candidate.displayName.trim()
      || typeof candidate.adapterKind !== "string"
      || candidate.adapterKind !== "comfyui"
    ) return [];
    return [{
      id: candidate.id.trim(),
      displayName: candidate.displayName.trim(),
      adapterKind: candidate.adapterKind,
    }];
  });
}

export function InlineModelPicker({
  capability,
  value: controlledValue,
  onChange,
  showLocalProfiles = false,
}: InlineModelPickerProps) {
  const providers = useModelStore((state) => state.providers);
  const globalValue = useModelStore((state) => state[GETTERS[capability]]);
  const globalSetter = useModelStore((state) => state[SETTERS[capability]]);
  const value = onChange ? controlledValue : globalValue;
  const setter = onChange ?? globalSetter;
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const [dropUp, setDropUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [profileResult, setProfileResult] = useState<{
    requestKey: string;
    profiles: LocalProfileOption[];
    status: "ready" | "error";
  } | null>(null);
  const profileRequestKey = capability;

  useEffect(() => {
    if (!showLocalProfiles) return;

    const controller = new AbortController();
    void apiFetch(`/api/generation/profiles?capability=${capability}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Profile listing failed with status ${response.status}`);
        const profiles = parseProfilesResponse(await response.json());
        if (!controller.signal.aborted) {
          setProfileResult({ requestKey: capability, profiles, status: "ready" });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("Failed to load local profiles:", error);
        setProfileResult({ requestKey: capability, profiles: [], status: "error" });
      });
    return () => controller.abort();
  }, [showLocalProfiles, capability]);

  const currentProfileResult = showLocalProfiles && profileResult?.requestKey === profileRequestKey
    ? profileResult
    : null;
  const localProfiles = useMemo(
    () => currentProfileResult?.profiles ?? [],
    [currentProfileResult],
  );
  const profilesLoading = showLocalProfiles && currentProfileResult === null;
  const profilesError = currentProfileResult?.status === "error";

  const options = useMemo(
    () => buildModelPickerOptions(
      providers,
      capability,
      showLocalProfiles ? localProfiles : [],
    ),
    [providers, capability, showLocalProfiles, localProfiles],
  );

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (options.length === 0 && !profilesLoading && !profilesError) return null;

  const currentStableId = value ? modelRefStableId(value) : "";
  const currentOption = options.find((option) => option.stableId === currentStableId);
  const multiProvider = new Set(options.map((option) => option.providerId)).size > 1;

  function getLabel(option: ModelPickerOption) {
    return multiProvider
      ? `${option.providerName} / ${option.modelName}`
      : option.modelName;
  }

  function handleSelect(option: ModelPickerOption) {
    setter({ providerId: option.providerId, modelId: option.modelId });
    setOpen(false);
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-label={`Select ${capability} model`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        onClick={() => {
          if (!open && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            setDropUp(rect.top > window.innerHeight / 2);
          }
          setOpen(!open);
        }}
        className="flex items-center gap-1.5 rounded-lg border border-[--border-subtle] bg-white px-2 py-1 transition-colors hover:border-[--border-hover]"
      >
        <div className={`flex h-5 w-5 items-center justify-center rounded ${COLORS[capability]}`}>
          {currentOption?.source === "profile" ? <Cpu className="h-3 w-3" /> : ICONS[capability]}
        </div>
        <span className="max-w-[140px] truncate text-[11px] font-medium text-[--text-primary]">
          {currentOption ? getLabel(currentOption) : "请选择"}
        </span>
        <ChevronDown
          className={`h-3 w-3 text-[--text-muted] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          className={`absolute left-0 z-50 min-w-[200px] overflow-hidden rounded-xl border border-[--border-subtle] bg-white py-1 shadow-lg ${dropUp ? "bottom-full mb-1" : "top-full mt-1"}`}
        >
          {options.map((option, index) => {
            const selected = option.stableId === currentStableId;
            const showProfileSeparator = option.source === "profile"
              && index > 0
              && options[index - 1]?.source !== "profile";
            return (
              <div key={option.stableId}>
                {showProfileSeparator && <div className="my-1 border-t border-[--border-subtle]" />}
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => handleSelect(option)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                    selected
                      ? "bg-primary/5 text-primary"
                      : "text-[--text-primary] hover:bg-[--surface]"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ${
                      selected
                        ? "bg-primary text-white"
                        : "border border-[--border-subtle]"
                    }`}
                  >
                    {selected && <Check className="h-2.5 w-2.5" />}
                  </span>
                  {option.source === "profile" && <Cpu className="h-3 w-3 text-emerald-600" />}
                  <span className="truncate font-medium">{getLabel(option)}</span>
                </button>
              </div>
            );
          })}
          {profilesLoading && (
            <div className="px-3 py-2 text-xs text-[--text-muted]">正在读取本地配置…</div>
          )}
          {profilesError && (
            <div role="alert" className="px-3 py-2 text-xs text-red-600">
              本地配置读取失败，当前选择不会自动切换
            </div>
          )}
        </div>
      )}
    </div>
  );
}
