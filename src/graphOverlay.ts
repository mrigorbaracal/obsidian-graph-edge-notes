import { FederatedPointerEvent, Graphics } from "pixi.js";
import { InternalGraphLink, InternalGraphRenderer } from "./graphTypes";
import type GraphEdgeNotesPlugin from "./main";
import { ResolvedRelation } from "./types";
import { evaluateLabel } from "./expression";

interface RenderedRelationLabel {
  id: string;
  relation: ResolvedRelation;
  link: InternalGraphLink;
  orderIndex: number;
  totalOnEdge: number;
  labelEl: HTMLDivElement;
  widthPx: number;
  heightPx: number;
  isDynamic: boolean;
}

interface HighlightedNodeState {
  node: InternalGraphLink["source"];
  originalTint: number;
  originalAlpha: number;
}

export interface OverlayDebugSnapshot {
  activeGraphType: string;
  totalGraphEdges: number;
  renderedLabels: number;
  dirty: boolean;
}

export class GraphOverlayController {
  private currentRenderer: InternalGraphRenderer | null = null;
  private currentStage: InternalGraphRenderer["px"]["stage"] | null = null;
  private currentHanger: InternalGraphRenderer["hanger"] | null = null;
  private hoverHighlightEl: Graphics | null = null;
  private htmlOverlayEl: HTMLDivElement | null = null;
  private highlightedNodes = new Map<string, HighlightedNodeState>();
  private activeHoveredLabelId: string | null = null;
  private animationFrameId: number | null = null;
  private frameCounter = 0;
  private noRendererStreak = 0;
  private dirty = true;
  private labels = new Map<string, RenderedRelationLabel>();
  private tooltipEl: HTMLDivElement | null = null;
  private activeGraphType = "none";
  private preferredLeaf: unknown = null;
  private lastRebuildSignature = "";
  private lastRendererSignature = "";

  constructor(private readonly plugin: GraphEdgeNotesPlugin) {}

  activate(): void {
    this.ensureTooltip();
    this.refreshRenderer("activate");
    this.startLoop();
  }

  destroy(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.hideTooltip();
    this.destroyLabels();
    this.destroyHoverHighlight();
    this.currentRenderer = null;
    this.currentStage = null;
    this.currentHanger = null;
    this.clearInternalNodeHighlights();
    this.destroyHtmlOverlay();
    this.noRendererStreak = 0;
    this.tooltipEl?.remove();
    this.tooltipEl = null;
  }

  hideTooltipExternally(): void {
    this.hideTooltip();
  }

  handleGlobalPointerDown(_event: PointerEvent): void {}

  handleGlobalPointerMove(_event: PointerEvent): void {}

  handleGlobalPointerLeave(): void {
    this.activeHoveredLabelId = null;
    this.hideHoverHighlight();
    this.hideTooltip();
  }

  handleActiveLeafChange(leaf: unknown): boolean {
    const renderer = this.getRendererFromLeaf(leaf);
    if (renderer) {
      this.preferredLeaf = leaf;
      const graphType = this.getLeafGraphType(leaf) ?? this.detectGraphTypeForRenderer(renderer);
      this.plugin.debugLog(`Active graph leaf changed to ${graphType}`);
      this.bindRenderer(renderer, graphType, "active graph leaf change (direct bind)");
      this.dirty = true;
      return true;
    }

    return false;
  }

  refreshRenderer(reason = "refresh", forceDirty = false): void {
    const renderer = this.findRenderer();
    if (!renderer) {
      this.noRendererStreak += 1;
      const signature = `none::${reason}`;
      if (signature !== this.lastRendererSignature) {
        this.plugin.debugLog(`No graph renderer found during ${reason}; ${this.describeLeafState()}`);
        this.lastRendererSignature = signature;
      }

      if (this.currentRenderer) {
        return;
      }

      if (this.noRendererStreak >= 15) {
        this.destroyLabels();
        this.currentRenderer = null;
        this.currentStage = null;
        this.activeGraphType = "none";
        this.dirty = true;
      }

      return;
    }

    this.noRendererStreak = 0;

    const graphType = this.detectGraphTypeForRenderer(renderer);
    const signature = `${graphType}::${renderer.links.length}`;
    const stageChanged = this.getStage(renderer) !== this.currentStage;

    if (renderer !== this.currentRenderer || graphType !== this.activeGraphType || stageChanged) {
      this.bindRenderer(renderer, graphType, `${reason}; links=${renderer.links.length}`);
      this.dirty = true;
    } else if (signature !== this.lastRendererSignature) {
      this.plugin.debugLog(`Reusing ${graphType} renderer during ${reason}; links=${renderer.links.length}`);
      this.dirty = true;
    }

    if (forceDirty) {
      this.dirty = true;
    }

    this.lastRendererSignature = signature;
  }

