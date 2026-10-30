import { useMemo } from "react";
import { Background, MarkerType, Position, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { decisionsOf, segmentSource } from "../lib/derive";
import { formatArg } from "../lib/mask";
import type { RunState } from "../lib/store";
import type { Decision } from "../lib/types";
import { OUTCOME_LABEL, VERDICT_STYLE, verdictKey } from "./verdict";

const COL = { source: 0, agent: 190, tool: 340, sentinel: 530, outcome: 700 };
const ROW = 84;

const box = (border: string, bg = "#17171a", extra: React.CSSProperties = {}): React.CSSProperties => ({
  background: bg,
  border: `1.5px solid ${border}`,
  borderRadius: 10,
  color: "#e4e4e7",
  fontSize: 12,
  width: 160,
  padding: "6px 9px",
  ...extra,
});

function Label({ title, sub, color }: { title: string; sub?: string; color?: string }) {
  return (
    <div style={{ textAlign: "left" }}>
      <div style={{ fontWeight: 700, fontSize: 13, color }}>{title}</div>
      {sub && <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 10.5, color: "#a1a1aa", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>}
    </div>
  );
}

function outcomeNode(d: Decision | undefined, pending: boolean): { title: string; color: string } {
  if (!d) return { title: "…", color: "#6b7280" };
  if (pending && !d.outcome) return { title: "Awaiting approval", color: "#f59e0b" };
  if (!d.outcome) return { title: d.verdict === "REQUIRE_APPROVAL" ? "Awaiting approval" : "…", color: "#f59e0b" };
  const o = OUTCOME_LABEL[d.outcome];
  const color = { good: "#22c55e", bad: "#ef4444", warn: "#f59e0b", neutral: "#9ca3af" }[o.tone];
  return { title: o.label, color };
}

export function DecisionGraph({ run, selectedId, onSelect }: { run?: RunState; selectedId?: string; onSelect: (id: string) => void }) {
  const { nodes, edges } = useMemo(() => build(run, selectedId), [run, selectedId]);

  return (
    <section className="panel">
      <div className="panel-title">
        Live decision graph
        <span className="flex gap-3 normal-case tracking-normal">
          <span className="text-allow">■ allow</span>
          <span className="text-deny">■ deny</span>
          <span className="text-approve">■ approval</span>
          <span className="text-zinc-400">■ unchecked</span>
        </span>
      </div>
      <div className="relative flex-1 min-h-0">
        {run ? (
          <ReactFlow
            key={`${run.run_id}:${nodes.length}`}
            nodes={nodes}
            edges={edges}
            fitView
            fitViewOptions={{ padding: 0.06, maxZoom: 1.2 }}
            nodesDraggable={false}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => n.data.decisionId && onSelect(n.data.decisionId as string)}
            colorMode="dark"
            minZoom={0.3}
          >
            <Background color="#26262b" gap={22} />
          </ReactFlow>
        ) : (
          <p className="pt-8 text-center text-sm text-muted">The agent's tool calls will appear here.</p>
        )}
      </div>
    </section>
  );
}

