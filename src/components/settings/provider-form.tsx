"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  useModelStore,
  type Provider,
  type Protocol,
  type Capability,
} from "@/stores/model-store";
import { useTranslations } from "next-intl";
import { Loader2, Download, Plus, Eye, EyeOff, Trash2, Search, ServerCog } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";

const DEFAULT_BASE_URLS: Record<Protocol, string> = {
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
  seedance: "https://ark.cn-beijing.volces.com",
  "ucloud-seedance": "https://api.modelverse.cn",
  kling: "https://api.klingai.com",
  wan: "https://dashscope.aliyuncs.com/api/v1",
  dashscope: "https://dashscope.aliyuncs.com/api/v1",
  comfyui: "",
};

function getProtocolOptions(capability: Capability): { value: Protocol; label: string }[] {
  if (capability === "speech") {
    return [{ value: "comfyui", label: "ComfyUI（服务端工作流）" }];
  }
  if (capability === "text") {
    return [
      { value: "openai", label: "OpenAI" },
      { value: "gemini", label: "Gemini" },
    ];
  }
  if (capability === "image") {
    return [
      { value: "openai", label: "OpenAI" },
      { value: "gemini", label: "Gemini" },
      { value: "kling", label: "Kling" },
      { value: "dashscope", label: "百炼（图片）" },
      { value: "comfyui", label: "ComfyUI（服务端工作流）" },
    ];
  }
  return [
    { value: "seedance", label: "Seedance" },
    { value: "ucloud-seedance", label: "Seedance（UCloud）" },
    { value: "gemini", label: "Gemini（Veo）" },
    { value: "kling", label: "Kling" },
    { value: "wan", label: "百炼（视频）" },
    { value: "comfyui", label: "ComfyUI（服务端工作流）" },
  ];
}

interface ProviderFormProps {
  provider: Provider;
}

