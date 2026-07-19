"use client";

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Database,
  Fingerprint,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

type AttentionCase = {
  jobId: string;
  projectId: string | null;
  capability: string;
  jobStatus: string;
  needsAttentionReason: string | null;
  attemptId: string | null;
  attemptPhase: string | null;
  externalJobId: string | null;
  backendId: string | null;
  errorClass: string | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  committedArtifactCount: number;
  reconciliationProofCount: number;
  activeSlotCount: number;
  updatedAtMs: number;
  lastAcknowledgedAtMs: number | null;
  lastAcknowledgedBy: string | null;
};

const REASONS = [
  ["investigating_external_state", "正在核对外部执行状态"],
  ["awaiting_backend_evidence", "等待后端历史证据"],
  ["awaiting_storage_evidence", "等待存储或工件证据"],
  ["escalated_to_platform_owner", "已升级至平台负责人"],
] as const;

function short(value: string | null): string {
  if (!value) return "—";
  return value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-7)}` : value;
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString() : "尚未登记";
}

export function OperationsAttentionClient() {
  const [token, setToken] = useState("");
  const [cases, setCases] = useState<AttentionCase[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [evidenceByJob, setEvidenceByJob] = useState<Record<string, string>>({});
  const [reasonByJob, setReasonByJob] = useState<Record<string, string>>({});
  const [savingJob, setSavingJob] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token.trim()) {
      setError("请输入管理员令牌。令牌只保存在当前页面内存。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/operations/attention", {
        cache: "no-store",
        headers: { authorization: `Bearer ${token.trim()}` },
      });
      const payload = await response.json() as { cases?: AttentionCase[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "无法读取运维队列");
      setCases(payload.cases ?? []);
      setAuthenticated(true);
    } catch (cause) {
      setAuthenticated(false);
      setError(cause instanceof Error ? cause.message : "无法读取运维队列");
    } finally {
      setLoading(false);
    }
  }, [token]);

  const summary = useMemo(() => ({
    unacknowledged: cases.filter((item) => !item.lastAcknowledgedAtMs).length,
    submissionUnknown: cases.filter((item) => item.attemptPhase === "SUBMISSION_UNKNOWN").length,
    retainedSlots: cases.reduce((sum, item) => sum + item.activeSlotCount, 0),
  }), [cases]);

  async function acknowledge(item: AttentionCase) {
    const evidenceRefs = (evidenceByJob[item.jobId] ?? "")
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    setSavingJob(item.jobId);
    setError("");
    try {
      const response = await fetch("/api/admin/operations/attention", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jobId: item.jobId,
          reasonCode: reasonByJob[item.jobId] ?? REASONS[0][0],
          evidenceRefs,
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "登记失败");
      setEvidenceByJob((current) => ({ ...current, [item.jobId]: "" }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登记失败");
    } finally {
      setSavingJob(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#f2f1ec] text-[#17201e]">
      <header className="border-b border-[#17201e]/15 bg-[#17201e] text-[#f7f3e8]">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8">
          <div className="flex items-center gap-4">
            <Link
              href="/settings"
              aria-label="返回设置"
              className="grid h-9 w-9 place-items-center border border-white/20 transition hover:border-[#ffbf3f] hover:text-[#ffbf3f]"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#ffbf3f]">Operations / Evidence Desk</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight">不确定任务处置台</h1>
            </div>
          </div>
          <div className="hidden items-center gap-2 font-mono text-xs text-white/55 sm:flex">
            <ShieldCheck className="h-4 w-4 text-[#76d5a6]" />
            状态变更默认锁定
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-5 py-6 lg:px-8">
        <div className="grid gap-4 border border-[#17201e]/15 bg-white p-4 shadow-[4px_4px_0_#d8d4c8] md:grid-cols-[1fr_auto]">
          <label className="space-y-2">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#52605d]">
              Admin bearer · 仅内存
            </span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void load(); }}
              autoComplete="off"
              placeholder="输入 AI_M_ADMIN_TOKEN"
              className="h-11 w-full border border-[#17201e]/25 bg-[#f8f7f2] px-3 font-mono text-sm outline-none transition focus:border-[#17201e] focus:ring-2 focus:ring-[#ffbf3f]/60"
            />
          </label>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="mt-auto flex h-11 items-center justify-center gap-2 bg-[#17201e] px-5 text-sm font-semibold text-white transition hover:bg-[#263532] disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {authenticated ? "刷新证据" : "进入队列"}
          </button>
        </div>

        {error && (
          <div role="alert" className="mt-4 flex items-start gap-3 border-l-4 border-[#c84b31] bg-[#fff0eb] px-4 py-3 text-sm text-[#7d2818]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {authenticated && (
          <>
            <div className="mt-6 grid grid-cols-3 gap-3">
              {[
                { label: "待登记", value: summary.unacknowledged, Icon: Clock3 },
                { label: "提交未知", value: summary.submissionUnknown, Icon: Fingerprint },
                { label: "仍占用槽位", value: summary.retainedSlots, Icon: Database },
              ].map(({ label, value, Icon }) => (
                <div key={label} className="border-t-4 border-[#17201e] bg-white px-4 py-4">
                  <Icon className="mb-3 h-4 w-4 text-[#b36b00]" />
                  <div className="font-mono text-2xl font-semibold">{String(value).padStart(2, "0")}</div>
                  <div className="mt-1 text-xs text-[#65716e]">{label}</div>
                </div>
              ))}
            </div>

            <div className="mt-6 space-y-4">
              {cases.length === 0 && (
                <div className="grid min-h-52 place-items-center border border-dashed border-[#17201e]/25 bg-white/60 text-center">
                  <div>
                    <CheckCircle2 className="mx-auto h-7 w-7 text-[#25835c]" />
                    <p className="mt-3 font-semibold">当前没有不确定任务</p>
                    <p className="mt-1 text-sm text-[#65716e]">NEEDS_ATTENTION 与 SUBMISSION_UNKNOWN 队列为空。</p>
                  </div>
                </div>
              )}
              {cases.map((item) => (
                <article key={item.jobId} className="border border-[#17201e]/20 bg-white">
                  <div className="grid gap-5 p-5 lg:grid-cols-[1.2fr_.8fr]">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="bg-[#17201e] px-2 py-1 font-mono text-[11px] text-white">{item.jobStatus}</span>
                        {item.attemptPhase && <span className="border border-[#b36b00]/40 bg-[#fff4d8] px-2 py-1 font-mono text-[11px] text-[#714500]">{item.attemptPhase}</span>}
                        <span className="font-mono text-xs text-[#65716e]">{item.capability}</span>
                      </div>
                      <h2 className="mt-4 break-all font-mono text-base font-semibold">{item.jobId}</h2>
                      <p className="mt-2 text-sm leading-6 text-[#52605d]">
                        {item.needsAttentionReason || item.errorMessageSafe || "需要人工核对数据库与后端证据。"}
                      </p>
                      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-3">
                        {[
                          ["Project", short(item.projectId)],
                          ["Attempt", short(item.attemptId)],
                          ["External", short(item.externalJobId)],
                          ["Backend", short(item.backendId)],
                          ["Artifacts", item.committedArtifactCount],
                          ["Proofs / Slots", `${item.reconciliationProofCount} / ${item.activeSlotCount}`],
                        ].map(([label, value]) => (
                          <div key={String(label)} className="border-t border-[#17201e]/10 pt-2">
                            <dt className="font-mono uppercase tracking-wider text-[#89918f]">{label}</dt>
                            <dd className="mt-1 font-medium text-[#263532]">{value}</dd>
                          </div>
                        ))}
                      </dl>
                      <p className="mt-4 font-mono text-[11px] text-[#89918f]">
                        最近登记：{formatTime(item.lastAcknowledgedAtMs)}
                        {item.lastAcknowledgedBy ? ` · ${item.lastAcknowledgedBy}` : ""}
                      </p>
                    </div>

                    <div className="border-l-0 border-[#17201e]/15 lg:border-l lg:pl-5">
                      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#52605d]">登记调查，不改变状态</p>
                      <select
                        value={reasonByJob[item.jobId] ?? REASONS[0][0]}
                        onChange={(event) => setReasonByJob((current) => ({ ...current, [item.jobId]: event.target.value }))}
                        className="mt-3 h-10 w-full border border-[#17201e]/25 bg-white px-3 text-sm outline-none focus:border-[#17201e]"
                      >
                        {REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                      <textarea
                        value={evidenceByJob[item.jobId] ?? ""}
                        onChange={(event) => setEvidenceByJob((current) => ({ ...current, [item.jobId]: event.target.value }))}
                        placeholder={"每行一个证据引用\n例如 ticket:OPS-42\nhistory:prompt-7"}
                        rows={4}
                        className="mt-3 w-full resize-none border border-[#17201e]/25 bg-[#f8f7f2] p-3 font-mono text-xs leading-5 outline-none focus:border-[#17201e] focus:ring-2 focus:ring-[#ffbf3f]/50"
                      />
                      <button
                        type="button"
                        onClick={() => void acknowledge(item)}
                        disabled={savingJob === item.jobId}
                        className="mt-3 flex h-10 w-full items-center justify-center gap-2 border border-[#17201e] font-semibold transition hover:bg-[#17201e] hover:text-white disabled:opacity-50"
                      >
                        <ShieldCheck className="h-4 w-4" />
                        {savingJob === item.jobId ? "正在登记…" : "登记证据引用"}
                      </button>
                      <p className="mt-3 text-[11px] leading-5 text-[#7a5045]">
                        此操作只追加审计记录。任务状态、槽位、外部 identity 和工件均保持不变。
                      </p>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
