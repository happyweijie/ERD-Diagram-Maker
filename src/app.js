const SVG_NS = "http://www.w3.org/2000/svg";
const STORAGE_KEY = "erd-diagram-drawer:v1";
const VERSION = 1;
const GRID = 24;

const canvas = document.querySelector("#canvas");
const viewportEl = document.querySelector("#viewport");
const nodesLayer = document.querySelector("#nodes-layer");
const edgesLayer = document.querySelector("#edges-layer");
const uiLayer = document.querySelector("#ui-layer");
const gridBg = document.querySelector("#grid-bg");
const emptyState = document.querySelector("#empty-state");
const propertiesBody = document.querySelector("#properties-body");
const selectionKind = document.querySelector("#selection-kind");
const titleInput = document.querySelector("#project-title");
const saveDot = document.querySelector("#save-dot");
const saveText = document.querySelector("#save-text");
const lastSaved = document.querySelector("#last-saved");
const contextMenu = document.querySelector("#context-menu");

const nowIso = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const ATTR_RADIUS = 9;
const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let tool = "select";
let state = loadState();
let selected = new Set();
let edgeSelected = null;
let history = [];
let future = [];
let drag = null;
let connectorStart = null;
let saveTimer = null;
let lastContextTarget = null;

function defaultState() {
  const createdAt = nowIso();
  return {
    metadata: {
      title: "Untitled ERD",
      description: "",
      createdAt,
      updatedAt: createdAt,
      version: VERSION,
    },
    viewport: { zoom: 1, pan: { x: 160, y: 90 } },
    settings: { grid: true, snap: true, theme: "light" },
    nodes: [],
    edges: [],
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved?.metadata?.version === VERSION) return saved;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return defaultState();
}

function pushHistory() {
  history.push(JSON.stringify(state));
  if (history.length > 80) history.shift();
  future = [];
}

function commit(mutator, options = {}) {
  if (!options.skipHistory) pushHistory();
  mutator();
  state.metadata.updatedAt = nowIso();
  autosave();
  render();
}