  requestRebuild(reason = "refresh"): void {
    this.dirty = true;
    this.refreshRenderer(reason, true);
    this.startLoop();
  }

  forceRefresh(reason = "force refresh"): void {
    this.plugin.debugLog(`Force refresh requested: ${reason}`);
    this.frameCounter = 0;
    this.lastRebuildSignature = "";
    this.lastRendererSignature = "";
    this.dirty = true;
    this.refreshRenderer(reason, true);
    this.startLoop();
  }

  private startLoop(): void {
    if (this.animationFrameId !== null) {
      return;
    }

    const tick = (): void => {
      this.animationFrameId = requestAnimationFrame(tick);
      this.refreshRenderer("animation frame", false);

      if (!this.currentRenderer) {
        return;
      }

      if (this.dirty) {
        this.rebuildLabels();
      }

      this.updateLabelPositions();
      this.syncActiveHoverHighlight();
      this.plugin.updateDebugStatus(this.getDebugSnapshot());
      this.frameCounter += 1;
    };

    this.animationFrameId = requestAnimationFrame(tick);
  }

  private rebuildLabels(): void {
    const renderer = this.currentRenderer;
    if (!renderer) {
      return;
    }

    this.destroyLabels(true);

    if (!this.plugin.settings.showLabels) {
      this.hideTooltip();
      this.dirty = false;
      return;
    }

    for (const link of renderer.links) {
      const relations = this.plugin.relationStore.getRelationsForConnection(link.source.id, link.target.id);
      if (relations.length > 0) {
        this.plugin.debugLog(`Matched ${relations.length} relation(s) on edge ${link.source.id} -> ${link.target.id}`);
      }
      relations.forEach((relation, index) => {
        const renderId = `${relation.key}::${link.source.id}::${link.target.id}`;
        const label = this.createLabel(renderId, relation, link, index, relations.length);
        this.labels.set(renderId, label);
      });
    }

    const signature = `${this.activeGraphType}:${renderer.links.length}:${this.labels.size}`;
    if (signature !== this.lastRebuildSignature) {
      this.plugin.debugLog(`Rebuilt labels for ${renderer.links.length} edges; rendered ${this.labels.size} label(s)`);
      this.lastRebuildSignature = signature;
    }

    this.dirty = false;
  }

  private createLabel(
    id: string,
    relation: ResolvedRelation,
    link: InternalGraphLink,
    orderIndex: number,
    totalOnEdge: number
  ): RenderedRelationLabel {
    const renderer = this.currentRenderer;
    const overlay = this.ensureHtmlOverlay(renderer);
    if (!renderer || !overlay) {
      throw new Error("Cannot create edge label without a graph renderer");
    }

    const handleLabelPointerOver = (event: FederatedPointerEvent): void => {
      this.showTooltip(relation, event);
    };

    const handleLabelPointerMove = (event: FederatedPointerEvent): void => {
      this.moveTooltip(event);
    };

    const labelEl = overlay.createDiv({ cls: "graph-edge-notes-label" });
    labelEl.dataset.relationKey = id;
    labelEl.addEventListener("pointerenter", (event) => {
      handleLabelPointerOver(this.createSyntheticPointerEvent(event));
    });
    labelEl.addEventListener("pointermove", (event) => {
      handleLabelPointerMove(this.createSyntheticPointerEvent(event));
    });
    labelEl.addEventListener("pointerleave", () => {
      if (this.activeHoveredLabelId === id) {
        this.activeHoveredLabelId = null;
      }
      this.hideHoverHighlight();
      this.hideTooltip();
    });
    labelEl.addEventListener("pointerout", () => {
      if (this.activeHoveredLabelId === id) {
        this.activeHoveredLabelId = null;
      }
      this.hideHoverHighlight();
      this.hideTooltip();
    });

    const renderedLabel: RenderedRelationLabel = {
      id,
      relation,
      link,
      orderIndex,
      totalOnEdge,
      labelEl,
      widthPx: 0,
      heightPx: 0,
      isDynamic: false
    };

    this.applyLabelText(renderedLabel);
    this.applyLabelAppearance(renderedLabel, renderer);
    return renderedLabel;
  }

