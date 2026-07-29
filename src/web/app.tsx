import { createRoot } from "react-dom/client";
import { useState, useEffect, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const TEAM_ID = "T024F7C8B";
const slackLink = (channelId: string) =>
  `https://hackclub.enterprise.slack.com/archives/${channelId}`;
const parseApprovedPosters = (raw: string): string[] => {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
};
const accessLabel = (raw: string): string => {
  const p = parseApprovedPosters(raw);
  if (p.length === 0) return "poster + managers";
  return p.includes("poster") ? "poster + managers + op" : p.join(", ");
};
const fmtDate = (s: string) => {
  try { return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
  catch { return s; }
};
const highlightJson = (json: string): string =>
  json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      if (/^"/.test(m)) return /:$/.test(m)
        ? `<span class="json-key">${m}</span>`
        : `<span class="json-string">${m}</span>`;
      if (/true|false/.test(m)) return `<span class="json-bool">${m}</span>`;
      return `<span class="json-number">${m}</span>`;
    }
  );

document.getElementById("navbar")!.innerHTML = `<nav class="navbar">
  <a href="/" class="navbar-brand">indigest</a>
  <div class="navbar-links">
    <a href="/" class="active">feed map</a>
      <a href="/usage.html">usage</a>
    <a href="/docs.html">api docs</a>

  </div>
</nav>`;

interface GraphNode { id: string; type: string; label: string; data: Record<string, any>; }
interface GraphEdge { id: string; source: string; target: string; label?: string; animated: boolean; }

function ChannelNode({ data }: { data: any }) {
  const posters = parseApprovedPosters(data.approvedPosters || "");
  let schema: any = null;
  try { schema = data.metadataSchema ? JSON.parse(data.metadataSchema) : null; } catch {}
  return (
    <div class="node-channel">
      <Handle type="source" position={Position.Right} />
      <div class="node-header">
        <span class="node-name">{data.name ? `#${data.name}` : data.channelId}</span>
        <a class="node-link" href={slackLink(data.channelId)} target="_blank" rel="noopener">open ↗</a>
      </div>
      <div class="node-body">
        <div class="node-detail">enabled: {data.enabled ? "yes" : "no"}</div>
        <div class="node-detail">access: {accessLabel(data.approvedPosters)}</div>
        {posters.length > 0 && <div class="node-detail">approved: {posters.join(", ")}</div>}
        {data.createdAt && <div class="node-detail">created: {fmtDate(data.createdAt)}</div>}
        {schema && (
          <details class="node-details">
            <summary>metadata schema</summary>
            <pre class="node-code" dangerouslySetInnerHTML={{ __html: highlightJson(JSON.stringify(schema, null, 2)) }} />
          </details>
        )}
      </div>
    </div>
  );
}

function FeedNode({ data }: { data: any }) {
  const labels: Record<string, string> = { rss: "rss", api: "api", webhook: "webhook" };
  return (
    <div class="node-feed">
      <Handle type="target" position={Position.Left} />
      [{labels[data.feedType] || "feed"}]
    </div>
  );
}

function SubscriptionNode() {
  return (
    <div class="node-subscription">
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      [pub]
    </div>
  );
}

function SubscriberNode({ data }: { data: any }) {
  return (
    <div class="node-subscriber">
      <Handle type="target" position={Position.Left} />
      <div class="node-header">
        <span class="node-name">{data.name ? `#${data.name}` : data.channelId}</span>
        <a class="node-link" href={slackLink(data.channelId)} target="_blank" rel="noopener">open ↗</a>
      </div>
      <div class="node-body">
        <div class="node-detail">access: {accessLabel(data.approvedPosters)}</div>
        {data.createdAt && <div class="node-detail">created: {fmtDate(data.createdAt)}</div>}
      </div>
    </div>
  );
}

const nodeTypes = {
  channel: ChannelNode,
  feed: FeedNode,
  subscription: SubscriptionNode,
  subscriber: SubscriberNode,
};

function layoutGraph(rawNodes: GraphNode[], rawEdges: GraphEdge[]): { nodes: Node[]; edges: Edge[] } {
  const channels = rawNodes.filter((n) => n.type === "channel");
  const feeds = rawNodes.filter((n) => n.type === "feed");
  const subscribers = rawNodes.filter((n) => n.type === "subscriber");
  const subEdges = rawEdges.filter((e) => e.label === "[sub]");

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const colX = [40, 300, 740];
  const rowH = 28;
  const gap = 12;
  const chSubGap = 100;

  let cy = 30;
  channels.forEach((ch) => {
    const chFeeds = feeds.filter((f) => f.data.channelId === ch.data.channelId);
    const chSubs = subEdges.filter((e) => e.source === ch.id);
    nodes.push({ id: ch.id, type: "channel", position: { x: colX[0], y: cy }, data: ch.data });
    let ry = cy;
    chFeeds.forEach((f) => {
      nodes.push({ id: f.id, type: "feed", position: { x: colX[1], y: ry }, data: f.data });
      edges.push({ id: `e-${ch.id}-${f.id}`, source: ch.id, target: f.id, type: "default" });
      ry += rowH + gap;
    });
    chSubs.forEach((edge) => {
      const subNodeId = `subnode:${edge.source}:${edge.target}`;
      nodes.push({ id: subNodeId, type: "subscription", position: { x: colX[1], y: ry }, data: {} });
      edges.push({ id: `e-ch-${edge.source}-${edge.target}`, source: ch.id, target: subNodeId, type: "default" });
      edges.push({ id: `e-pub-${edge.source}-${edge.target}`, source: subNodeId, target: edge.target, label: "[sub]", type: "default" });
      ry += rowH + gap;
    });
    cy = Math.max(cy + 56, ry) + gap;
  });

  let sy = 30;
  subscribers.forEach((sub) => {
    nodes.push({ id: sub.id, type: "subscriber", position: { x: colX[2], y: sy }, data: sub.data });
    sy += rowH + chSubGap;
  });

  return { nodes, edges };
}

function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/graph")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((res) => {
        const { nodes: n, edges: e } = layoutGraph(res.data?.nodes || [], res.data?.edges || []);
        setNodes(n);
        setEdges(e);
        setLoading(false);
      })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, [setNodes, setEdges]);

  if (loading) return <div class="diagram-page"><div class="loading">loading...</div></div>;
  if (error) return <div class="diagram-page"><div class="empty-state"><p>{error}</p></div></div>;
  if (nodes.length === 0) return (
    <div class="diagram-page">
      <div class="diagram-header"><h1>feed map</h1></div>
      <div class="empty-state"><p>no published channels. /in pub to start.</p></div>
    </div>
  );

  return (
    <div class="diagram-page">
      <div class="diagram-header">
        <h1>feed map</h1>
        <p>node key: #channel → [rss | api | webhook | pub] (if pub: → [sub] → #channel)</p>
      </div>
      <div class="diagram-container">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          defaultEdgeOptions={{
            animated: true,
            style: { stroke: "#555", strokeWidth: 1.5 },
          }}
        >
          <Background color="#222" gap={20} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