function autosave() {
  saveDot.classList.add("pending");
  saveText.textContent = "Saving";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    saveDot.classList.remove("pending");
    saveText.textContent = "Saved locally";
    lastSaved.textContent = `Last saved ${new Date(state.metadata.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }, 220);
}

function setTool(next) {
  tool = next;
  connectorStart = null;
  document.querySelectorAll(".tool").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === tool);
  });
  canvas.style.cursor = tool === "connector" ? "crosshair" : "default";
  renderSelectionUi();
}

function snap(v) {
  return state.settings.snap ? Math.round(v / GRID) * GRID : v;
}

function clientToWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.viewport.pan.x) / state.viewport.zoom,
    y: (clientY - rect.top - state.viewport.pan.y) / state.viewport.zoom,
  };
}

function center(node) {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function attributeMarker(node) {
  return {
    x: node.x + node.width / 2,
    y: node.y + ((node.props?.composite || node.props?.partial) ? 18 : 16),
  };
}

function connectionCenter(node) {
  return node.type === "attribute" ? attributeMarker(node) : center(node);
}

function attributeParent(node) {
  if (node.type !== "attribute") return null;
  const edge = state.edges.find((candidate) => candidate.from === node.id || candidate.to === node.id);
  if (!edge) return null;
  const otherId = edge.from === node.id ? edge.to : edge.from;
  const other = nodeById(otherId);
  return other?.type === "attribute" ? null : other;
}

function compositeChildPos(node) {
  const marker = attributeMarker(node);
  const parent = attributeParent(node);
  const parentCenter = parent ? center(parent) : null;
  const dx = parentCenter ? marker.x - parentCenter.x : 0;
  const dy = parentCenter ? marker.y - parentCenter.y : 1;
  const horizontal = parentCenter ? Math.abs(dx) >= Math.abs(dy) : false;
  let childX = marker.x;
  let childY = marker.y;
  if (horizontal) {
    childX = marker.x + (dx >= 0 ? 28 : -28);
  } else {
    childY = marker.y + (dy >= 0 ? 28 : -28);
  }
  return { childX, childY, horizontal, dx, dy };
}

function computeGroupLevels(parentId) {
  const attrGroups = [];
  const groups = new Set();
  state.edges.forEach((edge) => {
    const from = nodeById(edge.from);
    const to = nodeById(edge.to);
    const attr = from?.type === "attribute" ? from : to?.type === "attribute" ? to : null;
    const parent = attr?.id === from?.id ? to : from;
    if (!attr?.props?.composite || parent?.id !== parentId) return;
    const myGroups = String(attr.props.compositeGroup || "1").split(",").map(s => s.trim()).filter(Boolean);
    if (myGroups.length > 0) {
      attrGroups.push(myGroups);
      myGroups.forEach(g => groups.add(g));
    }
  });

  const groupList = [...groups].sort();
  const adj = {};
  groupList.forEach(g => adj[g] = new Set());
  attrGroups.forEach(myGroups => {
    for (let i = 0; i < myGroups.length; i++) {
      for (let j = i + 1; j < myGroups.length; j++) {
        adj[myGroups[i]].add(myGroups[j]);
        adj[myGroups[j]].add(myGroups[i]);
      }
    }
  });

  const levels = {};
  let maxLevel = 0;
  groupList.forEach(g => {
    const usedLevels = new Set([...adj[g]].map(neighbor => levels[neighbor]));
    let l = 0;
    while (usedLevels.has(l)) l++;
    levels[g] = l;
    if (l > maxLevel) maxLevel = l;
  });

  return { levels, totalLevels: maxLevel + 1 };
}

function compositeGroupDotPos(node, groupIndex, totalGroups) {
  const marker = attributeMarker(node);
  if (totalGroups <= 1) return marker;
  const { horizontal, dx, dy } = compositeChildPos(node);
  const spacing = ATTR_RADIUS * 2 + 10;
  // Offset toward the entity (opposite of child direction) so dots stack between entity and child
  if (horizontal) {
    const dir = dx >= 0 ? -1 : 1;
    return { x: marker.x + dir * groupIndex * spacing, y: marker.y };
  } else {
    const dir = dy >= 0 ? -1 : 1;
    return { x: marker.x, y: marker.y + dir * groupIndex * spacing };
  }
}

function nodeById(id) {
  return state.nodes.find((n) => n.id === id);
}

function edgeById(id) {
  return state.edges.find((e) => e.id === id);
}

function makeNode(type, x, y) {
  const base = {
    id: uid("node"),
    type,
    x: snap(x),
    y: snap(y),
    width: 150,
    height: 84,
    label: "Entity Set",
    style: {},
    notes: "",
  };
  if (type === "weakEntity") return { ...base, width: 150, height: 84, label: "Weak Entity", props: { weak: true } };
  if (type === "relationship") return { ...base, width: 170, height: 100, label: "Relationship", props: { identifying: false } };
  if (type === "aggregate") return { ...base, width: 260, height: 140, label: "Relationship", props: { aggregation: true } };
  if (type === "attribute") return { ...base, width: 112, height: 68, label: "attribute", props: { key: false, derived: false, partial: false, composite: false } };
  if (type === "derivedAttribute") return { ...base, type: "attribute", width: 118, height: 68, label: "derived", props: { key: false, derived: true, partial: false, composite: false } };
  if (type === "keyAttribute") return { ...base, type: "attribute", width: 118, height: 68, label: "key attr", props: { key: true, derived: false, partial: false, composite: false } };
  if (type === "note") return { ...base, width: 180, height: 86, label: "Note", props: { text: "Optional note" } };
  return base;
}

function makeEdge(from, to) {
  const toNode = nodeById(to);
  const isAttributeEdge = toNode?.type === "attribute" || nodeById(from)?.type === "attribute";
  return {
    id: uid("edge"),
    from,
    to,
    kind: isAttributeEdge ? "attribute" : "relationship",
    cardinality: isAttributeEdge ? "" : "(0,n)",
    participation: "optional",
    role: "",
    labelPosition: 0.5,
    style: {},
  };
}

function addNodeFromTool(type, point) {
  const node = makeNode(type, point.x - 70, point.y - 42);
  commit(() => {
    state.nodes.push(node);
    if (selected.size === 1 && node.type === "attribute") {
      const parent = [...selected][0];
      state.edges.push(makeEdge(parent, node.id));
    }
    selected = new Set([node.id]);
    edgeSelected = null;
  });
  setTool("select");
}

function duplicateSelected() {
  if (!selected.size) return;
  commit(() => {
    const mapping = new Map();
    const copies = [...selected].map((id) => {
      const copy = structuredClone(nodeById(id));
      copy.id = uid("node");
      copy.x += 28;
      copy.y += 28;
      mapping.set(id, copy.id);
      return copy;
    });
    const edgeCopies = state.edges
      .filter((edge) => mapping.has(edge.from) && mapping.has(edge.to))
      .map((edge) => ({ ...structuredClone(edge), id: uid("edge"), from: mapping.get(edge.from), to: mapping.get(edge.to) }));
    state.nodes.push(...copies);
    state.edges.push(...edgeCopies);
    selected = new Set(copies.map((n) => n.id));
    edgeSelected = null;
  });
}

function deleteSelection() {
  if (!selected.size && !edgeSelected) return;
  commit(() => {
    const ids = new Set(selected);
    state.nodes = state.nodes.filter((node) => !ids.has(node.id));
    state.edges = state.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to) && edge.id !== edgeSelected);
    selected.clear();
    edgeSelected = null;
  });
}

function undo() {
  if (!history.length) return;
  future.push(JSON.stringify(state));
  state = JSON.parse(history.pop());
  selected.clear();
  edgeSelected = null;
  autosave();
  render();
}

function redo() {
  if (!future.length) return;
  history.push(JSON.stringify(state));
  state = JSON.parse(future.pop());
  selected.clear();
  edgeSelected = null;
  autosave();
  render();
}

function applyViewport() {
  viewportEl.setAttribute("transform", `translate(${state.viewport.pan.x} ${state.viewport.pan.y}) scale(${state.viewport.zoom})`);
}

function render() {
  titleInput.value = state.metadata.title;
  document.querySelector("#grid-toggle").checked = state.settings.grid;
  document.querySelector("#snap-toggle").checked = state.settings.snap;
  gridBg.style.display = state.settings.grid ? "" : "none";
  emptyState.style.display = state.nodes.length ? "none" : "flex";
  applyViewport();
  renderEdges();
  renderNodes();
  renderSelectionUi();
  const activeEl = document.activeElement;
  const isEditingProperty = activeEl && propertiesBody.contains(activeEl) && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA");
  if (!isEditingProperty) renderProperties();
}

function svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value !== undefined && value !== null) el.setAttribute(key, String(value));
  });
  children.forEach((child) => el.appendChild(child));
  return el;
}

function textLines(label, maxChars = 16) {
  const words = String(label || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines.slice(0, 3) : [""];
}

function labelEl(label, x, y, options = {}) {
  const text = svg("text", {
    x,
    y,
    "text-anchor": options.anchor || "middle",
    "dominant-baseline": "middle",
    class: options.small ? "erd-label small-label" : "erd-label",
  });
  const lines = textLines(label, options.maxChars || 16);
  lines.forEach((line, index) => {
    text.appendChild(svg("tspan", {
      x,
      dy: index === 0 ? `${-(lines.length - 1) * 0.62}em` : "1.24em",
    }, [document.createTextNode(line)]));
  });
  return text;
}

function renderNodes() {
  nodesLayer.replaceChildren();
  state.nodes.forEach((node) => {
    const group = svg("g", { class: `node ${selected.has(node.id) ? "selected" : ""}`, "data-id": node.id, tabindex: 0 });
    group.appendChild(shapeForNode(node));
    group.appendChild(labelForNode(node));
    anchorPoints(node).forEach((p) => group.appendChild(svg("circle", { class: "anchor", cx: p.x, cy: p.y, r: 5, "data-anchor": node.id })));
    nodesLayer.appendChild(group);
  });
}

function shapeForNode(node) {
  if (node.type === "relationship") {
    return svg("polygon", {
      class: "node-shape",
      points: `${node.x + node.width / 2},${node.y} ${node.x + node.width},${node.y + node.height / 2} ${node.x + node.width / 2},${node.y + node.height} ${node.x},${node.y + node.height / 2}`,
      fill: "#fff",
      stroke: "#111827",
      "stroke-width": 2,
    });
  }
  if (node.type === "aggregate") {
    const g = svg("g");
    g.appendChild(svg("rect", { class: "node-shape", x: node.x, y: node.y, width: node.width, height: node.height, fill: "rgba(255,255,255,0.62)", stroke: "#111827", "stroke-width": 2 }));
    const padX = node.width * 0.06;
    const padY = node.height * 0.16;
    g.appendChild(svg("polygon", {
      class: "node-shape",
      points: `${node.x + node.width / 2},${node.y + padY} ${node.x + node.width - padX},${node.y + node.height / 2} ${node.x + node.width / 2},${node.y + node.height - padY} ${node.x + padX},${node.y + node.height / 2}`,
      fill: "#fff",
      stroke: "#111827",
      "stroke-width": 2,
    }));
    return g;
  }
  if (node.type === "attribute") {
    const g = svg("g");
    const marker = attributeMarker(node);
    if (node.props?.composite || node.props?.partial) {
      const { childX, childY, horizontal, dx, dy } = compositeChildPos(node);
      const parent = attributeParent(node);

      // Determine number of filled dots (one per composite group)
      let dotPositions = [attributeMarker(node)];
      if (node.props?.composite && parent) {
        const { levels, totalLevels } = computeGroupLevels(parent.id);
        const myGroups = String(node.props.compositeGroup || "1").split(",").map(s => s.trim()).filter(Boolean);
        dotPositions = myGroups.map(gName => {
          const l = levels[gName] ?? 0;
          return compositeGroupDotPos(node, l, totalLevels);
        });
      }

      // Draw line from farthest filled dot to clear dot
      const farthest = dotPositions.reduce((best, p) => {
        const d = Math.sqrt((p.x - childX) ** 2 + (p.y - childY) ** 2);
        return d > best.d ? { p, d } : best;
      }, { p: dotPositions[0], d: 0 }).p;
      const cdx = childX - farthest.x;
      const cdy = childY - farthest.y;
      const dist = Math.sqrt(cdx * cdx + cdy * cdy) || 1;
      const stopX = farthest.x + cdx * (dist - ATTR_RADIUS) / dist;
      const stopY = farthest.y + cdy * (dist - ATTR_RADIUS) / dist;
      g.appendChild(svg("line", { class: "node-shape", x1: farthest.x, y1: farthest.y, x2: stopX, y2: stopY, stroke: "#111827", "stroke-width": 2 }));

      // Draw filled dots
      for (const dp of dotPositions) {
        g.appendChild(svg("circle", { class: "node-shape", cx: dp.x, cy: dp.y, r: ATTR_RADIUS, fill: "#000", stroke: "#111827", "stroke-width": 2 }));
      }

      // Draw clear dot at child
      g.appendChild(svg("circle", { class: "node-shape", cx: childX, cy: childY, r: ATTR_RADIUS, fill: "#fff", stroke: "#111827", "stroke-width": 2 }));
      return g;
    }
    g.appendChild(svg("circle", {
      class: "node-shape",
      cx: marker.x,
      cy: marker.y,
      r: ATTR_RADIUS,
      fill: node.props?.key ? "#000" : "#fff",
      stroke: "#111827",
      "stroke-width": 2,
    }));
    return g;
  }
  if (node.type === "note") {
    return svg("rect", { class: "node-shape", x: node.x, y: node.y, width: node.width, height: node.height, fill: "#fffceb", stroke: "#d6b94c", "stroke-width": 1.5, rx: 6 });
  }
  return svg("rect", { class: "node-shape", x: node.x, y: node.y, width: node.width, height: node.height, fill: "#fff", stroke: "#111827", "stroke-width": 2 });
}

function labelForNode(node) {
  const g = svg("g");
  if (node.type === "attribute") {
    const marker = attributeMarker(node);
    const parent = attributeParent(node);
    const parentCenter = parent ? center(parent) : null;
    const dx = parentCenter ? marker.x - parentCenter.x : 0;
    const dy = parentCenter ? marker.y - parentCenter.y : 1;
    const horizontal = parentCenter ? Math.abs(dx) >= Math.abs(dy) : false;

    let labelAnchorX = marker.x;
    let labelAnchorY = marker.y;

    if (node.props?.composite || node.props?.partial) {
      const { childX, childY } = compositeChildPos(node);
      labelAnchorX = childX;
      labelAnchorY = childY;
    }

    if (horizontal) {
      const isRight = dx >= 0;
      const x = labelAnchorX + (isRight ? ATTR_RADIUS + 8 : -ATTR_RADIUS - 8);
      g.appendChild(labelEl(node.label, x, labelAnchorY, { maxChars: 16, anchor: isRight ? "start" : "end" }));
    } else {
      const isBottom = parentCenter ? dy >= 0 : true;
      const labelY = labelAnchorY + (isBottom ? 32 : -32);
      g.appendChild(labelEl(node.label, labelAnchorX, labelY, { maxChars: 14 }));
    }
    return g;
  }
  g.appendChild(labelEl(node.label, node.x + node.width / 2, node.y + node.height / 2, { maxChars: 16 }));
  return g;
}

function anchorPoints(node) {
  if (node.type === "attribute") {
    const marker = attributeMarker(node);
    return [
      { x: marker.x, y: marker.y - ATTR_RADIUS },
      { x: marker.x + ATTR_RADIUS, y: marker.y },
      { x: marker.x, y: marker.y + ATTR_RADIUS },
      { x: marker.x - ATTR_RADIUS, y: marker.y },
    ];
  }
  const c = center(node);
  return [
    { x: c.x, y: node.y },
    { x: node.x + node.width, y: c.y },
    { x: c.x, y: node.y + node.height },
    { x: node.x, y: c.y },
  ];
}

function edgeEndpoints(edge) {
  const from = nodeById(edge.from);
  const to = nodeById(edge.to);
  if (!from || !to) return null;
  if (from.type === "attribute" || to.type === "attribute") {
    return attributeEdgeEndpoints(edge, from, to);
  }
  if (from.id === to.id) {
    const c = center(from);
    return { from, to, a: { x: from.x + from.width, y: c.y - 12 }, b: { x: from.x + from.width, y: c.y + 24 }, self: true };
  }
  const a = perimeterPoint(from, connectionCenter(to));
  const b = perimeterPoint(to, connectionCenter(from));
  return { from, to, a, b };
}

function attributeEdgeEndpoints(edge, from, to) {
  const attr = from.type === "attribute" ? from : to;
  const parent = attr.id === from.id ? to : from;
  const marker = attributeMarker(attr);
  const parentCenter = connectionCenter(parent);
  const dx = marker.x - parentCenter.x;
  const dy = marker.y - parentCenter.y;
  const useHorizontal = Math.abs(dx) >= Math.abs(dy);
  const isDiamond = parent.type === "relationship";
  const cx = parent.x + parent.width / 2;
  const cy = parent.y + parent.height / 2;
  const hw = parent.width / 2;
  const hh = parent.height / 2;
  let parentPoint;
  let attrPoint;
  if (isDiamond) {
    if (useHorizontal) {
      const y = clamp(marker.y, parent.y, parent.y + parent.height);
      const sideX = cx + (dx >= 0 ? 1 : -1) * hw * Math.max(0, 1 - Math.abs(y - cy) / hh);
      parentPoint = { x: sideX, y };
      attrPoint = { x: marker.x + (dx >= 0 ? -ATTR_RADIUS : ATTR_RADIUS), y };
    } else {
      const x = clamp(marker.x, parent.x, parent.x + parent.width);
      const sideY = cy + (dy >= 0 ? 1 : -1) * hh * Math.max(0, 1 - Math.abs(x - cx) / hw);
      parentPoint = { x, y: sideY };
      attrPoint = { x, y: marker.y + (dy >= 0 ? -ATTR_RADIUS : ATTR_RADIUS) };
    }
  } else if (useHorizontal) {
    const sideX = dx >= 0 ? parent.x + parent.width : parent.x;
    const y = clamp(marker.y, parent.y, parent.y + parent.height);
    parentPoint = { x: sideX, y };
    attrPoint = { x: marker.x + (dx >= 0 ? -ATTR_RADIUS : ATTR_RADIUS), y };
  } else {
    const sideY = dy >= 0 ? parent.y + parent.height : parent.y;
    const x = clamp(marker.x, parent.x, parent.x + parent.width);
    parentPoint = { x, y: sideY };
    attrPoint = { x, y: marker.y + (dy >= 0 ? -ATTR_RADIUS : ATTR_RADIUS) };
  }
  return {
    from,
    to,
    a: attr.id === from.id ? attrPoint : parentPoint,
    b: attr.id === from.id ? parentPoint : attrPoint,
    orthogonal: true,
  };
}

function perimeterPoint(node, toward) {
  if (node.type === "attribute") {
    const marker = attributeMarker(node);
    const dx = toward.x - marker.x || 0.001;
    const dy = toward.y - marker.y || 0.001;
    const t = ATTR_RADIUS / Math.sqrt(dx * dx + dy * dy);
    return { x: marker.x + dx * t, y: marker.y + dy * t };
  }
  const c = center(node);
  const dx = toward.x - c.x || 0.001;
  const dy = toward.y - c.y || 0.001;
  const hw = node.width / 2;
  const hh = node.height / 2;
  // Use diamond geometry for relationship shapes so edge lines touch the diamond
  if (node.type === "relationship") {
    const scale = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    return { x: c.x + dx * scale, y: c.y + dy * scale };
  }
  const scale = Math.min(hw / Math.abs(dx), hh / Math.abs(dy));
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

function renderEdges() {
  edgesLayer.replaceChildren();
  renderCompositeBars();
  const identifyingDots = new Map(); // relId -> [{x, y}]
  state.edges.forEach((edge) => {
    const ep = edgeEndpoints(edge);
    if (!ep) return;
    const group = svg("g", { class: "edge", "data-edge-id": edge.id });
    const attrNode = ep.from.type === "attribute" ? ep.from : ep.to.type === "attribute" ? ep.to : null;
    const dashed = attrNode?.props?.derived || edge.style?.dashed;
    const strokeWidth = edge.participation === "mandatory" ? 3 : 1.8;
    if (ep.self) {
      const d = `M ${ep.a.x} ${ep.a.y} C ${ep.a.x + 78} ${ep.a.y - 72}, ${ep.b.x + 78} ${ep.b.y + 72}, ${ep.b.x} ${ep.b.y}`;
      group.appendChild(svg("path", { class: "edge-line", d, fill: "none", stroke: edgeSelected === edge.id ? "#2563eb" : "#111827", "stroke-width": strokeWidth, "stroke-dasharray": dashed ? "7 5" : "" }));
    } else {
      group.appendChild(svg("line", { class: "edge-line", x1: ep.a.x, y1: ep.a.y, x2: ep.b.x, y2: ep.b.y, stroke: edgeSelected === edge.id ? "#2563eb" : "#111827", "stroke-width": strokeWidth, "stroke-dasharray": dashed ? "7 5" : "" }));
    }
    // Filled dots at identifying relationship connection points (strong entity side only)
    const DOT_R = 6;
    const DOT_OFFSET = 14;
    const isStrongEntity = (n) => n.type === "entity" && !n.props?.weak;
    if (ep.from.type === "relationship" && ep.from.props?.identifying && !ep.self && isStrongEntity(ep.to)) {
      const dx = ep.b.x - ep.a.x;
      const dy = ep.b.y - ep.a.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const dotX = ep.a.x + (dx / len) * DOT_OFFSET;
      const dotY = ep.a.y + (dy / len) * DOT_OFFSET;
      group.appendChild(svg("circle", { cx: dotX, cy: dotY, r: DOT_R, fill: "#111827" }));
      if (!identifyingDots.has(ep.from.id)) identifyingDots.set(ep.from.id, []);
      identifyingDots.get(ep.from.id).push({ x: dotX, y: dotY });
    }
    if (ep.to.type === "relationship" && ep.to.props?.identifying && !ep.self && isStrongEntity(ep.from)) {
      const dx = ep.a.x - ep.b.x;
      const dy = ep.a.y - ep.b.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const dotX = ep.b.x + (dx / len) * DOT_OFFSET;
      const dotY = ep.b.y + (dy / len) * DOT_OFFSET;
      group.appendChild(svg("circle", { cx: dotX, cy: dotY, r: DOT_R, fill: "#111827" }));
      if (!identifyingDots.has(ep.to.id)) identifyingDots.set(ep.to.id, []);
      identifyingDots.get(ep.to.id).push({ x: dotX, y: dotY });
    }
    const mid = ep.self
      ? { x: ep.a.x + 82, y: (ep.a.y + ep.b.y) / 2 }
      : { x: ep.a.x + (ep.b.x - ep.a.x) * (edge.labelPosition || 0.5), y: ep.a.y + (ep.b.y - ep.a.y) * (edge.labelPosition || 0.5) };
    const label = [edge.cardinality, edge.role].filter(Boolean).join(" ");
    if (label) {
      group.appendChild(svg("rect", { x: mid.x - label.length * 3.7 - 5, y: mid.y - 11, width: label.length * 7.4 + 10, height: 21, rx: 5, fill: "#f8fafc", stroke: "#cbd5e1", "stroke-width": 0.8 }));
      group.appendChild(labelEl(label, mid.x, mid.y, { small: true, maxChars: 28 }));
    }
    edgesLayer.appendChild(group);
  });
  // Draw connecting lines from identifying dots to partial key dots
  renderIdentifyingBars(identifyingDots);
}

function renderCompositeBars() {
  // Group composite attributes by (parentId, compositeGroup)
  const byGroup = new Map();
  state.edges.forEach((edge) => {
    const from = nodeById(edge.from);
    const to = nodeById(edge.to);
    const attr = from?.type === "attribute" ? from : to?.type === "attribute" ? to : null;
    const parent = attr?.id === from?.id ? to : from;
    if (!attr?.props?.composite || !parent) return;
    // Parse comma-separated group numbers (default "1")
    const groupStr = String(attr.props.compositeGroup || "1");
    const groups = groupStr.split(",").map(s => s.trim()).filter(Boolean);
    for (const g of groups) {
      const key = `${parent.id}:${g}`;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(attr);
    }
  });
  byGroup.forEach((attrs, key) => {
    if (attrs.length < 2) return;
    // Extract group name from key "parentId:groupName"
    const groupName = key.split(":").slice(1).join(":");
    const firstParent = attributeParent(attrs[0]);
    const { levels, totalLevels } = firstParent ? computeGroupLevels(firstParent.id) : { levels: { [groupName]: 0 }, totalLevels: 1 };
    const level = levels[groupName] ?? 0;
    const markers = attrs.map(attr => compositeGroupDotPos(attr, level, totalLevels));
    const minX = Math.min(...markers.map((marker) => marker.x));
    const maxX = Math.max(...markers.map((marker) => marker.x));
    const minY = Math.min(...markers.map((marker) => marker.y));
    const maxY = Math.max(...markers.map((marker) => marker.y));
    const vertical = maxY - minY > maxX - minX;
    const sorted = markers.sort((a, b) => vertical ? a.y - b.y : a.x - b.x);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const first = sorted[i];
      const second = sorted[i + 1];
      const x = (first.x + second.x) / 2;
      const y = (first.y + second.y) / 2;
      edgesLayer.appendChild(svg("line", {
        class: "edge-line",
        x1: vertical ? x : first.x + ATTR_RADIUS,
        y1: vertical ? first.y + ATTR_RADIUS : y,
        x2: vertical ? x : second.x - ATTR_RADIUS,
        y2: vertical ? second.y - ATTR_RADIUS : y,
        stroke: "#111827",
        "stroke-width": 2,
      }));
    }
  });
}

function renderIdentifyingBars(identifyingDots) {
  // For each identifying relationship, connect the strong-entity dot
  // to the partial key attribute's filled dot on the weak entity
  identifyingDots.forEach((dots, relId) => {
    const rel = nodeById(relId);
    if (!rel) return;

    // Find partial key markers on weak entities connected to this relationship
    const partialKeyMarkers = [];
    for (const edge of state.edges) {
      const fromNode = nodeById(edge.from);
      const toNode = nodeById(edge.to);
      if (!fromNode || !toNode) continue;
      const isRelFrom = fromNode.id === relId;
      const isRelTo = toNode.id === relId;
      if (!isRelFrom && !isRelTo) continue;
      const other = isRelFrom ? toNode : fromNode;
      if (other.type !== "weakEntity") continue;
      for (const attrEdge of state.edges) {
        const af = nodeById(attrEdge.from);
        const at = nodeById(attrEdge.to);
        const attr = af?.type === "attribute" ? af : at?.type === "attribute" ? at : null;
        const parent = attr?.id === af?.id ? at : af;
        if (attr?.props?.partial && parent?.id === other.id) {
          partialKeyMarkers.push(attributeMarker(attr));
        }
      }
    }

    if (!partialKeyMarkers.length) return;

    for (const dot of dots) {
      for (const pk of partialKeyMarkers) {
        const cx = rel.x + rel.width / 2;
        const cy = rel.y + rel.height / 2;
        const isDotHorizontal = Math.abs(dot.x - cx) / (rel.width / 2) > Math.abs(dot.y - cy) / (rel.height / 2);

        // If dot is on the sides, go vertical then horizontal to avoid crossing the diamond.
        // If dot is top/bottom, go horizontal then vertical.
        const points = isDotHorizontal 
          ? `${dot.x},${dot.y} ${dot.x},${pk.y} ${pk.x},${pk.y}`
          : `${dot.x},${dot.y} ${pk.x},${dot.y} ${pk.x},${pk.y}`;

        edgesLayer.appendChild(svg("polyline", {
          class: "edge-line",
          points,
          fill: "none",
          stroke: "#111827",
          "stroke-width": 2,
          "stroke-linejoin": "miter",
        }));
      }
    }
  });
}

function renderSelectionUi() {
  uiLayer.replaceChildren();
  selected.forEach((id) => {
    const node = nodeById(id);
    if (!node) return;
    uiLayer.appendChild(svg("rect", { class: "selection-box", x: node.x - 5, y: node.y - 5, width: node.width + 10, height: node.height + 10 }));
    uiLayer.appendChild(svg("rect", { class: "resize-handle", x: node.x + node.width - 6, y: node.y + node.height - 6, width: 12, height: 12, "data-resize": id }));
  });
  if (connectorStart) {
    const node = nodeById(connectorStart);
    if (node) {
      const c = center(node);
      uiLayer.appendChild(svg("circle", { cx: c.x, cy: c.y, r: 8, fill: "#0f766e", opacity: 0.25 }));
    }
  }
}

function renderProperties() {
  if (edgeSelected) return renderEdgeProperties(edgeById(edgeSelected));
  if (selected.size !== 1) {
    selectionKind.textContent = selected.size ? `${selected.size} selected` : "Nothing selected";
    propertiesBody.innerHTML = selected.size
      ? `<div class="property-actions"><button id="duplicate-prop">Duplicate</button><button id="delete-prop" class="danger">Delete</button></div>`
      : `<p class="hint">Select a diagram item to edit its name, notation, cardinality, participation, and notes.</p>`;
    document.querySelector("#duplicate-prop")?.addEventListener("click", duplicateSelected);
    document.querySelector("#delete-prop")?.addEventListener("click", deleteSelection);
    return;
  }
  const node = nodeById([...selected][0]);
  if (!node) return;
  selectionKind.textContent = node.type === "weakEntity" ? "weak entity" : node.type;
  const attributeControls = node.type === "attribute"
    ? `<label class="check-row"><input id="prop-key" type="checkbox" ${node.props?.key ? "checked" : ""}> Key attribute</label>
       <label class="check-row"><input id="prop-derived" type="checkbox" ${node.props?.derived ? "checked" : ""}> Derived attribute</label>
       <label class="check-row"><input id="prop-partial" type="checkbox" ${node.props?.partial ? "checked" : ""}> Partial key / weak marker</label>
       <label class="check-row"><input id="prop-composite" type="checkbox" ${node.props?.composite ? "checked" : ""}> Composite attribute marker</label>
       ${node.props?.composite ? `<div class="field"><label for="prop-composite-group">Composite group(s)</label><input id="prop-composite-group" placeholder="e.g. 1 or 1,2" value="${esc(node.props?.compositeGroup || "1")}"></div>` : ""}`
    : "";
  const entityControls = ["entity", "weakEntity"].includes(node.type)
    ? `<label class="check-row"><input id="prop-weak" type="checkbox" ${(node.type === "weakEntity" || node.props?.weak) ? "checked" : ""}> Weak entity</label>`
    : "";
  const relationshipControls = ["relationship", "aggregate"].includes(node.type)
    ? `<label class="check-row"><input id="prop-identifying" type="checkbox" ${node.props?.identifying ? "checked" : ""}> Identifying (dot markers)</label>`
    : "";
  propertiesBody.innerHTML = `
    <div class="field"><label for="prop-label">Name</label><input id="prop-label" value="${esc(node.label)}"></div>
    <div class="row">
      <div class="field"><label for="prop-width">Width</label><input id="prop-width" type="number" min="48" value="${Math.round(node.width)}"></div>
      <div class="field"><label for="prop-height">Height</label><input id="prop-height" type="number" min="36" value="${Math.round(node.height)}"></div>
    </div>
    ${entityControls}
    ${relationshipControls}
    ${attributeControls}
    <div class="field"><label for="prop-notes">Optional notes</label><textarea id="prop-notes">${esc(node.notes || "")}</textarea></div>
    <div class="property-actions">
      <button id="add-child-attr">Add connected attribute</button>
      <button id="duplicate-prop">Duplicate</button>
      <button id="delete-prop" class="danger">Delete</button>
    </div>`;
  bindNodeProperties(node);
}

function bindNodeProperties(node) {
  const update = (fn) => commit(() => fn(nodeById(node.id)));
  document.querySelector("#prop-label").addEventListener("input", (e) => update((n) => (n.label = e.target.value)));
  document.querySelector("#prop-width").addEventListener("change", (e) => update((n) => (n.width = clamp(Number(e.target.value) || n.width, 48, 800))));
  document.querySelector("#prop-height").addEventListener("change", (e) => update((n) => (n.height = clamp(Number(e.target.value) || n.height, 36, 600))));
  document.querySelector("#prop-notes").addEventListener("input", (e) => update((n) => (n.notes = e.target.value)));
  document.querySelector("#prop-weak")?.addEventListener("change", (e) => {
    update((n) => { n.props = { ...n.props, weak: e.target.checked }; n.type = e.target.checked ? "weakEntity" : "entity"; });
    renderProperties();
  });
  document.querySelector("#prop-identifying")?.addEventListener("change", (e) => update((n) => { n.props = { ...n.props, identifying: e.target.checked }; }));
  document.querySelector("#prop-composite-group")?.addEventListener("input", (e) => update((n) => { n.props = { ...n.props, compositeGroup: e.target.value }; }));
  ["key", "derived", "partial", "composite"].forEach((key) => {
    document.querySelector(`#prop-${key}`)?.addEventListener("change", (e) => {
      update((n) => { n.props = { ...n.props, [key]: e.target.checked }; });
      if (key === "composite") renderProperties();
    });
  });
  document.querySelector("#add-child-attr").addEventListener("click", () => {
    const parent = nodeById(node.id);
    const child = makeNode("attribute", parent.x + parent.width + 64, parent.y + parent.height / 2 - 29);
    commit(() => {
      state.nodes.push(child);
      state.edges.push(makeEdge(parent.id, child.id));
      selected = new Set([child.id]);
      edgeSelected = null;
    });
  });
  document.querySelector("#duplicate-prop").addEventListener("click", duplicateSelected);
  document.querySelector("#delete-prop").addEventListener("click", deleteSelection);
}