  private applyLabelText(label: RenderedRelationLabel): void {
    const rawLabel = label.relation.label;
    const isDynamic = rawLabel && rawLabel.startsWith("=");

    if (isDynamic) {
      let frontmatter = label.relation.sourceFrontmatter;
      if (!frontmatter) {
        const sourcePath = label.relation.sourcePath;
        const sourceFile = this.plugin.app.vault.getMarkdownFiles().find(f => f.path === sourcePath);
        if (sourceFile) {
          const cache = this.plugin.app.metadataCache.getFileCache(sourceFile);
          frontmatter = cache?.frontmatter;
        }
      }
      if (frontmatter) {
        const ctx = { frontmatter };
        const result = evaluateLabel(rawLabel, ctx);
        label.labelEl.setText(result.error ? `⚠️ ${result.text}` : result.text);
        label.isDynamic = true;
        if (result.error) {
          console.warn(`[Graph Edge Notes] Expressão inválida em ${label.relation.sourcePath}: ${result.error}`);
        }
      } else {
        label.labelEl.setText(`⚠️ (sem frontmatter)`);
        label.isDynamic = true;
      }
    } else {
      label.labelEl.setText(rawLabel);
      label.isDynamic = false;
    }

    if (!label.labelEl.textContent || label.labelEl.textContent.trim() === "") {
      label.labelEl.style.display = "none";
    } else {
      label.labelEl.style.display = "";
    }
  }

  updateDynamicLabels(filePath: string): void {
    let updated = false;
    this.labels.forEach((label) => {
      if (label.relation.sourcePath === filePath && label.isDynamic) {
        this.applyLabelText(label);
        updated = true;
      }
    });
    if (updated) {
      this.plugin.debugLog(`Updated dynamic labels for ${filePath}`);
    }
  }

  private updateLabelPositions(): void {
    const renderer = this.currentRenderer;
    if (!renderer || !this.plugin.settings.showLabels) {
      return;
    }

    const linkMap = new Map<string, InternalGraphLink>();
    for (const link of renderer.links) {
      linkMap.set(this.makeEdgeKey(link.source.id, link.target.id), link);
    }

    this.labels.forEach((label) => {
      const liveLink = linkMap.get(this.makeEdgeKey(label.link.source.id, label.link.target.id));
      if (!liveLink) {
        label.labelEl.toggleClass("is-detached", true);
        if (this.activeHoveredLabelId === label.id) {
          this.activeHoveredLabelId = null;
        }
        this.hideHoverHighlight();
        this.hideTooltip();
        return;
      }

      label.link = liveLink;
      label.labelEl.toggleClass("is-detached", false);
      this.positionLabel(label, liveLink, renderer);
    });
  }

