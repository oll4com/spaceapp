// 为 limit 参数写的针对性单测：只测纯函数 selectOverviewNodes，不碰数据库/HTTP，
// 因此不依赖那 31 个在本机环境跑不起来的集成测试。
//
// 覆盖验收里那条 "the 3D view can request more than 2,000 nodes ... the default left unchanged"：
//   1) 不传 limit 时行为与改动前完全一致（2,000 上限）
//   2) 传 limit 能拿到更多节点
//   3) 节点数不足 limit 时原样返回
//   4) 保留 SOURCE/topic 的预留策略在新的预算下仍然生效
import { describe, expect, it } from "vitest";
import { OVERVIEW_DEFAULT_NODE_LIMIT, OVERVIEW_MAX_NODE_LIMIT, selectOverviewNodes } from "../src/memory-graph-routes.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

function build(count: number): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  const nodes: MemoryGraphNode[] = [];
  const edges: MemoryGraphEdge[] = [];
  for (let i = 0; i < count; i++) {
    const isSource = i % 50 === 0;
    nodes.push({
      id: `n${i}`,
      type: isSource ? "SOURCE" : "MEMORY",
      label: isSource ? `source-${i}.md` : `memory-${i}`,
      sourcePath: `/mem/${i}.md`,
      recordId: isSource ? null : `n${i}`,
    });
  }
  // 让前 200 个 MEMORY 各挂一个 TOPIC，验证预留策略
  for (let i = 1; i <= 200; i++) {
    const topicId = `t${i}`;
    nodes.push({ id: topicId, type: "TOPIC", label: `topic-${i}`, sourcePath: null, recordId: null });
    edges.push({ id: `e${i}`, type: "TAGGED_WITH", source: `n${i}`, target: topicId, origin: "EXPLICIT_TAG" });
  }
  return { nodes, edges };
}

describe("selectOverviewNodes limit", () => {
  it("默认预算就是历史的 2,000，不传 limit 与改动前一致", () => {
    const { nodes, edges } = build(6000);
    const selected = selectOverviewNodes(nodes, edges);
    expect(OVERVIEW_DEFAULT_NODE_LIMIT).toBe(2000);
    expect(selected.length).toBe(2000);
  });

  it("传更大的 limit 能拿到更多节点（3D 视图加载完整图）", () => {
    const { nodes, edges } = build(6000);
    const selected = selectOverviewNodes(nodes, edges, 5000);
    expect(selected.length).toBe(5000);
    expect(selected.length).toBeGreaterThan(2000);
  });

  it("节点数少于 limit 时原样返回，不做裁剪", () => {
    const { nodes, edges } = build(120);
    const selected = selectOverviewNodes(nodes, edges, 5000);
    expect(selected.length).toBe(nodes.length);
  });

  it("预算放大后，SOURCE 仍在选中集合里（预留策略未被新预算破坏）", () => {
    const { nodes, edges } = build(6000);
    const selected = selectOverviewNodes(nodes, edges, 5000);
    const ids = new Set(selected.map((node) => node.id));
    const sources = nodes.filter((node) => node.type === "SOURCE").slice(0, 20);
    for (const source of sources) expect(ids.has(source.id)).toBe(true);
  });

  it("上限常量与服务端硬上限一致", () => {
    expect(OVERVIEW_MAX_NODE_LIMIT).toBe(50000);
  });

  // 回归：预留节点曾经不计入预算。两个 SOURCE + 若干 TOPIC 会在填充循环之前就进集合，
  // 而那条循环只会在超限后 break、从不裁剪，于是 limit=1 也会返回两个 SOURCE。
  it("limit 小于预留数量时也不会超出 limit", () => {
    const { nodes, edges } = build(6000);
    for (const limit of [1, 2, 3, 5, 17]) {
      const selected = selectOverviewNodes(nodes, edges, limit);
      expect(selected.length, `limit=${limit}`).toBeLessThanOrEqual(limit);
    }
  });

  it("limit=1 时只返回一个节点，且优先给核心 SOURCE", () => {
    const { nodes, edges } = build(6000);
    const selected = selectOverviewNodes(nodes, edges, 1);
    expect(selected).toHaveLength(1);
    expect(selected[0].type).toBe("SOURCE");
  });

  it("预算被预留占满时，不再额外拉入 topic 的邻居节点", () => {
    const { nodes, edges } = build(6000);
    const selected = selectOverviewNodes(nodes, edges, 2);
    expect(selected.length).toBeLessThanOrEqual(2);
    // 每个入选节点都必须来自原始节点集合，不能是凭空塞进来的边端点
    const known = new Set(nodes.map((node) => node.id));
    for (const node of selected) expect(known.has(node.id)).toBe(true);
  });
});
