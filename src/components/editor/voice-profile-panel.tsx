"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Loader2, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface VoiceProfileView {
  id: string;
  name: string;
  provider: "indextts2" | "omnivoice";
  referenceUrl: string;
  referenceText: string | null;
  language: string;
  defaultSpeed: number;
  defaultPitch: number;
  durationMs: number | null;
}

export function VoiceProfilePanel({ projectId }: { projectId: string }) {
  const t = useTranslations("voiceProfiles");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [profiles, setProfiles] = useState<VoiceProfileView[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"indextts2" | "omnivoice">("indextts2");
  const [language, setLanguage] = useState("zh-CN");
  const [referenceText, setReferenceText] = useState("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await apiFetch(`/api/projects/${projectId}/voice-profiles`);
      const data = await response.json() as { profiles?: VoiceProfileView[] };
      setAvailable(true);
      setProfiles(data.profiles ?? []);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setAvailable(false);
        return;
      }
      const message = error instanceof Error ? error.message : t("loadFailed");
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => { void loadProfiles(); }, [loadProfiles]);

  async function createProfile() {
    if (!name.trim() || !file || !consentConfirmed) {
      toast.warning(t("requiredHint"));
      return;
    }
    if (file.size <= 0 || file.size > 50 * 1024 * 1024) {
      toast.warning(t("audioRules"));
      return;
    }
    if (!["audio/wav", "audio/mpeg", "audio/mp3"].includes(file.type) && !/\.(wav|mp3)$/i.test(file.name)) {
      toast.warning(t("audioRules"));
      return;
    }
    setSaving(true);
    let sourceAssetId: string | null = null;
    try {
      const uploadResponse = await apiFetch(`/api/projects/${projectId}/source-assets/audio`, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-AI-M-Filename": encodeURIComponent(file.name),
        },
        body: file,
      });
      const uploaded = await uploadResponse.json() as { asset: { id: string } };
      sourceAssetId = uploaded.asset.id;
      await apiFetch(`/api/projects/${projectId}/voice-profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          provider,
          language: language.trim(),
          referenceText: referenceText.trim(),
          defaultSpeed: 1,
          defaultPitch: 1,
          consentConfirmed,
          referenceSourceAssetId: sourceAssetId,
        }),
      });
      setName("");
      setReferenceText("");
      setConsentConfirmed(false);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setExpanded(false);
      await loadProfiles();
      toast.success(t("created"));
    } catch (error) {
      if (sourceAssetId) {
        await apiFetch(`/api/source-assets/${sourceAssetId}`, { method: "DELETE" }).catch(() => undefined);
      }
      toast.error(error instanceof Error ? error.message : t("createFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function removeProfile(profileId: string) {
    if (!window.confirm(t("deleteConfirm"))) return;
    try {
      await apiFetch(`/api/projects/${projectId}/voice-profiles/${profileId}`, { method: "DELETE" });
      setProfiles((items) => items.filter((item) => item.id !== profileId));
      toast.success(t("deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("deleteFailed"));
    }
  }

  if (available === false) return null;

  return (
    <div className="rounded-2xl border border-[--border-subtle] bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/10 text-amber-700">
            <AudioLines className="h-4 w-4" />
          </div>
          <div>
            <h3 className="font-display text-base font-semibold text-[--text-primary]">{t("title")}</h3>
            <p className="text-xs text-[--text-muted]">{t("description")}</p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setExpanded((value) => !value)}>
          <Plus className="h-3.5 w-3.5" />
          {t("add")}
        </Button>
      </div>

      {expanded && (
        <div className="mt-5 grid gap-4 rounded-xl border border-[--border-subtle] bg-[--surface]/50 p-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("name")}</Label>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("engine")}</Label>
            <Select value={provider} onValueChange={(value) => setProvider(value as "indextts2" | "omnivoice")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="indextts2">IndexTTS2</SelectItem>
                <SelectItem value="omnivoice">OmniVoice</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("language")}</Label>
            <Input value={language} onChange={(event) => setLanguage(event.target.value)} maxLength={40} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("referenceAudio")}</Label>
            <Input
              ref={fileInputRef}
              type="file"
              accept="audio/wav,audio/mpeg,.wav,.mp3"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <p className="text-[11px] text-[--text-muted]">{t("audioRules")}</p>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>{t("referenceText")}</Label>
            <Textarea value={referenceText} onChange={(event) => setReferenceText(event.target.value)} maxLength={20_000} rows={3} />
          </div>
          <label className="flex items-start gap-2 text-xs text-[--text-secondary] md:col-span-2">
            <input
              type="checkbox"
              checked={consentConfirmed}
              onChange={(event) => setConsentConfirmed(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-[--border-subtle]"
            />
            <span>{t("consent")}</span>
          </label>
          <div className="md:col-span-2">
            <Button onClick={createProfile} disabled={saving || !file || !name.trim() || !consentConfirmed}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {saving ? t("saving") : t("save")}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4">
        {loading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-[--text-muted]" /></div>
        ) : loadError ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 py-7 text-center">
            <p className="max-w-lg text-sm text-destructive">{loadError}</p>
            <Button size="sm" variant="outline" onClick={() => void loadProfiles()}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t("retry")}
            </Button>
          </div>
        ) : profiles.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[--border-subtle] py-8 text-center text-sm text-[--text-muted]">{t("empty")}</div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {profiles.map((profile) => (
              <div key={profile.id} className="rounded-xl border border-[--border-subtle] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[--text-primary]">{profile.name}</p>
                    <p className="text-[11px] text-[--text-muted]">
                      {profile.provider === "indextts2" ? "IndexTTS2" : "OmniVoice"} · {profile.language}
                      {profile.durationMs ? ` · ${(profile.durationMs / 1000).toFixed(1)}s` : ""}
                    </p>
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => removeProfile(profile.id)} aria-label={t("delete")}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <audio className="mt-3 h-8 w-full" controls preload="metadata" src={profile.referenceUrl} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
