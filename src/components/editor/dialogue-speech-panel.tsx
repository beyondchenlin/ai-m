"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Loader2, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { InlineModelPicker } from "@/components/editor/model-selector";
import { selectedProfileRevisionId } from "@/components/editor/model-picker-options";
import { useModelStore, type ModelRef } from "@/stores/model-store";

interface DialogueItem {
  id: string;
  text: string;
  characterName: string;
  audioUrl?: string | null;
}

interface VoiceProfileOption {
  id: string;
  name: string;
  provider: string;
  language: string;
}

interface JobView {
  id: string;
  status: string;
  errorMessageSafe?: string;
  artifacts?: Array<{ id: string; kind: string; url: string; mimeType: string; durationMs?: number }>;
}

export function DialogueSpeechPanel({
  projectId,
  dialogues,
  onCompleted,
}: {
  projectId: string;
  dialogues: DialogueItem[];
  onCompleted?: () => void;
}) {
  const t = useTranslations("speechGeneration");
  const defaultSpeechModel = useModelStore((state) => state.defaultSpeechModel);
  const [selectedModel, setSelectedModel] = useState<ModelRef | null>(defaultSpeechModel);
  const [profiles, setProfiles] = useState<VoiceProfileOption[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedVoiceProfileId, setSelectedVoiceProfileId] = useState("");
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [generatedAudio, setGeneratedAudio] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { queueMicrotask(() => setSelectedModel(defaultSpeechModel)); }, [defaultSpeechModel]);

  const loadVoiceProfiles = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await apiFetch(`/api/projects/${projectId}/voice-profiles`);
      const data = await response.json() as { profiles?: VoiceProfileOption[] };
      if (!mounted.current) return;
      const next = data.profiles ?? [];
      setAvailable(true);
      setProfiles(next);
      setSelectedVoiceProfileId((current) => next.some((profile) => profile.id === current)
        ? current
        : next[0]?.id || "");
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status === 404) {
        setAvailable(false);
        return;
      }
      const message = error instanceof Error ? error.message : t("voiceProfilesFailed");
      setLoadError(message);
      toast.error(message);
    }
  }, [projectId, t]);

  useEffect(() => { void loadVoiceProfiles(); }, [loadVoiceProfiles]);

  const selectedVoice = useMemo(
    () => profiles.find((profile) => profile.id === selectedVoiceProfileId) ?? null,
    [profiles, selectedVoiceProfileId],
  );

  async function waitForJob(jobId: string): Promise<JobView> {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      if (!mounted.current) throw new Error("Speech generation view was closed");
      const response = await apiFetch(`/api/generation/jobs/${jobId}`);
      const data = await response.json() as { job: JobView };
      if (data.job.status === "SUCCEEDED") return data.job;
      if (["FAILED", "CANCELLED", "NEEDS_ATTENTION"].includes(data.job.status)) {
        throw new Error(data.job.errorMessageSafe || `${t("failedStatus")}: ${data.job.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(t("timeout"));
  }

  async function generate(dialogue: DialogueItem) {
    if (inFlight.current.has(dialogue.id)) return;
    const profileRevisionId = selectedProfileRevisionId(selectedModel);
    if (!profileRevisionId) {
      toast.warning(t("selectModel"));
      return;
    }
    if (!selectedVoiceProfileId) {
      toast.warning(t("selectVoice"));
      return;
    }
    inFlight.current.add(dialogue.id);
    setRunning((state) => ({ ...state, [dialogue.id]: true }));
    try {
      const response = await apiFetch(`/api/projects/${projectId}/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: dialogue.text,
          dialogueId: dialogue.id,
          voiceProfileId: selectedVoiceProfileId,
          profileRevisionId,
          language: selectedVoice?.language,
        }),
      });
      const created = await response.json() as { jobId: string };
      const job = await waitForJob(created.jobId);
      const audio = job.artifacts?.find((artifact) => artifact.kind === "audio");
      if (!audio) throw new Error(t("noAudio"));
      if (mounted.current) setGeneratedAudio((state) => ({ ...state, [dialogue.id]: audio.url }));
      onCompleted?.();
      if (mounted.current) toast.success(t("completed"));
    } catch (error) {
      if (mounted.current) toast.error(error instanceof Error ? error.message : t("failed"));
    } finally {
      inFlight.current.delete(dialogue.id);
      if (mounted.current) setRunning((state) => ({ ...state, [dialogue.id]: false }));
    }
  }

  if (dialogues.length === 0) return null;

  return (
    <div className="space-y-3 rounded-xl border border-amber-200/70 bg-amber-50/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
          <AudioLines className="h-3.5 w-3.5" />
          {available === true ? t("title") : t("dialogueTitle")}
        </div>
        {available === true && (
          <>
            <InlineModelPicker
              capability="speech"
              value={selectedModel}
              onChange={setSelectedModel}
              showLocalProfiles
            />
            <select
              aria-label={t("selectVoice")}
              value={selectedVoiceProfileId}
              onChange={(event) => setSelectedVoiceProfileId(event.target.value)}
              className="min-w-[140px] rounded-lg border border-amber-200 bg-white px-2 py-1 text-xs outline-none"
            >
              <option value="">{t("selectVoice")}</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {profile.provider === "indextts2" ? "IndexTTS2" : "OmniVoice"}
                </option>
              ))}
            </select>
          </>
        )}
      </div>


      {loadError && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2">
          <p className="text-xs text-destructive">{loadError}</p>
          <Button size="xs" variant="outline" onClick={() => void loadVoiceProfiles()}>
            <RefreshCw className="h-3 w-3" />
            {t("retryLoad")}
          </Button>
        </div>
      )}

      {available === true && profiles.length === 0 && (
        <p className="text-xs text-amber-800">{t("noVoiceProfiles")}</p>
      )}

      {dialogues.map((dialogue) => {
        const audioUrl = generatedAudio[dialogue.id] || dialogue.audioUrl || "";
        return (
          <div key={dialogue.id} className="rounded-lg bg-white/80 p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 text-xs text-[--text-secondary]">
                <span className="font-semibold text-primary">{dialogue.characterName}</span>
                <span className="mx-1">—</span>
                <span>{dialogue.text}</span>
              </div>
              {available === true && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => generate(dialogue)}
                  disabled={running[dialogue.id] || !selectedVoiceProfileId || !selectedModel}
                >
                  {running[dialogue.id]
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : audioUrl ? <RefreshCw className="h-3 w-3" /> : <AudioLines className="h-3 w-3" />}
                  {audioUrl ? t("regenerate") : t("generate")}
                </Button>
              )}
            </div>
            {audioUrl && <audio className="mt-2 h-8 w-full" controls preload="metadata" src={audioUrl} />}
          </div>
        );
      })}
    </div>
  );
}
