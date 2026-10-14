import { useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Empty, Icon, Spinner, channelPageUrl, slackChannelUrl, fmtDate } from "./ui";

const parseList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return raw.split(",").filter(Boolean);
  }
};
const accessLabel = (raw: unknown): string => {
  const p = parseList(raw);
  if (p.length === 0) return "poster + managers";
  return p.includes("poster") ? "poster + managers + list" : `${p.length} approver${p.length === 1 ? "" : "s"}`;
};
const highlightJson = (json: string): string =>
  json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (m) => {
        if (/^"/.test(m))
          return /:$/.test(m)
            ? `<span class="json-key">${m}</span>`
            : `<span class="json-string">${m}</span>`;
        if (/true|false/.test(m)) return `<span class="json-bool">${m}</span>`;
        return `<span class="json-number">${m}</span>`;
      },
    );

interface GraphNode {
  id: string;
  type: string;
  label: string;
  data: Record<string, any>;
}
interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  animated: boolean;
}

function ChannelNode({ data }: { data: any }) {
  let schema: any = null;
  try {
    schema = data.metadataSchema ? JSON.parse(data.metadataSchema) : null;
  } catch {}
  const tags = [
    data.linkMode && "link mode",
    data.trackReplies && "replies",
    data.triggerMode === "shortcut" && "shortcut",
    data.metadataRequired && "metadata required",
  ].filter(Boolean) as string[];
  return (
    <div className="node node-channel">
      <Handle type="source" position={Position.Right} />
      <div className="node-head">
        <span className="node-icon">#</span>
        <div className="node-title">
          <strong>{data.name || data.channelId}</strong>
          <span>{data.channelId}</span>
        </div>
        <a
          className="node-open nodrag"
          href={slackChannelUrl(data.channelId)}
          target="_blank"
          rel="noopener"
          title="Open in Slack"
        >
          <Icon name="external" size={14} />
        </a>
      </div>
      <div className="node-body">
        <div className="node-row">
          <span>status</span>
          <span>{data.enabled ? "pub'd" : "off"}</span>
        </div>
        <div className="node-row">
          <span>approvals</span>
          <span>{accessLabel(data.approvedPosters)}</span>
        </div>
        {data.createdAt && (
          <div className="node-row">
            <span>created</span>
            <span>{fmtDate(data.createdAt)}</span>
          </div>
        )}
      </div>
      {tags.length > 0 && (
        <div className="node-tags">
          {tags.map((t) => (
            <span key={t} className="node-tag">
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="node-foot">
        {schema ? (
          <details className="node-details nodrag">
            <summary>metadata schema</summary>
            <pre
              className="node-code nowheel"
              dangerouslySetInnerHTML={{
                __html: highlightJson(JSON.stringify(schema, null, 2)),
              }}
            />
          </details>
        ) : (
          <span className="muted">no schema</span>
        )}
        <a className="nodrag" href={channelPageUrl(data.channelId)}>
          manage →
        </a>
      </div>
    </div>
  );
}

const feedMeta: Record<string, { label: string; glyph: string }> = {
  rss: { label: "RSS", glyph: "◉" },
  api: { label: "API", glyph: "{}" },
  webhook: { label: "Webhook", glyph: "↯" },
};

function FeedNode({ data }: { data: any }) {
  const meta = feedMeta[data.feedType] || { label: "feed", glyph: "•" };
  const channelId = data.channelId;
  const href =
    data.feedType === "rss"
      ? `/feed/${encodeURIComponent(channelId)}`
      : data.feedType === "api"
        ? `/api/messages?channel=${encodeURIComponent(channelId)}`
        : data.url || null;
  return (
    <div className="node node-feed">
      <Handle type="target" position={Position.Left} />
      <span className="node-icon">{meta.glyph}</span>
      <span className="node-feed-label">{meta.label}</span>
      {href && (
        <a
          className="node-open nodrag"
          href={href}
          target={href.startsWith("http") ? "_blank" : undefined}
          rel={href.startsWith("http") ? "noopener" : undefined}
          title={href}
        >
          <Icon name="arrowRight" size={13} />
        </a>
      )}
    </div>
  );
}

function SubscriptionNode() {
  return (
    <div className="node node-subscription">
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <Icon name="radio" size={13} /> pub → sub
    </div>
  );
}

function SubscriberNode({ data }: { data: any }) {
  return (
    <div className="node node-subscriber">
      <Handle type="target" position={Position.Left} />
      <div className="node-head">
        <span className="node-icon">#</span>
        <div className="node-title">
          <strong>{data.name || data.channelId}</strong>
          <span>subscriber · {data.channelId}</span>
        </div>
        <a
          className="node-open nodrag"
          href={slackChannelUrl(data.channelId)}
          target="_blank"
          rel="noopener"
          title="Open in Slack"
        >
          <Icon name="external" size={14} />
        </a>
      </div>
      <div className="node-foot">
        <span className="muted">
          {data.createdAt ? `since ${fmtDate(data.createdAt)}` : "subscriber"}
        </span>
        <a className="nodrag" href={channelPageUrl(data.channelId)}>
          manage →
        </a>
      </div>
    </div>
  );
}

/** Bezier edge stroked with a gradient running from source to target. */
function GradientEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.35,
  });
  const gid = `edge-grad-${id.replace(/[^\w-]/g, "_")}`;
  return (
    <>
      <defs>
        <linearGradient
          id={gid}
          gradientUnits="userSpaceOnUse"
          x1={sourceX}
          y1={sourceY}
          x2={targetX}
          y2={targetY}
        >
          <stop offset="0%" style={{ stopColor: "var(--edge)", stopOpacity: 0.85 }} />
          <stop offset="100%" style={{ stopColor: "var(--edge)", stopOpacity: 0.12 }} />
        </linearGradient>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke: `url(#${gid})`, strokeWidth: 1.75, strokeLinecap: "round" }}
      />
      <path
        d={path}
        fill="none"
        style={{ stroke: "var(--edge)" }}
        strokeOpacity={0.55}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeDasharray="2 14"
        className="edge-flow"
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = {
  channel: ChannelNode,
  feed: FeedNode,
  subscription: SubscriptionNode,
  subscriber: SubscriberNode,
};
const edgeTypes = { gradient: GradientEdge };

function layoutGraph(rawNodes: GraphNode[], rawEdges: GraphEdge[]): { nodes: Node[]; edges: Edge[] } {
  const channels = rawNodes.filter((n) => n.type === "channel");
  const feeds = rawNodes.filter((n) => n.type === "feed");
  const subscribers = rawNodes.filter((n) => n.type === "subscriber");
  const subEdges = rawEdges.filter((e) => e.label === "[sub]");

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const colX = [40, 400, 720];
  const rowH = 40;
  const gap = 18;
  const channelH = 200;

  // Place subscribers next to the first channel that feeds them.
  const subscriberY = new Map<string, number>();

  let cy = 40;
  channels.forEach((ch) => {
    const chFeeds = feeds.filter((f) => f.data.channelId === ch.data.channelId);
    const chSubs = subEdges.filter((e) => e.source === ch.id);
    nodes.push({ id: ch.id, type: "channel", position: { x: colX[0]!, y: cy }, data: ch.data });
    let ry = cy;
    chFeeds.forEach((f) => {
      nodes.push({ id: f.id, type: "feed", position: { x: colX[1]!, y: ry }, data: f.data });
      edges.push({ id: `e-${ch.id}-${f.id}`, source: ch.id, target: f.id, type: "gradient" });
      ry += rowH + gap;
    });
    chSubs.forEach((edge) => {
      const subNodeId = `subnode:${edge.source}:${edge.target}`;
      nodes.push({ id: subNodeId, type: "subscription", position: { x: colX[1]!, y: ry + 3 }, data: {} });
      edges.push({ id: `e-ch-${edge.source}-${edge.target}`, source: ch.id, target: subNodeId, type: "gradient" });
      edges.push({ id: `e-pub-${edge.source}-${edge.target}`, source: subNodeId, target: edge.target, type: "gradient" });
      if (!subscriberY.has(edge.target)) subscriberY.set(edge.target, ry - 30);
      ry += rowH + gap;
    });
    cy = Math.max(cy + channelH, ry) + 48;
  });

  let lastY = -Infinity;
  subscribers
    .map((s) => ({ s, y: subscriberY.get(s.id) ?? 40 }))
    .sort((a, b) => a.y - b.y)
    .forEach(({ s, y }) => {
      const placed = Math.max(y, lastY + 130);
      lastY = placed;
      nodes.push({ id: s.id, type: "subscriber", position: { x: colX[2]! + 40, y: placed }, data: s.data });
    });

  return { nodes, edges };
}

export function useGraph() {
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/graph")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((res: any) => setGraph({ nodes: res.data?.nodes || [], edges: res.data?.edges || [] }))
      .catch((err) => setError(err.message));
  }, []);
  return { graph, error };
}