  private positionLabel(label: RenderedRelationLabel, link: InternalGraphLink, renderer: InternalGraphRenderer): void {
    const midX = (link.source.x + link.target.x) / 2;
    const midY = (link.source.y + link.target.y) / 2;
    const baseX = midX;
    const baseY = midY;

    let px = 1;
    let py = 0;

    const dx = link.target.x - link.source.x;
    const dy = link.target.y - link.source.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const edgeLengthPx = length * renderer.scale;
    if (length > 0.0001) {
      px = dx / length;
      py = dy / length;
    }

    this.applyLabelAppearance(label, renderer);
    const labelWidthPx = Math.max(label.widthPx, 44);
    const labelHeightPx = Math.max(label.heightPx, 20);
    const spreadStep = Math.max(labelWidthPx * 0.7, labelHeightPx * 1.2);
    const desiredSpread = (label.orderIndex - (label.totalOnEdge - 1) / 2) * spreadStep;
    const sourceNodeRadiusPx = this.getNodeRadiusCssPx(link.source, renderer);
    const targetNodeRadiusPx = this.getNodeRadiusCssPx(link.target, renderer);
    const sourceClearancePx = sourceNodeRadiusPx + labelHeightPx * 0.4 + 10;
    const targetClearancePx = targetNodeRadiusPx + labelHeightPx * 0.4 + 10;
    const minSpread = -Math.max(edgeLengthPx / 2 - targetClearancePx - labelWidthPx / 2, 0);
    const maxSpread = Math.max(edgeLengthPx / 2 - sourceClearancePx - labelWidthPx / 2, 0);
    const parallelSpreadPx = Math.min(Math.max(desiredSpread, minSpread), maxSpread);
    const availableTrackPx = edgeLengthPx - sourceClearancePx - targetClearancePx;

    const isVisible = availableTrackPx > Math.max(labelWidthPx * 0.6, 18);
    label.labelEl.toggleClass("is-hidden", !isVisible);
    if (!isVisible) {
      if (this.activeHoveredLabelId === label.id) {
        this.activeHoveredLabelId = null;
      }
      this.hideHoverHighlight();
      this.hideTooltip();
      return;
    }

    const parallelSpreadGraph = parallelSpreadPx / this.getCssScaleFactor(renderer);
    const graphX = baseX + px * parallelSpreadGraph;
    const graphY = baseY + py * parallelSpreadGraph;
    const screenPoint = this.graphToScreen(graphX, graphY, renderer);
    const rotation = this.getReadableEdgeAngle(dx, dy);
    label.labelEl.style.left = `${screenPoint.x}px`;
    label.labelEl.style.top = `${screenPoint.y}px`;
    label.labelEl.style.transform = `translate(-50%, -50%) rotate(${rotation}rad)`;
  }

  private syncActiveHoverHighlight(): void {
    const hoveredLabel = Array.from(this.labels.values()).find((item) => item.labelEl.matches(":hover"));
    if (!hoveredLabel) {
      this.activeHoveredLabelId = null;
      this.hideHoverHighlight();
      return;
    }

    this.activeHoveredLabelId = hoveredLabel.id;
    if (hoveredLabel.labelEl.classList.contains("is-hidden") || hoveredLabel.labelEl.classList.contains("is-detached")) {
      this.activeHoveredLabelId = null;
      this.hideHoverHighlight();
      return;
    }

    this.showHoverHighlight(hoveredLabel);
  }

  private showHoverHighlight(label: RenderedRelationLabel): void {
    const renderer = this.currentRenderer;
    const parent = this.getLabelParent(renderer) ?? this.currentHanger ?? this.currentStage;
    if (!label || !renderer || !parent) {
      return;
    }

    if (!this.hoverHighlightEl) {
      this.hoverHighlightEl = new Graphics();
      this.hoverHighlightEl.zIndex = 1.8;
    }

    if (!parent.children.includes(this.hoverHighlightEl)) {
      parent.addChild(this.hoverHighlightEl);
    }

    this.hoverHighlightEl.clear();
    this.drawHoverHighlight(label.link, renderer);
    this.applyInternalNodeHighlights(label.link, renderer);
    this.hoverHighlightEl.visible = true;
  }

  private hideHoverHighlight(): void {
    if (!this.hoverHighlightEl) {
      this.clearInternalNodeHighlights();
      return;
    }

    this.clearInternalNodeHighlights();
    this.hoverHighlightEl.clear();
    this.hoverHighlightEl.visible = false;
  }

  private destroyHoverHighlight(): void {
    const parent = this.currentHanger ?? this.currentStage;
    if (this.hoverHighlightEl && parent?.children.includes(this.hoverHighlightEl)) {
      parent.removeChild(this.hoverHighlightEl);
    }
    this.hoverHighlightEl?.destroy();
    this.hoverHighlightEl = null;
    this.clearInternalNodeHighlights();
  }

  private destroyLabels(preserveTooltip = false): void {
    if (!preserveTooltip) {
      this.hideTooltip();
    }
    this.hideOverlayHoverHighlight();
    this.clearInternalNodeHighlights();
    this.labels.forEach((label) => {
      label.labelEl.remove();
    });
    this.labels.clear();
  }

  getDebugSnapshot(): OverlayDebugSnapshot {
    return {
      activeGraphType: this.activeGraphType,
      totalGraphEdges: this.currentRenderer?.links.length ?? 0,
      renderedLabels: this.labels.size,
      dirty: this.dirty
    };
  }