function renderEdgeProperties(edge) {
  if (!edge) return;
  selectionKind.textContent = "connector";
  propertiesBody.innerHTML = `
    <div class="field"><label for="edge-kind">Connector kind</label><select id="edge-kind">
      <option value="relationship" ${edge.kind === "relationship" ? "selected" : ""}>Relationship edge</option>
      <option value="attribute" ${edge.kind === "attribute" ? "selected" : ""}>Attribute connector</option>
      <option value="aggregation" ${edge.kind === "aggregation" ? "selected" : ""}>Aggregation connector</option>
    </select></div>
    <div class="field"><label for="edge-cardinality">Cardinality</label><select id="edge-cardinality">
      ${["", "(0,1)", "(1,1)", "(0,n)", "(1,n)", "custom"].map((v) => `<option value="${v}" ${edge.cardinality === v ? "selected" : ""}>${v || "none"}</option>`).join("")}
    </select></div>
    <div class="field"><label for="edge-custom">Custom min/max</label><input id="edge-custom" placeholder="e.g. (2,5)" value="${esc(edge.cardinality && !["(0,1)", "(1,1)", "(0,n)", "(1,n)"].includes(edge.cardinality) ? edge.cardinality : "")}"></div>
    <div class="field"><label for="edge-participation">Participation</label><select id="edge-participation">
      <option value="optional" ${edge.participation === "optional" ? "selected" : ""}>Optional / single line</option>
      <option value="mandatory" ${edge.participation === "mandatory" ? "selected" : ""}>Mandatory / bold line</option>
    </select></div>
    <div class="field"><label for="edge-role">Role name</label><input id="edge-role" placeholder="manager, owner, ..." value="${esc(edge.role || "")}"></div>
    <div class="field"><label for="edge-position">Label position</label><input id="edge-position" type="range" min="0.15" max="0.85" step="0.05" value="${edge.labelPosition || 0.5}"></div>
    <div class="property-actions"><button id="delete-prop" class="danger">Delete connector</button></div>`;
  const update = (fn) => commit(() => fn(edgeById(edge.id)));
  document.querySelector("#edge-kind").addEventListener("change", (e) => update((ed) => (ed.kind = e.target.value)));
  document.querySelector("#edge-cardinality").addEventListener("change", (e) => update((ed) => { if (e.target.value !== "custom") ed.cardinality = e.target.value; }));
  document.querySelector("#edge-custom").addEventListener("input", (e) => update((ed) => { if (e.target.value.trim()) ed.cardinality = e.target.value.trim(); }));
  document.querySelector("#edge-participation").addEventListener("change", (e) => update((ed) => (ed.participation = e.target.value)));
  document.querySelector("#edge-role").addEventListener("input", (e) => update((ed) => (ed.role = e.target.value)));
  document.querySelector("#edge-position").addEventListener("input", (e) => update((ed) => (ed.labelPosition = Number(e.target.value))));
  document.querySelector("#delete-prop").addEventListener("click", deleteSelection);
}

