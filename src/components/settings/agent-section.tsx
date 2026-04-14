"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-fetch";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, Eye, EyeOff, Bot, Save } from "lucide-react";

interface Agent {
  id: string;
  name: string;
  category: string;
  appId: string;
  apiKey: string;
  description: string;
}

const CATEGORIES = [
  { value: "script_outline", labelKey: "scriptOutline" },
  { value: "script_parse", labelKey: "scriptParse" },
  { value: "character_extract", labelKey: "characterExtract" },
  { value: "shot_split", labelKey: "shotSplit" },
] as const;

export function AgentSection() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

  // Form state
  const [form, setForm] = useState({
    name: "",
    category: CATEGORIES[0].value as string,
    appId: "",
    apiKey: "",
    description: "",
  });

  const fetchAgents = useCallback(async () => {
    try {
      const res = await apiFetch("/api/agents");
      const data = await res.json();
      setAgents(data);
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.appId || !form.apiKey) return;
    setSaving(true);
    try {
      await apiFetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm({
        name: "",
        category: CATEGORIES[0].value,
        appId: "",
        apiKey: "",
        description: "",
      });
      setShowForm(false);
      await fetchAgents();
    } catch {
      // silently fail
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await apiFetch(`/api/agents/${id}`, { method: "DELETE" });
      setAgents((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // silently fail
    }
  }

  function toggleKeyVisibility(id: string) {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function categoryLabel(value: string) {
    const cat = CATEGORIES.find((c) => c.value === value);
    if (!cat) return value;
    return t(`agentCategory_${cat.labelKey}`);
  }

  return (
    <div className="rounded-2xl border border-[--border-subtle] bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-[--text-muted]">
          <Bot className="h-3.5 w-3.5" />
          {t("agents")}
        </h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowForm(!showForm)}
          className="h-7 gap-1 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("addAgent")}
        </Button>
      </div>

      {/* Add Agent Form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="mb-4 space-y-3 rounded-xl border border-[--border-subtle] bg-[--surface] p-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("agentName")}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t("agentNamePlaceholder")}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("agentCategory")}</Label>
              <select
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {t(`agentCategory_${c.labelKey}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("agentAppId")}</Label>
              <Input
                value={form.appId}
                onChange={(e) => setForm((f) => ({ ...f, appId: e.target.value }))}
                placeholder="app-xxxxxxxxxxxx"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">API Key</Label>
              <Input
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder="sk-xxxxxxxxxxxx"
                required
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("agentDescription")}</Label>
            <Input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder={t("agentDescriptionPlaceholder")}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowForm(false)}
              className="h-7 text-xs"
            >
              {tc("cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={saving || !form.name || !form.appId || !form.apiKey}
              className="h-7 gap-1 text-xs"
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? "..." : tc("save")}
            </Button>
          </div>
        </form>
      )}

      {/* Agent List */}
      {agents.length === 0 ? (
        <p className="py-6 text-center text-xs text-[--text-muted]">
          {t("noAgents")}
        </p>
      ) : (
        <div className="space-y-2">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between rounded-xl border border-[--border-subtle] bg-[--surface] px-4 py-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[--text-primary] truncate">
                      {agent.name}
                    </span>
                    <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                      {categoryLabel(agent.category)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[--text-muted]">
                    <span className="truncate max-w-[160px]">
                      {agent.appId.length > 20
                        ? agent.appId.slice(0, 10) + "..." + agent.appId.slice(-6)
                        : agent.appId}
                    </span>
                    {agent.apiKey && (
                      <button
                        type="button"
                        onClick={() => toggleKeyVisibility(agent.id)}
                        className="inline-flex items-center gap-1 text-[--text-muted] hover:text-[--text-primary] transition-colors"
                      >
                        {visibleKeys.has(agent.id) ? (
                          <>
                            <EyeOff className="h-3 w-3" />
                            <span className="font-mono">
                              {agent.apiKey.slice(0, 8)}...{agent.apiKey.slice(-4)}
                            </span>
                          </>
                        ) : (
                          <>
                            <Eye className="h-3 w-3" />
                            <span>••••••••</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(agent.id)}
                className="ml-2 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-[--text-muted] transition-colors hover:bg-red-50 hover:text-red-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