export function ProviderForm({ provider }: ProviderFormProps) {
  const t = useTranslations("settings");
  const { updateProvider, setModels, toggleModel, addManualModel, removeModel } = useModelStore();
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [manualModelId, setManualModelId] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  const isKling = provider.protocol === "kling";
  const isComfyUI = provider.protocol === "comfyui";

  async function handleFetchModels() {
    setFetching(true);
    setFetchError(null);
    try {
      const response = await apiFetch("/api/models/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: provider.protocol,
          capability: provider.capability,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
        }),
      });
      const data = await response.json() as { models?: Array<{ id: string; name: string }>; error?: string };
      if (!Array.isArray(data.models)) throw new Error(data.error || "Failed to fetch models");
      const previous = new Map(provider.models.map((model) => [model.id, model.checked]));
      const models = data.models.map((model) => ({
        id: model.id,
        name: model.name,
        checked: previous.get(model.id) ?? isComfyUI,
      }));
      setModels(provider.id, models);
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Network error");
    } finally {
      setFetching(false);
    }
  }

  function handleAddManualModel() {
    const id = manualModelId.trim();
    if (!id || isComfyUI) return;
    addManualModel(provider.id, id);
    setManualModelId("");
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("providerName")}</Label>
          <Input
            value={provider.name}
            onChange={(event) => updateProvider(provider.id, { name: event.target.value })}
            placeholder={provider.capability === "speech" ? "例如：本地声音工作流" : "e.g. DeepSeek, OpenRouter..."}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("protocol")}</Label>
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {getProtocolOptions(provider.capability).map((option) => (
              <button
                type="button"
                key={option.value}
                onClick={() => {
                  const isDefaultUrl = !provider.baseUrl || Object.values(DEFAULT_BASE_URLS).includes(provider.baseUrl);
                  updateProvider(provider.id, {
                    protocol: option.value,
                    ...(isDefaultUrl ? { baseUrl: DEFAULT_BASE_URLS[option.value] } : {}),
                    ...(option.value === "comfyui" ? { apiKey: "", secretKey: undefined } : {}),
                  });
                }}
                className={`rounded-lg border px-2.5 py-[7px] text-xs transition-all ${
                  provider.protocol === option.value
                    ? "border-primary/30 bg-primary/8 font-medium text-primary"
                    : "border-[--border-subtle] text-[--text-secondary] hover:border-[--border-hover]"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isComfyUI ? (
        <div className="flex gap-3 rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-xs text-blue-900">
          <ServerCog className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold">{t("serverManagedWorkflow")}</p>
            <p className="leading-5 text-blue-800">{t("serverManagedWorkflowDesc")}</p>
          </div>
        </div>
      ) : isKling ? (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Base URL</Label>
            <Input value={provider.baseUrl} onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })} placeholder="https://api.klingai.com" />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SecretField label="Access Key (AK)" value={provider.apiKey} visible={showKey} onVisibleChange={setShowKey} onChange={(value) => updateProvider(provider.id, { apiKey: value })} />
            <SecretField label="Secret Key (SK)" value={provider.secretKey ?? ""} visible={showSecretKey} onVisibleChange={setShowSecretKey} onChange={(value) => updateProvider(provider.id, { secretKey: value })} />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Base URL</Label>
            <Input
              value={provider.baseUrl}
              onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })}
              placeholder={provider.protocol === "dashscope" || provider.protocol === "wan"
                ? "https://dashscope.aliyuncs.com/api/v1"
                : "https://api.openai.com"}
            />
          </div>
          <SecretField label="API Key" value={provider.apiKey} visible={showKey} onVisibleChange={setShowKey} onChange={(value) => updateProvider(provider.id, { apiKey: value })} />
        </div>
      )}

      {!isComfyUI && (
        <p className="text-[11px] leading-5 text-[--text-muted]">{t("credentialsSessionOnly")}</p>
      )}

      <div className="border-t border-[--border-subtle]" />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs">{isComfyUI ? t("workflowProfiles") : t("models")}</Label>
          <Button
            size="sm"
            variant="outline"
            onClick={handleFetchModels}
            disabled={fetching || (!isComfyUI && !provider.apiKey && provider.protocol !== "kling")}
          >
            {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {isComfyUI ? t("fetchWorkflowProfiles") : t("fetchModels")}
          </Button>
        </div>

        {fetchError && (
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2">
            <p className="text-xs text-destructive">{fetchError}</p>
          </div>
        )}

        {!isComfyUI && (
          <div className="flex gap-2">
            <Input
              value={manualModelId}
              onChange={(event) => setManualModelId(event.target.value)}
              placeholder={t("manualModelPlaceholder")}
              onKeyDown={(event) => event.key === "Enter" && handleAddManualModel()}
              className="flex-1"
            />
            <Button size="sm" variant="outline" onClick={handleAddManualModel} disabled={!manualModelId.trim()}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {provider.models.length > 0 && (() => {
          const query = modelSearch.toLowerCase();
          const filtered = query
            ? provider.models.filter((model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query))
            : provider.models;
          const checkedCount = provider.models.filter((model) => model.checked).length;
          return (
            <div className="overflow-hidden rounded-xl border border-[--border-subtle]">
              <div className="flex items-center gap-2 border-b border-[--border-subtle] bg-[--surface]/50 px-3 py-2">
                <Search className="h-3.5 w-3.5 flex-shrink-0 text-[--text-muted]" />
                <input
                  type="text"
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder={t("searchModels")}
                  className="flex-1 bg-transparent text-xs text-[--text-primary] outline-none placeholder:text-[--text-muted]"
                />
                <span className="flex-shrink-0 text-[10px] tabular-nums text-[--text-muted]">{checkedCount} / {provider.models.length}</span>
              </div>
              <div className="max-h-56 overflow-y-auto p-1.5">
                {filtered.length === 0 ? (
                  <p className="py-4 text-center text-xs text-[--text-muted]">{t("noModelsFound")}</p>
                ) : (
                  <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2 lg:grid-cols-3">
                    {filtered.map((model) => (
                      <label key={model.id} className={`group/item flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors ${model.checked ? "bg-primary/5" : "hover:bg-[--surface]"}`}>
                        <input type="checkbox" checked={model.checked} onChange={() => toggleModel(provider.id, model.id)} className="h-3.5 w-3.5 flex-shrink-0 rounded border-[--border-subtle] accent-primary" />
                        <span className={`min-w-0 flex-1 truncate text-xs ${model.checked ? "font-medium text-[--text-primary]" : "text-[--text-secondary]"}`} title={model.id}>{model.name}</span>
                        {!isComfyUI && (
                          <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); removeModel(provider.id, model.id); }} className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[--text-muted] opacity-0 transition-all hover:text-destructive group-hover/item:opacity-100">
                            <Trash2 className="h-2.5 w-2.5" />
                          </button>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function SecretField({ label, value, visible, onVisibleChange, onChange }: {
  label: string;
  value: string;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="relative">
        <Input type={visible ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} placeholder="••••••••" className="pr-10" />
        <button type="button" onClick={() => onVisibleChange(!visible)} className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-[--text-muted] hover:text-[--text-primary]">
          {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}
