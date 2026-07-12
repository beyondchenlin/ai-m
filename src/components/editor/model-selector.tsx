"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useModelStore, type Capability, type ModelRef } from "@/stores/model-store";
import { Type, ImageIcon, VideoIcon, ChevronDown, Check, Cpu } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";

const ICONS: Record<Capability, React.ReactNode> = {
  text: <Type className="h-3 w-3" />,
  image: <ImageIcon className="h-3 w-3" />,
  video: <VideoIcon className="h-3 w-3" />,
};

/** 本地生成配置选项 */
interface LocalProfileOption {
  id: string;
  displayName: string;
  adapterKind: string;
  isLocal: true;
}

const COLORS: Record<Capability, string> = {
  text: "bg-blue-500/10 text-blue-600",
  image: "bg-emerald-500/10 text-emerald-600",
  video: "bg-purple-500/10 text-purple-600",
};

const SETTERS: Record<Capability, "setDefaultTextModel" | "setDefaultImageModel" | "setDefaultVideoModel"> = {
  text: "setDefaultTextModel",
  image: "setDefaultImageModel",
  video: "setDefaultVideoModel",
};

const GETTERS: Record<Capability, "defaultTextModel" | "defaultImageModel" | "defaultVideoModel"> = {
  text: "defaultTextModel",
  image: "defaultImageModel",
  video: "defaultVideoModel",
};

interface InlineModelPickerProps {
  capability: Capability;
  value?: ModelRef | null;
  onChange?: (ref: ModelRef) => void;
  /** 是否显示本地生成配置选项 */
  showLocalProfiles?: boolean;
}

export function InlineModelPicker({ capability, value: controlledValue, onChange, showLocalProfiles = false }: InlineModelPickerProps) {
  const providers = useModelStore((s) => s.providers);
  const globalValue = useModelStore((s) => s[GETTERS[capability]]);
  const globalSetter = useModelStore((s) => s[SETTERS[capability]]);
  const isControlled = onChange !== undefined;
  const value = isControlled ? controlledValue : globalValue;
  const setter = isControlled ? onChange : globalSetter;
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [localProfiles, setLocalProfiles] = useState<LocalProfileOption[]>([]);

  // 查询本地生成配置
  useEffect(() => {
    if (!showLocalProfiles) return;

    apiFetch(`/api/generation/profiles?capability=${capability}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.profiles) {
          setLocalProfiles(
            data.profiles.map((p: { id: string; displayName: string; adapterKind: string }) => ({
              id: p.id,
              displayName: p.displayName,
              adapterKind: p.adapterKind,
              isLocal: true as const,
            }))
          );
        }
      })
      .catch((err) => {
        console.warn("Failed to load local profiles:", err);
      });
  }, [showLocalProfiles, capability]);

  const options = useMemo(() => {
    const result: { providerId: string; providerName: string; modelId: string; modelName: string }[] = [];
    for (const p of providers) {
      if (p.capability !== capability) continue;
      for (const m of p.models) {
        if (!m.checked) continue;
        result.push({
          providerId: p.id,
          providerName: p.name,
          modelId: m.id,
          modelName: m.name,
        });
      }
    }
    return result;
  }, [providers, capability]);

  // Auto-select first option if nothing is selected (only in uncontrolled mode)
  useEffect(() => {
    if (!isControlled && !value && options.length > 0) {
      globalSetter({ providerId: options[0].providerId, modelId: options[0].modelId } as ModelRef);
    }
  }, [isControlled, value, options, globalSetter]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (options.length === 0 && localProfiles.length === 0) return null;

  const currentKey = value
    ? `${value.providerId}:${value.modelId}`
    : options.length > 0
      ? `${options[0].providerId}:${options[0].modelId}`
      : localProfiles.length > 0
        ? `local:${localProfiles[0].id}`
        : "";

  const currentOption = options.find(
    (o) => `${o.providerId}:${o.modelId}` === currentKey
  );

  // 检查是否是本地配置
  const currentLocalProfile = value && "providerId" in value && value.providerId === "local"
    ? localProfiles.find((p) => p.id === value.modelId)
    : null;

  const multiProvider = new Set(options.map((o) => o.providerId)).size > 1;

  function getLabel(opt: (typeof options)[number]) {
    return multiProvider
      ? `${opt.providerName} / ${opt.modelName}`
      : opt.modelName;
  }

  function handleSelect(opt: (typeof options)[number]) {
    setter({ providerId: opt.providerId, modelId: opt.modelId } as ModelRef);
    setOpen(false);
  }

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => {
          if (!open && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            setDropUp(rect.top > window.innerHeight / 2);
          }
          setOpen(!open);
        }}
        className="flex items-center gap-1.5 rounded-lg border border-[--border-subtle] bg-white px-2 py-1 transition-colors hover:border-[--border-hover]"
      >
        <div
          className={`flex h-5 w-5 items-center justify-center rounded ${COLORS[capability]}`}
        >
          {currentLocalProfile ? <Cpu className="h-3 w-3" /> : ICONS[capability]}
        </div>
        <span className="max-w-[140px] truncate text-[11px] font-medium text-[--text-primary]">
          {currentLocalProfile
            ? currentLocalProfile.displayName
            : currentOption
              ? getLabel(currentOption)
              : "—"}
        </span>
        <ChevronDown
          className={`h-3 w-3 text-[--text-muted] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div className={`absolute left-0 z-50 min-w-[200px] overflow-hidden rounded-xl border border-[--border-subtle] bg-white py-1 shadow-lg ${dropUp ? "bottom-full mb-1" : "top-full mt-1"}`}>
          {/* 云端供应商选项 */}
          {options.map((opt) => {
            const key = `${opt.providerId}:${opt.modelId}`;
            const selected = key === currentKey;
            return (
              <button
                key={key}
                type="button"
                onClick={() => handleSelect(opt)}
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
                <span className="truncate font-medium">{getLabel(opt)}</span>
              </button>
            );
          })}

          {/* 本地生成配置选项 */}
          {showLocalProfiles && localProfiles.length > 0 && (
            <>
              {options.length > 0 && (
                <div className="my-1 border-t border-[--border-subtle]" />
              )}
              <div className="px-3 py-1 text-[10px] font-semibold uppercase text-[--text-muted]">
                本地生成
              </div>
              {localProfiles.map((profile) => {
                const key = `local:${profile.id}`;
                const selected = value && "providerId" in value && value.providerId === "local" && value.modelId === profile.id;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setter({ providerId: "local", modelId: profile.id } as ModelRef);
                      setOpen(false);
                    }}
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
                    <Cpu className="h-3 w-3 text-emerald-600" />
                    <span className="truncate font-medium">{profile.displayName}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