function pointerDown(e) {
  contextMenu.hidden = true;
  canvas.focus();
  const resizeId = e.target.dataset.resize;
  const nodeGroup = e.target.closest?.(".node");
  const edgeGroup = e.target.closest?.(".edge");
  const p = clientToWorld(e.clientX, e.clientY);

  if (resizeId) {
    drag = { mode: "resize", id: resizeId, start: p, original: structuredClone(nodeById(resizeId)) };
    pushHistory();
    return;
  }
  if (nodeGroup) {
    const id = nodeGroup.dataset.id;
    if (tool === "connector") {
      if (!connectorStart) connectorStart = id;
      else {
        const from = connectorStart;
        const to = id;
        commit(() => {
          state.edges.push(makeEdge(from, to));
          connectorStart = null;
          selected.clear();
          edgeSelected = state.edges[state.edges.length - 1].id;
        });
      }
      renderSelectionUi();
      return;
    }
    if (!selected.has(id)) {
      if (!e.shiftKey) selected.clear();
      selected.add(id);
      edgeSelected = null;
      render();
    } else if (e.shiftKey) {
      selected.delete(id);
      render();
      return;
    }
    drag = { mode: "move", start: p, originals: [...selected].map((sid) => structuredClone(nodeById(sid))) };
    pushHistory();
    return;
  }
  if (edgeGroup) {
    selected.clear();
    edgeSelected = edgeGroup.dataset.edgeId;
    render();
    return;
  }
  if (tool !== "select" && tool !== "connector") {
    addNodeFromTool(tool, p);
    return;
  }
  selected.clear();
  edgeSelected = null;
  drag = { mode: "pan", startClient: { x: e.clientX, y: e.clientY }, startPan: { ...state.viewport.pan } };
  render();
}