function build(run: RunState | undefined, selectedId?: string): { nodes: Node[]; edges: Edge[] } {
  if (!run) return { nodes: [], edges: [] };
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const decisions = decisionsOf(run);
  const byCall = new Map(decisions.map((d) => [d.call.call_id, d]));
  const calls = run.calls;
  const midY = Math.max(0, ((calls.length - 1) * ROW) / 2);
  const side = { sourcePosition: Position.Right, targetPosition: Position.Left };

  const user = run.segments.find((s) => s.source === "user");
  nodes.push({ id: "user", position: { x: COL.source, y: 0 }, data: { label: <Label title="User prompt" sub={user?.text} /> }, style: box("#52525b"), ...side });
  nodes.push({
    id: "agent",
    position: { x: COL.agent, y: midY },
    data: { label: <Label title="Agent" sub={run.mode === "live" ? "Claude (live)" : "scripted replay"} /> },
    style: box("#52525b", "#17171a", { width: 120 }),
    ...side,
  });
  edges.push({ id: "user-agent", source: "user", target: "agent", style: { stroke: "#71717a" } });

  // Untrusted content the agent read, stacked under the user prompt.
  const untrusted = run.segments.filter((s) => s.trust === "UNTRUSTED");
  untrusted.forEach((seg, j) => {
    nodes.push({
      id: seg.segment_id,
      position: { x: COL.source, y: ROW * (j + 1) + 10 },
      data: { label: <Label title="Untrusted content" sub={segmentSource(run, seg)} color="#fca5a5" /> },
      style: box("#ef4444", "#2a0f12"),
      ...side,
    });
    edges.push({ id: `${seg.segment_id}-agent`, source: seg.segment_id, target: "agent", style: { stroke: "#ef4444", strokeDasharray: "4 4" } });
  });

  calls.forEach((call, i) => {
    const y = i * ROW;
    const d = byCall.get(call.call_id);
    const vk = d ? verdictKey(d) : undefined;
    const vs = vk ? VERDICT_STYLE[vk] : undefined;
    const selected = d?.decision_id === selectedId;
    const firstArg = Object.entries(call.args)[0];
    const toolId = `tool-${call.call_id}`;
    const decId = `dec-${call.call_id}`;
    const outId = `out-${call.call_id}`;

    nodes.push({
      id: toolId,
      position: { x: COL.tool, y },
      data: { label: <Label title={call.tool} sub={firstArg ? `${firstArg[0]}=${formatArg(firstArg[1], 40)}` : ""} />, decisionId: d?.decision_id },
      style: box(selected ? "#e4e4e7" : "#3f3f46"),
      ...side,
    });
    nodes.push({
      id: decId,
      position: { x: COL.sentinel, y },
      data: {
        label: <Label title={vs ? `${vs.icon} ${vs.label}` : "evaluating…"} sub={d ? (d.rule_id === "SHIELD_OFF" ? "shield off" : `Sentinel · ${d.rule_id}`) : "Sentinel"} color={vs?.hex} />,
        decisionId: d?.decision_id,
      },
      style: box(vs?.hex ?? "#3f3f46", vs ? `${vs.hex}1f` : "#17171a", { width: 140, boxShadow: selected ? `0 0 0 2px ${vs?.hex ?? "#fff"}` : undefined }),
      ...side,
    });
    const out = outcomeNode(d, run.pending[d?.decision_id ?? ""] !== undefined);
    nodes.push({
      id: outId,
      position: { x: COL.outcome, y },
      data: { label: <Label title={out.title} color={out.color} />, decisionId: d?.decision_id },
      style: box(out.color, "#17171a", { width: 150 }),
      ...side,
    });

    const tainted = d?.session_tainted;
    edges.push({
      id: `agent-${toolId}`,
      source: "agent",
      target: toolId,
      style: { stroke: tainted ? "#ef4444" : "#71717a", strokeWidth: tainted ? 1.6 : 1.2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: tainted ? "#ef4444" : "#71717a" },
    });
    edges.push({ id: `${toolId}-${decId}`, source: toolId, target: decId, style: { stroke: "#71717a" } });
    edges.push({
      id: `${decId}-${outId}`,
      source: decId,
      target: outId,
      style: { stroke: vs?.hex ?? "#71717a" },
      markerEnd: { type: MarkerType.ArrowClosed, color: vs?.hex ?? "#71717a" },
    });

    // The money edge: untrusted text that supplied a high-impact argument.
    const hijacked = new Set(
      (d?.provenance ?? []).filter((p) => p.class === "UNTRUSTED_SOURCED").flatMap((p) => p.evidence.map((e) => e.segment_id)),
    );
    hijacked.forEach((segId) => {
      if (!untrusted.some((s) => s.segment_id === segId)) return;
      edges.push({
        id: `hijack-${segId}-${toolId}`,
        source: segId,
        target: toolId,
        animated: true,
        style: { stroke: "#ef4444", strokeWidth: 2.2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#ef4444" },
      });
    });
  });

  return { nodes, edges };
}
