export const LOGIC_PREVIEW_TRIGGERS = ['onStart', 'onInteract', 'onZoneEnter', 'onTimer'] as const;

export type LogicPreviewTrigger = (typeof LOGIC_PREVIEW_TRIGGERS)[number];

type LogicNode = {
  id: string;
  kind: string;
  trigger?: string;
  action?: string;
  target?: string;
  params?: Record<string, unknown>;
};

type LogicLink = {
  from: string;
  to: string;
};

export type LogicPreviewRequest = {
  trigger: LogicPreviewTrigger;
  target?: string;
};

export type LogicPreviewResult = {
  lines: string[];
  firedActions: number;
  matchedTriggers: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const safeString = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value.trim() : fallback;

const formatTarget = (value: string) => (value.length > 0 ? value : 'scene');

const formatParams = (value: Record<string, unknown> | undefined) => {
  if (!value || Object.keys(value).length === 0) return 'none';
  try {
    return JSON.stringify(value);
  } catch {
    return 'unserializable';
  }
};

const parseNode = (value: unknown): LogicNode | null => {
  if (!isRecord(value)) return null;
  const id = safeString(value.id);
  if (!id) return null;
  const params = isRecord(value.params) ? value.params : undefined;
  return {
    id,
    kind: safeString(value.kind, 'unknown'),
    trigger: safeString(value.trigger),
    action: safeString(value.action),
    target: safeString(value.target),
    params,
  };
};

const parseLink = (value: unknown): LogicLink | null => {
  if (!isRecord(value)) return null;
  const from = safeString(value.from);
  const to = safeString(value.to);
  if (!from || !to) return null;
  return { from, to };
};

const normalizeLogic = (logic: unknown) => {
  const raw = isRecord(logic) ? logic : {};
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.map(parseNode).filter(Boolean) : [];
  const links = Array.isArray(raw.links) ? raw.links.map(parseLink).filter(Boolean) : [];
  return {
    nodes: nodes as LogicNode[],
    links: links as LogicLink[],
  };
};

export const runLevelLogicPreview = (logic: unknown, request: LogicPreviewRequest): LogicPreviewResult => {
  const { nodes, links } = normalizeLogic(logic);
  const targetFilter = (request.target ?? '').trim();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();

  for (const link of links) {
    if (!byId.has(link.from) || !byId.has(link.to)) continue;
    const next = outgoing.get(link.from);
    if (next) next.push(link.to);
    else outgoing.set(link.from, [link.to]);
  }

  const matchedTriggers = nodes.filter((node) => {
    if (node.kind !== 'trigger') return false;
    if (node.trigger !== request.trigger) return false;
    if (!targetFilter) return true;
    return formatTarget(node.target ?? '') === targetFilter;
  });

  const lines: string[] = [];
  if (matchedTriggers.length === 0) {
    lines.push(
      `No matching triggers for ${request.trigger}${targetFilter ? ` with target ${targetFilter}` : ''}.`,
    );
    return { lines, firedActions: 0, matchedTriggers: 0 };
  }

  let firedActions = 0;

  for (const triggerNode of matchedTriggers) {
    const visitedEdges = new Set<string>();
    lines.push(
      `Trigger fired: ${request.trigger} (target: ${formatTarget(triggerNode.target ?? '')})`,
    );
    const queue = [triggerNode.id];
    let steps = 0;

    while (queue.length > 0 && steps < 128) {
      const nodeId = queue.shift();
      if (!nodeId) continue;
      const nextNodes = outgoing.get(nodeId) ?? [];
      for (const nextId of nextNodes) {
        const edgeKey = `${nodeId}->${nextId}`;
        if (visitedEdges.has(edgeKey)) continue;
        visitedEdges.add(edgeKey);
        const node = byId.get(nextId);
        if (!node) continue;

        if (node.kind === 'action') {
          firedActions += 1;
          const actionName = node.action || 'action';
          lines.push(
            `Action fired: ${actionName} -> ${formatTarget(node.target ?? '')} (params: ${formatParams(node.params)})`,
          );
        } else if (node.kind === 'trigger') {
          lines.push(
            `Chained trigger reached: ${node.trigger || 'unknown'} (target: ${formatTarget(node.target ?? '')})`,
          );
        } else {
          lines.push(`Node reached: ${node.kind || 'unknown'} (${node.id})`);
        }

        queue.push(nextId);
      }
      steps += 1;
    }
  }

  if (firedActions === 0) lines.push('No actions fired from matched trigger nodes.');
  return { lines, firedActions, matchedTriggers: matchedTriggers.length };
};