function pointerMove(e) {
  if (!drag) return;
  const p = clientToWorld(e.clientX, e.clientY);
  if (drag.mode === "pan") {
    state.viewport.pan.x = drag.startPan.x + e.clientX - drag.startClient.x;
    state.viewport.pan.y = drag.startPan.y + e.clientY - drag.startClient.y;
    applyViewport();
    autosave();
    return;
  }
  if (drag.mode === "move") {
    commit(() => {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      drag.originals.forEach((orig) => {
        const node = nodeById(orig.id);
        node.x = snap(orig.x + dx);
        node.y = snap(orig.y + dy);
      });
    }, { skipHistory: true });
    return;
  }
  if (drag.mode === "resize") {
    commit(() => {
      const node = nodeById(drag.id);
      node.width = snap(clamp(drag.original.width + p.x - drag.start.x, 48, 900));
      node.height = snap(clamp(drag.original.height + p.y - drag.start.y, 36, 700));
    }, { skipHistory: true });
  }
}

function pointerUp() {
  if (drag) {
    drag = null;
    autosave();
  }
}

function zoom(e) {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const before = clientToWorld(e.clientX, e.clientY);
  const factor = e.deltaY < 0 ? 1.08 : 0.925;
  state.viewport.zoom = clamp(state.viewport.zoom * factor, 0.25, 3);
  state.viewport.pan.x = mouse.x - before.x * state.viewport.zoom;
  state.viewport.pan.y = mouse.y - before.y * state.viewport.zoom;
  applyViewport();
  autosave();
}