  private ensureTooltip(): void {
    if (this.tooltipEl) {
      return;
    }
    this.tooltipEl = document.body.createDiv({ cls: "graph-edge-notes-tooltip is-hidden" });
  }

  private showTooltip(relation: ResolvedRelation, event: FederatedPointerEvent): void {
    if (!this.plugin.settings.showTooltip || !this.tooltipEl) {
      return;
    }

    const detail = relation.detail?.trim();
    this.tooltipEl.setText(detail || "No detail text yet.");
    this.tooltipEl.classList.remove("is-hidden");
    this.moveTooltip(event);
  }

  private moveTooltip(event: FederatedPointerEvent): void {
    if (!this.tooltipEl || this.tooltipEl.classList.contains("is-hidden")) {
      return;
    }

    const originalEvent = event.nativeEvent instanceof MouseEvent ? event.nativeEvent : null;
    if (!originalEvent) {
      this.tooltipEl.style.left = `${Math.max(window.innerWidth / 2 - 180, 16)}px`;
      this.tooltipEl.style.top = `${Math.max(window.innerHeight / 2 - 100, 16)}px`;
      return;
    }

    const desiredLeft = originalEvent.clientX + 18;
    const desiredTop = originalEvent.clientY + 18;
    const rect = this.tooltipEl.getBoundingClientRect();
    const maxLeft = Math.max(16, window.innerWidth - rect.width - 16);
    const maxTop = Math.max(16, window.innerHeight - rect.height - 16);
    this.tooltipEl.style.left = `${Math.min(desiredLeft, maxLeft)}px`;
    this.tooltipEl.style.top = `${Math.min(desiredTop, maxTop)}px`;
  }

  private hideTooltip(): void {
    this.tooltipEl?.classList.add("is-hidden");
  }

  private bindRenderer(renderer: InternalGraphRenderer, graphType: string, reason: string): void {
    const nextStage = this.getStage(renderer);
    const nextHanger = this.getHanger(renderer);
    const stageChanged = nextStage !== this.currentStage;
    this.destroyLabels();
    this.currentRenderer = renderer;
    this.currentStage = nextStage;
    this.currentHanger = nextHanger;
    this.activeGraphType = graphType;
    if (nextStage) {
      nextStage.sortableChildren = true;
    }
    if (nextHanger) {
      nextHanger.sortableChildren = true;
    }
    this.ensureHtmlOverlay(renderer);
    this.plugin.debugLog(`Attached to ${graphType} renderer during ${reason}${stageChanged ? " (stage changed)" : ""}`);
  }

  private getTextColor(): string {
    const value = getComputedStyle(document.body).getPropertyValue("--text-normal").trim();
    return value || "#d1d5db";
  }

  private getRelationColor(relation: ResolvedRelation): string {
    const color = this.plugin.settings.defaultLabelColor?.trim() || "";
    return color || this.getTextColor();
  }

  private getCssColor(variableName: string): string {
    const value = getComputedStyle(document.body).getPropertyValue(variableName).trim();
    return value || "";
  }

  private parseColorInt(color: string): number {
    const value = color.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(value)) {
      return parseInt(value.replace("#", ""), 16);
    }

