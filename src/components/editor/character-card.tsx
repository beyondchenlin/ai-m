"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations } from "next-intl";
import { uploadUrl } from "@/lib/utils/upload-url";
import { useModelStore, type ModelRef } from "@/stores/model-store";
import { Sparkles, Loader2, Copy, Check, ArrowUpCircle, Trash2, ChevronLeft, ChevronRight, Upload, Image as ImageIcon, Users } from "lucide-react";
import { InlineModelPicker } from "@/components/editor/model-selector";
import { apiFetch } from "@/lib/api-fetch";
import { useModelGuard } from "@/hooks/use-model-guard";
import { toast } from "sonner";
import { buildCharacterTurnaroundPrompt } from "@/lib/ai/prompts/character-image";

interface CharacterCardProps {
  id: string;
  projectId: string;
  name: string;
  description: string;
  visualHint: string | null;
  referenceImage: string | null;
  referenceImageHistory?: string | null;
  onUpdate: () => void;
  batchGenerating?: boolean;
  scope?: string;
  onPromote?: () => void;
  onDelete?: () => void;
  episodeName?: string;
}

export function CharacterCard({
  id,
  projectId,
  name,
  description,
  visualHint,
  referenceImage,
  referenceImageHistory,
  onUpdate,
  batchGenerating,
  scope,
  onPromote,
  onDelete,
  episodeName,
}: CharacterCardProps) {
  const t = useTranslations();
  const getModelConfig = useModelStore((s) => s.getModelConfig);
  const providers = useModelStore((s) => s.providers);
  const defaultImageModel = useModelStore((s) => s.defaultImageModel);
  const [imageModelRef, setImageModelRef] = useState<ModelRef | null>(() => defaultImageModel);
  const [editName, setEditName] = useState(name);
  const [editDesc, setEditDesc] = useState(description);
  const [editVisualHint, setEditVisualHint] = useState(visualHint ?? "");

  // Sync local state when props change (e.g. after re-extraction)
  useEffect(() => { setEditName(name); }, [name]);
  useEffect(() => { setEditDesc(description); }, [description]);
  useEffect(() => { setEditVisualHint(visualHint ?? ""); }, [visualHint]);
  const [generating, setGenerating] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [copied, setCopied] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [promotingToSubject, setPromotingToSubject] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const imageGuard = useModelGuard("image");
  const isGenerating = generating || (!!batchGenerating && !referenceImage);

  // 参考图配置
  const [referenceMode, setReferenceMode] = useState<"off" | "auto" | "forced">("auto");
  const [referenceImages, setReferenceImages] = useState<Array<{
    id: string;
    file: File;
    semanticType: string;
    strength: number;
  }>>([]);
  const referenceInputRef = useRef<HTMLInputElement>(null);

  function resolveImageRef(ref: ModelRef | null) {
    if (!ref) return null;
    const provider = providers.find((p) => p.id === ref.providerId);
    if (!provider) return null;
    return {
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      secretKey: provider.secretKey,
      modelId: ref.modelId,
    };
  }

  async function handleSave() {
    await apiFetch(`/api/projects/${projectId}/characters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName, description: editDesc, visualHint: editVisualHint }),
    });
    onUpdate();
  }

  async function handlePromoteToVisualSubject() {
    setPromotingToSubject(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/visual-subjects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "import_from_character",
          characterId: id,
        }),
      });

      if (res.ok) {
        toast.success("已升级为视觉主体");
        onUpdate();
      } else {
        toast.error("升级失败");
      }
    } catch (err) {
      console.error("Promote to visual subject error:", err);
      toast.error("升级失败");
    }
    setPromotingToSubject(false);
  }

  async function handleGenerateImage() {
    if (!imageGuard()) return;
    setGenerating(true);
    try {
      // 检查是否选择了本地生成配置
      const isLocalGeneration = imageModelRef?.providerId === "local";

      if (isLocalGeneration) {
        // v2 本地生成流程
        // 先上传参考图（如果有）
        const uploadedRefs = [];
        if (referenceMode !== "off" && referenceImages.length > 0) {
          for (const ref of referenceImages) {
            const form = new FormData();
            form.append("file", ref.file);
            const uploadRes = await apiFetch(`/api/projects/${projectId}/generate/upload`, {
              method: "POST",
              body: form,
            });
            const uploadData = await uploadRes.json();
            if (uploadData.path) {
              uploadedRefs.push({
                source: uploadData.path,
                semanticType: ref.semanticType,
                strength: ref.strength,
              });
            }
          }
        }

        const response = await apiFetch(`/api/projects/${projectId}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "single_character_image_v2",
            payload: {
              characterId: id,
              referenceMode,
              referenceImages: uploadedRefs,
            },
            profileRevisionId: imageModelRef?.modelId,
          }),
        });
        const data = await response.json();

        if (data.jobId) {
          // 开始轮询任务状态
          await pollJobStatus(data.jobId);
        } else {
          toast.error(t("common.generationFailed"));
        }
      } else {
        // v1 云端生成流程
        const response = await apiFetch(`/api/projects/${projectId}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "single_character_image",
            payload: { characterId: id },
            modelConfig: { ...getModelConfig(), image: resolveImageRef(imageModelRef) },
          }),
        });
        await response.json();
      }
    } catch (err) {
      console.error("Character image error:", err);
      toast.error(t("common.generationFailed"));
    }
    setGenerating(false);
    onUpdate();
  }

  /** 轮询 v2 任务状态 */
  async function pollJobStatus(jobId: string, maxAttempts = 60) {
    const pollInterval = 2000; // 2秒
    let attempts = 0;

    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      attempts++;

      try {
        const response = await apiFetch(`/api/generation/jobs/${jobId}`);
        const data = await response.json();

        if (data.job) {
          const status = data.job.status;

          if (status === "SUCCEEDED") {
            toast.success("图片生成完成");
            return;
          } else if (status === "FAILED" || status === "CANCELLED") {
            toast.error("图片生成失败");
            return;
          } else if (status === "NEEDS_ATTENTION") {
            toast.error("任务需要人工处理");
            return;
          }
          // 继续轮询：QUEUED, RUNNING, CANCEL_REQUESTED
        }
      } catch (err) {
        console.error("Poll job status error:", err);
      }
    }

    toast.error("任务超时，请稍后查看结果");
  }

  async function handleUploadImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await apiFetch(`/api/projects/${projectId}/characters/${id}/upload`, {
        method: "POST",
        body: form,
      });
      onUpdate();
    } catch (err) {
      console.error("Character image upload error:", err);
      toast.error(t("common.uploadFailed"));
    }
    setUploading(false);
  }

  /** 处理参考图上传 */
  async function handleReferenceUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    e.target.value = "";

    const newRefs = files.map((file) => ({
      id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      semanticType: "general",
      strength: 0.7,
    }));

    setReferenceImages((prev) => [...prev, ...newRefs]);
  }

  /** 删除参考图 */
  function removeReference(refId: string) {
    setReferenceImages((prev) => prev.filter((r) => r.id !== refId));
  }

  /** 更新参考图语义类型 */
  function updateReferenceSemantic(refId: string, semanticType: string) {
    setReferenceImages((prev) =>
      prev.map((r) => (r.id === refId ? { ...r, semanticType } : r))
    );
  }

  /** 更新参考图强度 */
  function updateReferenceStrength(refId: string, strength: number) {
    setReferenceImages((prev) =>
      prev.map((r) => (r.id === refId ? { ...r, strength } : r))
    );
  }

  return (
    <div className="group overflow-hidden rounded-2xl border border-[--border-subtle] bg-white transition-all duration-300 hover:border-[--border-hover] hover:shadow-lg hover:shadow-black/5">
      {/* Avatar area */}
      <div className="relative flex items-center justify-center bg-gradient-to-b from-[--surface] to-white p-8">
        {onDelete && (
          <button
            onClick={onDelete}
            className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-red-500/80 text-white opacity-0 transition-all hover:bg-red-600 group-hover:opacity-100"
            title={t("common.delete")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        {referenceImage ? (() => {
          let history: string[] = [];
          try { history = JSON.parse(referenceImageHistory || "[]"); } catch {}
          if (history.length === 0 && referenceImage) history = [referenceImage];
          const currentIdx = history.indexOf(referenceImage);
          const showArrows = history.length > 1;
          async function switchTo(newPath: string) {
            await apiFetch(`/api/projects/${projectId}/characters/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ referenceImage: newPath }),
            });
            onUpdate();
          }
          return (
            <div className="relative w-full aspect-video overflow-hidden rounded-xl cursor-pointer group" onClick={() => setLightbox(true)}>
              <img
                src={uploadUrl(referenceImage)}
                alt={name}
                className="w-full h-full object-cover"
              />
              {showArrows && (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = (currentIdx - 1 + history.length) % history.length;
                      switchTo(history[next]);
                    }}
                    className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = (currentIdx + 1) % history.length;
                      switchTo(history[next]);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1.5 text-white hover:bg-black/70"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                  <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white">
                    {currentIdx + 1}/{history.length}
                  </span>
                </>
              )}
            </div>
          );
        })() : isGenerating ? (
          <div className="w-full aspect-video rounded-xl animate-shimmer" />
        ) : (
          <div className="flex w-full aspect-video items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-accent/10 text-3xl font-bold text-primary">
            {name.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Scope badge */}
      {scope && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              scope === "main"
                ? "bg-blue-100 text-blue-700"
                : "bg-purple-100 text-purple-700"
            }`}
          >
            {scope === "main" ? t("episode.mainCharacter") : t("episode.guestCharacter")}
          </span>
          {episodeName && (
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
              {episodeName}
            </span>
          )}
          {scope === "guest" && onPromote && (
            <button
              onClick={onPromote}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-blue-600 hover:bg-blue-50 transition-colors"
            >
              <ArrowUpCircle className="h-3 w-3" />
              {t("episode.promoteToMain")}
            </button>
          )}
        </div>
      )}

      {/* Info */}
      <div className="space-y-3 p-4">
        <Input
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleSave}
          className="h-9 font-display font-semibold text-base"
        />
        <Textarea
          value={editDesc}
          onChange={(e) => setEditDesc(e.target.value)}
          onBlur={handleSave}
          placeholder={t("character.description")}
          className="h-32 resize-none text-sm"
        />
        <Input
          value={editVisualHint}
          onChange={(e) => setEditVisualHint(e.target.value)}
          onBlur={handleSave}
          placeholder={t("character.visualHint")}
          className="h-8 text-xs text-muted-foreground"
        />
        <div className="space-y-2">
            <InlineModelPicker capability="image" value={imageModelRef} onChange={setImageModelRef} showLocalProfiles={true} />

            {/* 参考图配置区域 */}
            <div className="space-y-2 rounded-lg border border-[--border-subtle] bg-[--surface] p-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[--text-secondary]">参考图模式</span>
                <select
                  value={referenceMode}
                  onChange={(e) => setReferenceMode(e.target.value as "off" | "auto" | "forced")}
                  className="rounded border border-[--border-subtle] bg-white px-2 py-1 text-xs"
                >
                  <option value="off">关闭</option>
                  <option value="auto">自动</option>
                  <option value="forced">强制</option>
                </select>
              </div>

              {referenceMode !== "off" && (
                <>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1 text-xs"
                      onClick={() => referenceInputRef.current?.click()}
                    >
                      <ImageIcon className="mr-1 h-3 w-3" />
                      添加参考图
                    </Button>
                    <input
                      ref={referenceInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={handleReferenceUpload}
                    />
                  </div>

                  {referenceImages.length > 0 && (
                    <div className="space-y-1">
                      {referenceImages.map((ref) => (
                        <div key={ref.id} className="flex items-center gap-2 rounded bg-white p-1.5 text-xs">
                          <span className="flex-1 truncate">{ref.file.name}</span>
                          <select
                            value={ref.semanticType}
                            onChange={(e) => updateReferenceSemantic(ref.id, e.target.value)}
                            className="rounded border border-[--border-subtle] bg-white px-1 py-0.5 text-xs"
                          >
                            <option value="general">通用</option>
                            <option value="identity">身份</option>
                            <option value="face">脸部</option>
                            <option value="body">体型</option>
                            <option value="clothing">服装</option>
                            <option value="style">风格</option>
                            <option value="scene">场景</option>
                            <option value="prop">道具</option>
                            <option value="first_frame">首帧</option>
                            <option value="last_frame">尾帧</option>
                          </select>
                          <input
                            type="number"
                            min="0"
                            max="1"
                            step="0.1"
                            value={ref.strength}
                            onChange={(e) => updateReferenceStrength(ref.id, parseFloat(e.target.value))}
                            className="w-12 rounded border border-[--border-subtle] bg-white px-1 py-0.5 text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => removeReference(ref.id)}
                            className="rounded p-0.5 text-red-500 hover:bg-red-50"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleGenerateImage}
                disabled={isGenerating}
                className="flex-1"
                size="sm"
              >
                {isGenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {isGenerating ? t("common.generating") : t("character.generateImage")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 px-2.5"
                title={t("character.uploadImage")}
                disabled={uploading}
                onClick={() => uploadInputRef.current?.click()}
              >
                {uploading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 px-2.5"
                title="Copy image prompt"
                onClick={async () => {
                  const prompt = buildCharacterTurnaroundPrompt(editDesc || editName, editName);
                  await navigator.clipboard.writeText(prompt);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 px-2.5"
                title="升级为视觉主体"
                disabled={promotingToSubject}
                onClick={handlePromoteToVisualSubject}
              >
                {promotingToSubject ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Users className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </div>
      </div>

      {referenceImage && (
        <Dialog open={lightbox} onOpenChange={setLightbox}>
          <DialogContent className="!max-w-[90vw] !w-[90vw] border-0 bg-transparent p-0 shadow-none" showCloseButton={false}>
            <DialogTitle className="sr-only">{name}</DialogTitle>
            <div className="relative inline-block w-full">
              <img
                src={uploadUrl(referenceImage)}
                alt={name}
                className="w-full max-h-[85vh] object-contain rounded-xl"
              />
              <button
                onClick={() => setLightbox(false)}
                className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
              >
                <span className="text-sm leading-none">✕</span>
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Hidden file input for image upload */}
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleUploadImage}
      />
    </div>
  );
}
