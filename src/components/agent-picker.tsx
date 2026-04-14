"use client";

import { useEffect } from "react";
import { useAgentStore } from "@/stores/agent-store";
import { useTranslations } from "next-intl";
import { Bot } from "lucide-react";

interface AgentPickerProps {
  projectId: string;
  category: string;
}

export function AgentPicker({ projectId, category }: AgentPickerProps) {
  const t = useTranslations("settings");
  const { agents, bindings, fetchAgents, fetchBindings, setBinding } = useAgentStore();

  useEffect(() => {
    fetchAgents();
    fetchBindings(projectId);
  }, [projectId, fetchAgents, fetchBindings]);

  const availableAgents = agents.filter((a) => a.category === category);
  const currentBinding = bindings.find((b) => b.category === category);

  if (availableAgents.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5">
      <Bot className="h-3 w-3 text-[--text-muted]" />
      <select
        value={currentBinding?.agentId ?? ""}
        onChange={(e) => setBinding(projectId, category, e.target.value || null)}
        className="h-6 rounded border border-[--border-subtle] bg-white px-1.5 text-[11px] text-[--text-muted]"
      >
        <option value="">{t("defaultAgent")}</option>
        {availableAgents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </div>
  );
}
