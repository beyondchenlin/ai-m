"use client";

import { Label } from "@/components/ui/label";
import { useModelStore, type Capability, type ModelRef } from "@/stores/model-store";
import { useTranslations } from "next-intl";
import { Type, ImageIcon, VideoIcon, AudioLines } from "lucide-react";

interface PickerRowProps {
  label: string;
  icon: React.ReactNode;
  color: string;
  options: {
    providerId: string;
    providerName: string;
    modelId: string;
    modelName: string;
  }[];
  value: ModelRef | null;
  onChange: (ref: ModelRef | null) => void;
}

function PickerRow({ label, icon, color, options, value, onChange }: PickerRowProps) {
  const currentValue = value ? `${value.providerId}:${value.modelId}` : "";

  return (
    <div className="flex items-center gap-3 rounded-xl border border-[--border-subtle] bg-[--surface]/50 px-3 py-2.5">
      <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${color}`}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <Label className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[--text-muted]">
          {label}
        </Label>
        <select
          value={currentValue}
          onChange={(event) => {
            if (!event.target.value) {
              onChange(null);
              return;
            }
            const [providerId, ...rest] = event.target.value.split(":");
            onChange({ providerId, modelId: rest.join(":") });
          }}
          className="mt-0.5 block w-full rounded-lg border-0 bg-transparent py-0 text-sm font-medium text-[--text-primary] outline-none"
        >
          <option value="">--</option>
          {options.map((option) => (
            <option key={`${option.providerId}:${option.modelId}`} value={`${option.providerId}:${option.modelId}`}>
              {option.providerName} / {option.modelName}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function DefaultModelPicker() {
  const t = useTranslations("settings");
  const {
    providers,
    defaultTextModel,
    defaultImageModel,
    defaultVideoModel,
    defaultSpeechModel,
    setDefaultTextModel,
    setDefaultImageModel,
    setDefaultVideoModel,
    setDefaultSpeechModel,
  } = useModelStore();

  function getOptions(capability: Capability) {
    return providers
      .filter((provider) => provider.capability === capability)
      .flatMap((provider) => provider.models
        .filter((model) => model.checked)
        .map((model) => ({
          providerId: provider.id,
          providerName: provider.name,
          modelId: model.id,
          modelName: model.name,
        })));
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <PickerRow
        label={t("defaultTextModel")}
        icon={<Type className="h-4 w-4" />}
        color="bg-blue-500/10 text-blue-600"
        options={getOptions("text")}
        value={defaultTextModel}
        onChange={setDefaultTextModel}
      />
      <PickerRow
        label={t("defaultImageModel")}
        icon={<ImageIcon className="h-4 w-4" />}
        color="bg-emerald-500/10 text-emerald-600"
        options={getOptions("image")}
        value={defaultImageModel}
        onChange={setDefaultImageModel}
      />
      <PickerRow
        label={t("defaultVideoModel")}
        icon={<VideoIcon className="h-4 w-4" />}
        color="bg-purple-500/10 text-purple-600"
        options={getOptions("video")}
        value={defaultVideoModel}
        onChange={setDefaultVideoModel}
      />
      <PickerRow
        label={t("defaultSpeechModel")}
        icon={<AudioLines className="h-4 w-4" />}
        color="bg-amber-500/10 text-amber-700"
        options={getOptions("speech")}
        value={defaultSpeechModel}
        onChange={setDefaultSpeechModel}
      />
    </div>
  );
}
