/**
 * Whiteboard attention weight calculation.
 *
 * Weight determines visual prominence. Computed on read, not stored.
 * Higher weight = more attention needed from the human.
 *
 * Formula:
 *   weight = base + age_factor + downstream_factor
 *
 * Capped at 1.0. Items with weight > 0.5 get visual emphasis.
 */

import type { WhiteboardNode, WeightedNode } from "./types.js";

// ── Base weights by type and status ──────────────────────────────────────────

function getBaseWeight(node: WhiteboardNode): number {
  if (node.status === "done" || node.status === "archived") return 0;

  switch (node.type) {
    case "question":
      return node.answer ? 0 : 0.6;   // Unanswered = high, answered = done
    case "decision":
      return 0.5;
    case "task":
      return 0.2;
    case "goal":
      return 0.1;
    case "note":
      return 0.0;
    default:
      return 0.1;
  }
}

// ── Age factor (only for unanswered questions) ───────────────────────────────

function getAgeFactor(node: WhiteboardNode): number {
  if (node.type !== "question" || node.answer) return 0;
  if (node.status !== "open") return 0;

  const created = new Date(node.createdAt).getTime();
  const now = Date.now();
  const daysSinceCreated = (now - created) / (1000 * 60 * 60 * 24);

  return Math.min(0.3, daysSinceCreated * 0.05);
}

// ── Downstream factor ────────────────────────────────────────────────────────

/**
 * Count open descendants for a node. Pre-computed via the childrenMap.
 */
function countOpenDescendants(
  nodeId: string,
  childrenMap: Map<string, WhiteboardNode[]>,
  allNodes: Map<string, WhiteboardNode>,
): number {
  const children = childrenMap.get(nodeId) ?? [];
  let count = 0;

  for (const child of children) {
    if (child.status === "open") count++;
    count += countOpenDescendants(child.id, childrenMap, allNodes);
  }

  return count;
}

// ── Compute weights for all nodes ────────────────────────────────────────────

/**
 * Compute attention weights for a set of nodes.
 * Builds the parent-child index once, then calculates weight per node.
 */
export function computeWeights(nodes: WhiteboardNode[]): WeightedNode[] {
  // Build children index
  const allNodes = new Map<string, WhiteboardNode>();
  const childrenMap = new Map<string, WhiteboardNode[]>();

  for (const node of nodes) {
    allNodes.set(node.id, node);
  }

  for (const node of nodes) {
    if (node.parentId) {
      const siblings = childrenMap.get(node.parentId) ?? [];
      siblings.push(node);
      childrenMap.set(node.parentId, siblings);
    }
  }

  // Compute weight for each node
  return nodes.map((node) => {
    const base = getBaseWeight(node);
    const age = getAgeFactor(node);
    const openDesc = countOpenDescendants(node.id, childrenMap, allNodes);
    const downstream = 0.03 * openDesc;
    const weight = Math.min(1.0, base + age + downstream);

    return {
      ...node,
      weight: Math.round(weight * 100) / 100,  // 2 decimal places
      openDescendants: openDesc,
    };
  });
}

/**
 * Build a tree structure from flat weighted nodes.
 * Returns only root nodes with children nested recursively.
 */
export function buildTree(
  weightedNodes: WeightedNode[],
  rootId?: string,
): import("./types.js").TreeNode[] {
  const nodeMap = new Map<string, WeightedNode>();
  const childrenMap = new Map<string, WeightedNode[]>();

  for (const node of weightedNodes) {
    nodeMap.set(node.id, node);
  }

  for (const node of weightedNodes) {
    const parentKey = node.parentId ?? "__root__";
    const siblings = childrenMap.get(parentKey) ?? [];
    siblings.push(node);
    childrenMap.set(parentKey, siblings);
  }

  function buildSubtree(nodeId: string, path: string[]): import("./types.js").TreeNode {
    const node = nodeMap.get(nodeId)!;
    const children = (childrenMap.get(nodeId) ?? [])
      .map((child) => buildSubtree(child.id, [...path, nodeId]));

    return {
      ...node,
      children,
      path,
    };
  }

  // If rootId specified, build subtree from that node
  if (rootId) {
    const rootNode = nodeMap.get(rootId);
    if (!rootNode) return [];
    return [buildSubtree(rootId, [])];
  }

  // Otherwise, build from all root nodes (parentId === null)
  const roots = childrenMap.get("__root__") ?? [];
  return roots.map((root) => buildSubtree(root.id, []));
}