export function FeedMap({ full, interactive = true }: { full?: boolean; interactive?: boolean }) {
  const { graph, error } = useGraph();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    if (!graph) return;
    const laid = layoutGraph(graph.nodes, graph.edges);
    setNodes(laid.nodes);
    setEdges(laid.edges);
  }, [graph, setNodes, setEdges]);

  // Fit the first few channels rather than the whole (tall) graph, so the
  // map opens at a readable zoom; pan or zoom out for the rest.
  const fitNodes = nodes.filter((n) => n.position.y < 720).map((n) => ({ id: n.id }));
  const cls = "map-shell" + (full ? " full" : "");
  if (error)
    return (
      <div className={cls}>
        <Empty icon="alert" title="Couldn't load the feed map">
          {error}
        </Empty>
      </div>
    );
  if (!graph)
    return (
      <div className={cls} style={{ display: "grid", placeItems: "center" }}>
        <Spinner />
      </div>
    );
  if (graph.nodes.length === 0)
    return (
      <div className={cls} style={{ display: "grid", placeItems: "center" }}>
        <Empty
          icon="map"
          title="Nothing pub'd yet"
          action={
            <a className="btn btn-primary" href="/channels.html?new=1">
              <Icon name="plus" /> Pub a channel
            </a>
          }
        >
          Pub a channel from the dashboard or run <code>/in pub</code> in Slack.
        </Empty>
      </div>
    );

  return (
    <div className={cls}>
      <div className="map-overlay">
        <div className="map-legend">
          <span>
            <i className="legend-swatch" /> channel
          </span>
          <span>
            <i className="legend-swatch pill" /> feed
          </span>
          <span>
            <i className="legend-swatch pill dashed" /> subscription
          </span>
        </div>
        {!full && (
          <a className="btn btn-sm" href="/map.html">
            <Icon name="map" size={14} /> Full screen
          </a>
        )}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1, nodes: fitNodes }}
        minZoom={0.2}
        zoomOnScroll={interactive}
        preventScrolling={interactive}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} color="var(--map-dot)" gap={22} size={1.2} />
        <Controls showInteractive={false} position="bottom-left" />
        {full && (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            maskColor="var(--minimap-mask)"
            nodeColor="var(--surface-3)"
            nodeStrokeColor="var(--border-strong)"
            nodeBorderRadius={8}
          />
        )}
      </ReactFlow>
    </div>
  );
}
