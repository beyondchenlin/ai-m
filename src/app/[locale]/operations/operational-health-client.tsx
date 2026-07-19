"use client";

import { AlertTriangle, Activity, CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";

type Alert = {
  alertKey: string;
  severity: "warning" | "critical";
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  summarySafe: string;
  lastSeenAtMs: number;
};

type Metrics = {
  submissionUnknownCount: number;
  retainedSlotCount: number;
  expiredSlotCount: number;
  leaseLossCount24h: number;
  environmentDriftCount24h: number;
  diskUsageRatio: number | null;
};

const REASONS = [
  ["investigating", "正在调查"],
  ["mitigation_in_progress", "缓解措施进行中"],
  ["accepted_temporary_risk", "临时接受风险"],
  ["escalated", "已升级处理"],
] as const;

export function OperationalHealthClient() {
  const [token, setToken] = useState("");
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token.trim()) {
      setError("请输入管理员令牌；令牌仅保存在当前页面内存。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/operations/health", {
        cache: "no-store",
        headers: { authorization: `Bearer ${token.trim()}` },
      });
      const payload = await response.json() as { alerts?: Alert[]; metrics?: Metrics; error?: string };
      if (!response.ok) throw new Error(payload.error || "无法读取运行健康状态");
      setAlerts(payload.alerts ?? []);
      setMetrics(payload.metrics ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取运行健康状态");
    } finally {
      setLoading(false);
    }
  }, [token]);

  async function acknowledge(alert: Alert) {
    const evidenceRefs = (evidence[alert.alertKey] ?? "").split(/[\n,]/)
      .map((value) => value.trim()).filter(Boolean);
    setSaving(alert.alertKey);
    setError("");
    try {
      const response = await fetch("/api/admin/operations/health", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          alertKey: alert.alertKey,
          reasonCode: reason[alert.alertKey] ?? REASONS[0][0],
          evidenceRefs,
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "告警登记失败");
      setEvidence((current) => ({ ...current, [alert.alertKey]: "" }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "告警登记失败");
    } finally {
      setSaving(null);
    }
  }

  const active = alerts.filter((alert) => alert.status !== "RESOLVED");
  return (
    <section className="border border-[#17201e]/20 bg-[#17201e] p-5 text-white shadow-[4px_4px_0_#d8d4c8]">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#ffbf3f]">
            Unified operational health
          </p>
          <h2 className="mt-1 flex items-center gap-2 text-lg font-semibold">
            <Activity className="h-5 w-5" />运行指标与主动告警
          </h2>
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void load(); }}
            autoComplete="off"
            placeholder="AI_M_ADMIN_TOKEN"
            className="h-10 w-56 border border-white/20 bg-white/10 px-3 font-mono text-xs text-white outline-none placeholder:text-white/35 focus:border-[#ffbf3f]"
          />
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="flex h-10 items-center gap-2 bg-[#ffbf3f] px-4 text-xs font-semibold text-[#17201e] disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />刷新
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="mt-4 flex gap-2 border-l-4 border-[#c84b31] bg-[#fff0eb] px-3 py-2 text-sm text-[#7d2818]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}
        </div>
      )}

      {metrics && (
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {[
            ["提交未知", metrics.submissionUnknownCount],
            ["占用槽位", metrics.retainedSlotCount],
            ["过期槽位", metrics.expiredSlotCount],
            ["租约异常/24h", metrics.leaseLossCount24h],
            ["环境漂移/24h", metrics.environmentDriftCount24h],
            ["磁盘", metrics.diskUsageRatio == null ? "N/A" : `${Math.round(metrics.diskUsageRatio * 100)}%`],
          ].map(([label, value]) => (
            <div key={label} className="border-t border-white/20 bg-white/5 px-3 py-3">
              <div className="font-mono text-lg font-semibold">{value}</div>
              <div className="mt-1 text-[10px] text-white/55">{label}</div>
            </div>
          ))}
        </div>
      )}

      {metrics && active.length === 0 && (
        <div className="mt-4 flex items-center gap-2 border border-white/15 bg-white/5 px-4 py-3 text-sm text-white/70">
          <CheckCircle2 className="h-4 w-4 text-[#76d5a6]" />当前没有活动告警。
        </div>
      )}

      <div className="mt-4 grid gap-3">
        {active.map((alert) => (
          <article
            key={alert.alertKey}
            className={`border-l-4 bg-white p-4 text-[#17201e] ${
              alert.severity === "critical" ? "border-[#c84b31]" : "border-[#ffbf3f]"
            }`}
          >
            <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-wider">
                  {alert.severity} · {alert.status}
                </p>
                <h3 className="mt-1 font-semibold">{alert.summarySafe}</h3>
                <p className="mt-1 font-mono text-[11px] text-[#65716e]">
                  {alert.alertKey} · {new Date(alert.lastSeenAtMs).toLocaleString()}
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <select
                  value={reason[alert.alertKey] ?? REASONS[0][0]}
                  onChange={(event) => setReason((current) => ({
                    ...current, [alert.alertKey]: event.target.value,
                  }))}
                  className="h-9 border border-[#17201e]/25 bg-white px-2 text-xs"
                >
                  {REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <input
                  value={evidence[alert.alertKey] ?? ""}
                  onChange={(event) => setEvidence((current) => ({
                    ...current, [alert.alertKey]: event.target.value,
                  }))}
                  placeholder="ticket:OPS-68"
                  className="h-9 border border-[#17201e]/25 px-2 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => void acknowledge(alert)}
                  disabled={saving === alert.alertKey}
                  className="flex h-9 items-center gap-2 bg-[#17201e] px-3 text-xs font-semibold text-white disabled:opacity-50"
                >
                  <ShieldCheck className="h-4 w-4" />登记
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
