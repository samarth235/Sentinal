import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import { Background, MarkerType, Position, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { decisionsOf, segmentSource } from "../lib/derive";
import { formatArg } from "../lib/mask";
import type { RunState } from "../lib/store";
import type { Decision } from "../lib/types";
import { Workflow } from "lucide-react";
import { EmptyState, Legend } from "./ui";
import { OUTCOME_LABEL, TONE_COLOR, VERDICT_STYLE, verdictKey } from "./verdict";

const COL = { source: 0, agent: 190, tool: 340, sentinel: 530, outcome: 700 };
const ROW = 84;

const LINE = "var(--slate-7)";
const EDGE = "var(--slate-8)";
const DENY = "var(--red-9)";

const box = (border: string, bg = "var(--surface)", extra: React.CSSProperties = {}): React.CSSProperties => ({
  background: bg,
  border: `1px solid ${border}`,
  borderRadius: 6,
  color: "var(--slate-12)",
  fontSize: 12,
  width: 160,
  padding: "6px 9px",
  ...extra,
});

function Label({ title, sub, color }: { title: string; sub?: string; color?: string }) {
  return (
    <div style={{ textAlign: "left" }}>
      <div style={{ fontWeight: 600, fontSize: 12.5, color }}>{title}</div>
      {sub && <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--slate-11)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>}
    </div>
  );
}

function outcomeNode(d: Decision | undefined, pending: boolean): { title: string; color: string } {
  if (!d) return { title: "…", color: LINE };
  if (pending && !d.outcome) return { title: "Awaiting approval", color: TONE_COLOR.warn };
  if (!d.outcome) return { title: d.verdict === "REQUIRE_APPROVAL" ? "Awaiting approval" : "…", color: TONE_COLOR.warn };
  const o = OUTCOME_LABEL[d.outcome];
  return { title: o.label, color: TONE_COLOR[o.tone] };
}

export function DecisionGraph({ run, selectedId, onSelect, dark }: { run?: RunState; selectedId?: string; onSelect: (id: string) => void; dark: boolean }) {
  const { nodes, edges } = useMemo(() => build(run, selectedId), [run, selectedId]);

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Decision graph</span>
        <span className="flex gap-3 text-xs text-fg-subtle">
          <Legend color="bg-allow-solid" label="Allow" />
          <Legend color="bg-deny-solid" label="Deny" />
          <Legend color="bg-warn-solid" label="Approval" />
          <Legend color="bg-fg-subtle" label="Unchecked" />
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
            colorMode={dark ? "dark" : "light"}
            minZoom={0.3}
          >
            <Background color="var(--slate-6)" gap={20} size={1} />
          </ReactFlow>
        ) : (
          <EmptyState Icon={Workflow} title="Nothing to graph yet" hint="The agent's tool calls will appear here." />
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
  nodes.push({ id: "user", position: { x: COL.source, y: 0 }, data: { label: <Label title="User prompt" sub={user?.text} /> }, style: box(LINE), ...side });
  nodes.push({
    id: "agent",
    position: { x: COL.agent, y: midY },
    data: { label: <Label title="Agent" sub={run.mode === "live" ? "Claude (live)" : "scripted replay"} /> },
    style: box(LINE, undefined, { width: 120 }),
    ...side,
  });
  edges.push({ id: "user-agent", source: "user", target: "agent", style: { stroke: EDGE } });

  // Untrusted content the agent read, stacked under the user prompt.
  const untrusted = run.segments.filter((s) => s.trust === "UNTRUSTED");
  untrusted.forEach((seg, j) => {
    nodes.push({
      id: seg.segment_id,
      position: { x: COL.source, y: ROW * (j + 1) + 10 },
      data: { label: <Label title="Untrusted content" sub={segmentSource(run, seg)} color="var(--red-11)" /> },
      style: box(DENY, "var(--red-2)"),
      ...side,
    });
    edges.push({ id: `${seg.segment_id}-agent`, source: seg.segment_id, target: "agent", style: { stroke: DENY, strokeDasharray: "4 4" } });
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
      style: box(selected ? "var(--slate-11)" : LINE),
      ...side,
    });
    nodes.push({
      id: decId,
      position: { x: COL.sentinel, y },
      data: {
        label: <Label title={vs ? vs.label : "Evaluating…"} sub={d ? (d.rule_id === "SHIELD_OFF" ? "shield off" : `Sentinel · ${d.rule_id}`) : "Sentinel"} color={vs?.color} />,
        decisionId: d?.decision_id,
      },
      style: box(vs?.color ?? LINE, vs?.tint, { width: 140, boxShadow: selected ? `0 0 0 2px ${vs?.color ?? LINE}` : undefined }),
      ...side,
    });
    const out = outcomeNode(d, run.pending[d?.decision_id ?? ""] !== undefined);
    nodes.push({
      id: outId,
      position: { x: COL.outcome, y },
      data: { label: <Label title={out.title} color={out.color} />, decisionId: d?.decision_id },
      style: box(out.color, undefined, { width: 150 }),
      ...side,
    });

    const tainted = d?.session_tainted;
    edges.push({
      id: `agent-${toolId}`,
      source: "agent",
      target: toolId,
      style: { stroke: tainted ? DENY : EDGE, strokeWidth: tainted ? 1.5 : 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color: tainted ? DENY : EDGE },
    });
    edges.push({ id: `${toolId}-${decId}`, source: toolId, target: decId, style: { stroke: EDGE } });
    edges.push({
      id: `${decId}-${outId}`,
      source: decId,
      target: outId,
      style: { stroke: vs?.color ?? EDGE },
      markerEnd: { type: MarkerType.ArrowClosed, color: vs?.color ?? EDGE },
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
        style: { stroke: DENY, strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: DENY },
      });
    });
  });

  return { nodes, edges };
}