    const scratch = document.createElement("canvas").getContext("2d");
    if (!scratch) {
      return 0xffffff;
    }
    scratch.fillStyle = value;
    const normalized = scratch.fillStyle.toString();
    const match = /^#([0-9a-fA-F]{6})$/.exec(normalized);
    return match?.[1] ? parseInt(match[1], 16) : 0xffffff;
  }

  private hideOverlayHoverHighlight(): void {
    if (!this.hoverHighlightEl) {
      return;
    }

    this.hoverHighlightEl.clear();
    this.hoverHighlightEl.visible = false;
  }

  private drawHoverHighlight(link: InternalGraphLink, renderer: InternalGraphRenderer): void {
    if (!this.hoverHighlightEl) {
      return;
    }

    const highlightColor = renderer.colors?.lineHighlight?.rgb ?? this.parseColorInt(this.getCssColor("--interactive-accent") || "#4f8ff7");
    const highlightAlpha = renderer.colors?.lineHighlight?.a ?? 0.95;
    const lineWidth = this.getHoverLineWidth(renderer);
    const sourceRadius = this.getNodeRadiusGraph(link.source, renderer);
    const targetRadius = this.getNodeRadiusGraph(link.target, renderer);
    const clipped = this.getClippedEdgePoints(link, sourceRadius, targetRadius);

    this.hoverHighlightEl.lineStyle(lineWidth, highlightColor, highlightAlpha);
    if (clipped) {
      this.hoverHighlightEl.moveTo(clipped.startX, clipped.startY);
      this.hoverHighlightEl.lineTo(clipped.endX, clipped.endY);
    }
  }

  private applyInternalNodeHighlights(link: InternalGraphLink, renderer: InternalGraphRenderer): void {
    this.clearInternalNodeHighlights();
    this.applyInternalNodeHighlight(link.source, renderer);
    this.applyInternalNodeHighlight(link.target, renderer);
  }

  private applyInternalNodeHighlight(node: InternalGraphLink["source"], renderer: InternalGraphRenderer): void {
    const circle = node.circle;
    const hanger = this.currentHanger;
    const fillHighlight = renderer.colors?.fillHighlight;
    const ringColor = renderer.colors?.circle;
    if (!circle || !hanger || !fillHighlight || !ringColor || this.highlightedNodes.has(node.id)) {
      return;
    }

    this.highlightedNodes.set(node.id, {
      node,
      originalTint: circle.tint,
      originalAlpha: circle.alpha
    });

    circle.tint = fillHighlight.rgb;
    circle.alpha = fillHighlight.a;

    let highlight = node.highlight;
    if (!highlight) {
      const created = new Graphics();
      created.eventMode = "none";
      created.zIndex = 1;
      hanger.addChild(created);
      highlight = created as unknown as typeof node.highlight;
      node.highlight = highlight;
    }

    if (highlight?.clear && highlight.lineStyle && highlight.drawCircle) {
      const radius = this.getNodeRadiusGraph(node, renderer);
      const lineWidth = Math.max(1, 1 / Math.max(renderer.scale * Math.max(renderer.nodeScale, 0.001), 0.001));
      highlight.x = node.x;
      highlight.y = node.y;
      if (highlight.scale) {
        highlight.scale.x = renderer.nodeScale;
        highlight.scale.y = renderer.nodeScale;
      }
      highlight.alpha = ringColor.a;
      highlight.clear();
      highlight.lineStyle(lineWidth, ringColor.rgb, 1);
      highlight.drawCircle(0, 0, radius + lineWidth / 2);
      if (typeof highlight.visible === "boolean") {
        highlight.visible = true;
      }
    }
  }

  private clearInternalNodeHighlights(): void {
    this.highlightedNodes.forEach(({ node, originalTint, originalAlpha }) => {
      if (node.circle) {
        node.circle.tint = originalTint;
        node.circle.alpha = originalAlpha;
      }
      const highlight = node.highlight;
      if (highlight?.clear) {
        highlight.clear();
      }
      if (typeof highlight?.visible === "boolean") {
        highlight.visible = false;
      }
    });
    this.highlightedNodes.clear();
  }

  private getClippedEdgePoints(
    link: InternalGraphLink,
    sourceRadius: number,
    targetRadius: number
  ): { startX: number; startY: number; endX: number; endY: number } | null {
    const dx = link.target.x - link.source.x;
    const dy = link.target.y - link.source.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length <= 0.0001) {
      return null;
    }

    const ux = dx / length;
    const uy = dy / length;
    const clearance = sourceRadius + targetRadius;
    if (length <= clearance) {
      return null;
    }

    return {
      startX: link.source.x + ux * sourceRadius,
      startY: link.source.y + uy * sourceRadius,
      endX: link.target.x - ux * targetRadius,
      endY: link.target.y - uy * targetRadius
    };
  }

  private applyLabelAppearance(label: RenderedRelationLabel, renderer: InternalGraphRenderer): void {
    const fontSizePx = Math.max(this.getLabelFontSize(label.link, renderer) * this.getCssScaleFactor(renderer), 11);
    label.labelEl.style.fontSize = `${fontSizePx}px`;
    label.labelEl.style.opacity = `${Math.max(this.plugin.settings.labelOpacity, 0.05)}`;
    label.labelEl.style.color = this.getRelationColor(label.relation);
    label.labelEl.style.padding = `${Math.max(fontSizePx * 0.18, 4)}px ${Math.max(fontSizePx * 0.28, 6)}px`;
    label.widthPx = Math.max(label.labelEl.offsetWidth, 68);
    label.heightPx = Math.max(label.labelEl.offsetHeight, 28);
  }

  private getLabelFontSize(link: InternalGraphLink, renderer: InternalGraphRenderer): number {
    const sourceFont = this.getNodeLabelFontSizeGraph(link.source, renderer);
    const targetFont = this.getNodeLabelFontSizeGraph(link.target, renderer);
    const averageNodeFont = (sourceFont + targetFont) / 2;
    return Math.max(averageNodeFont * this.plugin.settings.labelSizeRatio, 10);
  }

  private makeEdgeKey(sourceId: string, targetId: string): string {
    return `${sourceId}=>${targetId}`;
  }

  private getReadableEdgeAngle(dx: number, dy: number): number {
    let angle = Math.atan2(dy, dx);
    if (angle > Math.PI / 2) {
      angle -= Math.PI;
    } else if (angle < -Math.PI / 2) {
      angle += Math.PI;
    }
    return angle;
  }

  private getStage(renderer: InternalGraphRenderer | null | undefined): InternalGraphRenderer["px"]["stage"] | null {
    const stage = (renderer as { px?: { stage?: InternalGraphRenderer["px"]["stage"] | null } } | null | undefined)?.px?.stage;
    return stage ?? null;
  }

  private getHanger(renderer: InternalGraphRenderer | null | undefined): InternalGraphRenderer["hanger"] | null {
    return (renderer as { hanger?: InternalGraphRenderer["hanger"] | null } | null | undefined)?.hanger ?? null;
  }

  private getLabelParent(renderer: InternalGraphRenderer | null | undefined): InternalGraphRenderer["hanger"] | InternalGraphRenderer["px"]["stage"] | null {
    return this.getHanger(renderer) ?? this.getStage(renderer);
  }

  private getNodeRadiusCssPx(node: { weight?: number }, renderer: InternalGraphRenderer): number {
    return this.getNodeRadiusGraph(node, renderer) * this.getCssScaleFactor(renderer);
  }

  private getNodeRadiusGraph(node: { weight?: number }, renderer: InternalGraphRenderer): number {
    return this.getNodeSizeGraph(node, renderer) * renderer.nodeScale;
  }

  private getNodeSizeGraph(node: { weight?: number }, renderer: InternalGraphRenderer): number {
    const weight = typeof node.weight === "number" && Number.isFinite(node.weight) ? node.weight : 1;
    const baseSize = Math.max(8, Math.min(3 * Math.sqrt(weight + 1), 30));
    return baseSize * (renderer.fNodeSizeMult ?? 1);
  }

  private getNodeLabelFontSizeGraph(node: { weight?: number }, renderer: InternalGraphRenderer): number {
    return 14 + this.getNodeSizeGraph(node, renderer) / 4;
  }

  private getHoverLineWidth(renderer: InternalGraphRenderer): number {
    return Math.max(1.5 / Math.max(renderer.scale * Math.max(renderer.nodeScale, 0.001), 0.001), 1 / Math.max(renderer.scale, 0.001));
  }

  private getCssScaleFactor(renderer: InternalGraphRenderer): number {
    return (renderer.scale * renderer.nodeScale) / Math.max(window.devicePixelRatio || 1, 1);
  }

  private graphToScreen(x: number, y: number, renderer: InternalGraphRenderer): { x: number; y: number } {
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    return {
      x: (x * renderer.scale + renderer.panX) / dpr,
      y: (y * renderer.scale + renderer.panY) / dpr
    };
  }

  private ensureHtmlOverlay(renderer: InternalGraphRenderer | null | undefined): HTMLDivElement | null {
    const containerEl = (renderer as { containerEl?: HTMLElement | null } | null | undefined)?.containerEl ?? null;
    if (!containerEl) {
      return null;
    }

    if (this.htmlOverlayEl?.parentElement === containerEl) {
      return this.htmlOverlayEl;
    }

    this.destroyHtmlOverlay();
    this.htmlOverlayEl = containerEl.createDiv({ cls: "graph-edge-notes-label-layer" });
    return this.htmlOverlayEl;
  }

  private destroyHtmlOverlay(): void {
    this.htmlOverlayEl?.remove();
    this.htmlOverlayEl = null;
  }

  private createSyntheticPointerEvent(event: PointerEvent): FederatedPointerEvent {
    return {
      nativeEvent: event
    } as FederatedPointerEvent;
  }

  private findRenderer(): InternalGraphRenderer | null {
    const preferredRenderer = this.getRendererFromLeaf(this.preferredLeaf);
    if (preferredRenderer) {
      return preferredRenderer;
    }

    if (this.currentRenderer && this.isRenderer(this.currentRenderer)) {
      return this.currentRenderer;
    }

    const leafTypes = this.getEnabledLeafTypes();
    for (const type of leafTypes) {
      const leaves = this.plugin.app.workspace.getLeavesOfType(type);
      for (const leaf of leaves) {
        const renderer = this.getRendererFromLeaf(leaf);
        if (renderer) {
          return renderer;
        }
      }
    }

    return null;
  }

  private detectGraphTypeForRenderer(renderer: InternalGraphRenderer): string {
    for (const type of this.getEnabledLeafTypes()) {
      const leaves = this.plugin.app.workspace.getLeavesOfType(type);
      for (const leaf of leaves) {
        const maybeRenderer = (leaf.view as unknown as { renderer?: unknown }).renderer;
        if (maybeRenderer === renderer) {
          return type;
        }
      }
    }

    return "unknown";
  }

  private getEnabledLeafTypes(): string[] {
    const leafTypes: string[] = [];
    if (this.plugin.settings.enableGlobalGraph) {
      leafTypes.push("graph");
    }
    if (this.plugin.settings.enableLocalGraph) {
      leafTypes.push("localgraph");
    }
    return leafTypes;
  }

  private getRendererFromLeaf(leaf: unknown): InternalGraphRenderer | null {
    if (!leaf) {
      return null;
    }

    const typedLeaf = leaf as { view?: { getViewType?: () => string; renderer?: unknown; graph?: { renderer?: unknown }; graphRenderer?: unknown; visualization?: { renderer?: unknown } } };
    const viewType = typedLeaf.view?.getViewType?.();
    if (!viewType || !this.getEnabledLeafTypes().includes(viewType)) {
      return null;
    }

    const candidates = [
      typedLeaf.view?.renderer,
      typedLeaf.view?.graph?.renderer,
      typedLeaf.view?.graphRenderer,
      typedLeaf.view?.visualization?.renderer,
      (typedLeaf.view?.renderer as { renderer?: unknown } | undefined)?.renderer
    ];

    for (const candidate of candidates) {
      if (this.isRenderer(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private getLeafGraphType(leaf: unknown): string | null {
    if (!leaf) {
      return null;
    }

    const typedLeaf = leaf as { view?: { getViewType?: () => string } };
    const viewType = typedLeaf.view?.getViewType?.();
    return viewType && this.getEnabledLeafTypes().includes(viewType) ? viewType : null;
  }

  private describeLeafState(): string {
    const graphLeaves = this.plugin.app.workspace.getLeavesOfType("graph").length;
    const localGraphLeaves = this.plugin.app.workspace.getLeavesOfType("localgraph").length;
    const preferredLeafType = this.getLeafGraphType(this.preferredLeaf) ?? "none";
    return `preferredLeaf=${preferredLeafType}, graphLeaves=${graphLeaves}, localGraphLeaves=${localGraphLeaves}, preferredLeafTracked=${this.preferredLeaf ? "set" : "unset"}`;
  }

  private isRenderer(renderer: unknown): renderer is InternalGraphRenderer {
    const maybeRenderer = renderer as Partial<InternalGraphRenderer> | null;
    return Boolean(
      maybeRenderer &&
        maybeRenderer.px &&
        maybeRenderer.px.stage &&
        typeof maybeRenderer.px.stage.addChild === "function" &&
        typeof maybeRenderer.px.stage.removeChild === "function" &&
        Array.isArray(maybeRenderer.links) &&
        typeof maybeRenderer.nodeScale === "number" &&
        typeof maybeRenderer.panX === "number" &&
        typeof maybeRenderer.panY === "number" &&
        typeof maybeRenderer.scale === "number"
    );
  }
}