function fitToContent() {
  if (!state.nodes.length) return;
  const box = contentBounds(48);
  const rect = canvas.getBoundingClientRect();
  const zoom = clamp(Math.min(rect.width / box.width, rect.height / box.height), 0.3, 1.7);
  commit(() => {
    state.viewport.zoom = zoom;
    state.viewport.pan.x = rect.width / 2 - (box.x + box.width / 2) * zoom;
    state.viewport.pan.y = rect.height / 2 - (box.y + box.height / 2) * zoom;
  });
}

function contentBounds(pad = 0) {
  if (!state.nodes.length) return { x: 0, y: 0, width: 1000, height: 700 };
  const xs = state.nodes.flatMap((n) => [n.x, n.x + n.width]);
  const ys = state.nodes.flatMap((n) => [n.y, n.y + n.height]);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  return { x: minX, y: minY, width: Math.max(...xs) - minX + pad, height: Math.max(...ys) - minY + pad };
}

async function exportPng() {
  const box = contentBounds(72);
  const clone = canvas.cloneNode(true);
  clone.querySelector("#ui-layer")?.replaceChildren();
  clone.querySelector("#grid-bg")?.remove();
  clone.querySelectorAll(".anchor").forEach((el) => el.remove());
  clone.setAttribute("width", String(box.width * 2));
  clone.setAttribute("height", String(box.height * 2));
  clone.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
  clone.querySelector("#viewport")?.removeAttribute("transform");
  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = `
    .erd-label{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace;font-size:15px;fill:#0f172a}
    .small-label{font-size:12px;fill:#334155}
    .node-shape,.edge-line{vector-effect:non-scaling-stroke}
  `;
  clone.insertBefore(style, clone.firstChild);
  clone.insertBefore(svg("rect", { x: box.x, y: box.y, width: box.width, height: box.height, fill: "#ffffff" }), clone.firstChild);
  const data = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([data], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  await img.decode();
  const out = document.createElement("canvas");
  out.width = Math.ceil(box.width * 2);
  out.height = Math.ceil(box.height * 2);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(img, 0, 0, out.width, out.height);
  URL.revokeObjectURL(url);
  const a = document.createElement("a");
  a.download = `${(state.metadata.title || "erd-diagram").replace(/[^\w.-]+/g, "-")}.png`;
  a.href = out.toDataURL("image/png");
  a.click();
}

function showContextMenu(e) {
  e.preventDefault();
  const nodeGroup = e.target.closest?.(".node");
  const edgeGroup = e.target.closest?.(".edge");
  if (nodeGroup) {
    selected = new Set([nodeGroup.dataset.id]);
    edgeSelected = null;
    lastContextTarget = { type: "node", id: nodeGroup.dataset.id };
  } else if (edgeGroup) {
    selected.clear();
    edgeSelected = edgeGroup.dataset.edgeId;
    lastContextTarget = { type: "edge", id: edgeGroup.dataset.edgeId };
  } else {
    return;
  }
  render();
  contextMenu.style.left = `${e.clientX}px`;
  contextMenu.style.top = `${e.clientY}px`;
  contextMenu.hidden = false;
}

function clearCanvas() {
  if (!confirm("Clear the entire ERD canvas? This keeps the app open but removes all nodes and connectors.")) return;
  commit(() => {
    state.nodes = [];
    state.edges = [];
    selected.clear();
    edgeSelected = null;
    state.viewport = { zoom: 1, pan: { x: 160, y: 90 } };
  });
}

function seedExample() {
  if (state.nodes.length) return;
  commit(() => {
    const student = makeNode("entity", 60, 80);
    student.label = "Student";
    const enrolls = makeNode("relationship", 300, 78);
    enrolls.label = "Enrolls";
    const course = makeNode("entity", 560, 80);
    course.label = "Course";
    const sid = makeNode("keyAttribute", 80, -30);
    sid.label = "student_id";
    const grade = makeNode("attribute", 320, -30);
    grade.label = "grade";
    state.nodes.push(student, enrolls, course, sid, grade);
    state.edges.push(
      { ...makeEdge(student.id, enrolls.id), cardinality: "(1,n)", participation: "mandatory", role: "takes" },
      { ...makeEdge(enrolls.id, course.id), cardinality: "(0,n)", role: "offered" },
      makeEdge(student.id, sid.id),
      { ...makeEdge(enrolls.id, grade.id), kind: "attribute" },
    );
    selected.clear();
  });
}

document.querySelectorAll(".tool").forEach((button) => button.addEventListener("click", () => setTool(button.dataset.tool)));
document.querySelector("#undo-btn").addEventListener("click", undo);
document.querySelector("#redo-btn").addEventListener("click", redo);
document.querySelector("#fit-btn").addEventListener("click", fitToContent);
document.querySelector("#png-btn").addEventListener("click", exportPng);
document.querySelector("#clear-btn").addEventListener("click", clearCanvas);
document.querySelector("#grid-toggle").addEventListener("change", (e) => commit(() => (state.settings.grid = e.target.checked)));
document.querySelector("#snap-toggle").addEventListener("change", (e) => commit(() => (state.settings.snap = e.target.checked)));
titleInput.addEventListener("input", (e) => commit(() => (state.metadata.title = e.target.value)));
canvas.addEventListener("pointerdown", pointerDown);
window.addEventListener("pointermove", pointerMove);
window.addEventListener("pointerup", pointerUp);
canvas.addEventListener("wheel", zoom, { passive: false });
canvas.addEventListener("dblclick", (e) => {
  const group = e.target.closest?.(".node");
  if (!group) return;
  const node = nodeById(group.dataset.id);
  const label = prompt("Rename", node.label);
  if (label !== null) commit(() => (node.label = label));
});
canvas.addEventListener("contextmenu", showContextMenu);
document.addEventListener("click", (e) => {
  if (!contextMenu.contains(e.target)) contextMenu.hidden = true;
});
contextMenu.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  contextMenu.hidden = true;
  if (action === "duplicate") duplicateSelected();
  if (action === "delete") deleteSelection();
  if (action === "edit") renderProperties();
  if (action === "convert" && lastContextTarget?.type === "node") {
    commit(() => {
      const n = nodeById(lastContextTarget.id);
      if (!n) return;
      if (n.type === "entity") { n.type = "weakEntity"; n.props = { ...n.props, weak: true }; }
      else if (n.type === "weakEntity") { n.type = "entity"; n.props = { ...n.props, weak: false }; }
    });
  }
});
document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && ["y", "Z"].includes(e.key)) { e.preventDefault(); redo(); }
  else if (e.key === "Delete" || e.key === "Backspace") deleteSelection();
  else if (e.key.toLowerCase() === "v") setTool("select");
  else if (e.key.toLowerCase() === "c") setTool("connector");
  else if (e.key.toLowerCase() === "e") setTool("entity");
  else if (e.key.toLowerCase() === "w") setTool("weakEntity");
  else if (e.key.toLowerCase() === "r") setTool("relationship");
  else if (e.key.toLowerCase() === "a") setTool("attribute");
  else if (e.key.toLowerCase() === "d") setTool("derivedAttribute");
  else if (e.key.toLowerCase() === "k") setTool("keyAttribute");
  else if (e.key.toLowerCase() === "g") setTool("aggregate");
  else if (e.key.toLowerCase() === "n") setTool("note");
});

render();
autosave();

window.erdApp = {
  getState: () => structuredClone(state),
  loadDemo: seedExample,
};
