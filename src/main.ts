import { Notice, Plugin, Setting, TFile, setIcon } from "obsidian";
import { GraphOverlayController, OverlayDebugSnapshot } from "./graphOverlay";
import { t } from "./i18n";
import { RelationStore } from "./relationStore";
import { GraphEdgeNotesSettingTab } from "./settings";
import { RelationEditorModal } from "./ui/relationEditorModal";
import { DEFAULT_SETTINGS, GraphEdgeNotesSettings, ResolvedRelation } from "./types";

export default class GraphEdgeNotesPlugin extends Plugin {
  settings: GraphEdgeNotesSettings = DEFAULT_SETTINGS;
  relationStore!: RelationStore;
  private overlay!: GraphOverlayController;
  private controlsObserver: MutationObserver | null = null;
  private debugPanelEl: HTMLDivElement | null = null;
  private debugHeaderEl: HTMLDivElement | null = null;
  private debugLogEl: HTMLDivElement | null = null;
  private debugLogs: string[] = [];
  private debugFlushTimer: number | null = null;
  private readonly debugLogPath = `.obsidian/plugins/graph-edge-notes/debug.log`;
  private metadataChangeDebounce = new Map<string, number>();

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.syncDebugStorage();

    this.relationStore = new RelationStore(this);
    this.overlay = new GraphOverlayController(this);

    this.addSettingTab(new GraphEdgeNotesSettingTab(this.app, this));
    this.registerCommands();
    this.registerEvents();

    if (this.app.workspace.layoutReady) {
      this.overlay.activate();
      this.installGraphControlSections();
    } else {
      this.app.workspace.onLayoutReady(() => {
        this.overlay.activate();
        this.installGraphControlSections();
      });
    }

    this.startControlsObserver();
  }

  onunload(): void {
    this.overlay?.destroy();
    this.controlsObserver?.disconnect();
    this.controlsObserver = null;
    document.querySelectorAll(".graph-control-section.mod-edge-note").forEach((el) => el.remove());
    this.debugPanelEl?.remove();
    if (this.debugFlushTimer !== null) {
      window.clearTimeout(this.debugFlushTimer);
      this.debugFlushTimer = null;
    }
    void this.syncDebugStorage();
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<GraphEdgeNotesSettings> & { fontSize?: number } | null;
    const migratedSettings: GraphEdgeNotesSettings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
    if ((raw?.labelSizeRatio === undefined || raw.labelSizeRatio === null) && typeof raw?.fontSize === "number") {
      migratedSettings.labelSizeRatio = Math.min(Math.max(raw.fontSize / 28, 0.6), 1.8);
    }
    this.settings = migratedSettings;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.installGraphControlSections(true);
  }

  async handleDebugModeChange(): Promise<void> {
    await this.syncDebugStorage();
    this.refreshGraphOverlay("debug mode toggled", true);
  }

  refreshGraphOverlay(reason = "refresh", force = false): void {
    this.debugLog(`refreshGraphOverlay(reason=${reason}, force=${force ? "yes" : "no"})`);
    if (force) {
      this.overlay.forceRefresh(reason);
    } else {
      this.overlay.requestRebuild(reason);
    }
    this.updateDebugStatus(this.overlay.getDebugSnapshot());
  }

  updateDebugStatus(snapshot: OverlayDebugSnapshot): void {
    if (!this.settings.debugMode) {
      this.debugPanelEl?.remove();
      this.debugPanelEl = null;
      this.debugHeaderEl = null;
      this.debugLogEl = null;
      return;
    }

    this.ensureDebugPanel();
    if (this.debugHeaderEl) {
      this.debugHeaderEl.setText(
        `Graph: ${snapshot.activeGraphType} | edges: ${snapshot.totalGraphEdges} | labels: ${snapshot.renderedLabels} | dirty: ${snapshot.dirty ? "yes" : "no"}`
      );
    }
  }

  debugLog(message: string): void {
    if (!this.settings.debugMode) {
      return;
    }

    const timestamp = new Date().toLocaleTimeString();
    this.debugLogs.unshift(`[${timestamp}] ${message}`);
    this.debugLogs = this.debugLogs.slice(0, 200);
    this.ensureDebugPanel();
    this.renderDebugLogs();
    this.scheduleDebugFlush();
  }

  openRelationEditor(sourcePath: string, relation?: ResolvedRelation): void {
    new RelationEditorModal(this.relationStore, {
      sourcePath,
      relation,
      onComplete: () => this.refreshGraphOverlay("relation edited", true)
    }).open();
  }

  private registerCommands(): void {
    this.addCommand({
      id: "add-relation-to-current-note",
      name: "Add graph relation to current note",
      checkCallback: (checking) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!(activeFile instanceof TFile)) {
          return false;
        }

        if (!checking) {
          this.openRelationEditor(activeFile.path);
        }

        return true;
      }
    });

    this.addCommand({
      id: "refresh-overlay",
      name: "Refresh edge labels overlay",
      callback: () => {
        this.refreshGraphOverlay("command refresh", true);
        new Notice("Graph edge notes refreshed");
      }
    });
  }

  private registerEvents(): void {
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.refreshGraphOverlay("layout change");
        this.installGraphControlSections();
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const isGraphLeaf = this.overlay.handleActiveLeafChange(leaf);
        this.refreshGraphOverlay(isGraphLeaf ? "active graph leaf change" : "active non-graph leaf change", isGraphLeaf);
        this.installGraphControlSections();
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.handleMetadataChange(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", () => {
        this.refreshGraphOverlay("file renamed", false);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", () => {
        this.refreshGraphOverlay("file deleted", false);
      })
    );

    this.registerDomEvent(window, "blur", () => {
      this.overlay.hideTooltipExternally();
    });

    this.registerDomEvent(document, "pointerdown", (event) => {
      this.overlay.handleGlobalPointerDown(event);
    });

    this.registerDomEvent(document, "pointermove", (event) => {
      this.overlay.handleGlobalPointerMove(event);
    });

    this.registerDomEvent(document, "pointerleave", () => {
      this.overlay.handleGlobalPointerLeave();
    });
  }

  private handleMetadataChange(file: TFile): void {
    const path = file.path;
    
    // Debounce: cancela timeout anterior se existir
    const existing = this.metadataChangeDebounce.get(path);
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }
    
    // Novo timeout de 300ms
    const timeout = window.setTimeout(() => {
      this.metadataChangeDebounce.delete(path);
      this.overlay.updateDynamicLabels(path);
    }, 300);
    
    this.metadataChangeDebounce.set(path, timeout);
    
    // Também faz rebuild normal para outros casos
    this.refreshGraphOverlay("metadata changed", false);
  }

  private ensureDebugPanel(): void {
    if (this.debugPanelEl) {
      return;
    }

    this.debugPanelEl = document.body.createDiv({ cls: "graph-edge-notes-debug-panel" });
    this.debugHeaderEl = this.debugPanelEl.createDiv({ cls: "graph-edge-notes-debug-header" });
    this.debugLogEl = this.debugPanelEl.createDiv({ cls: "graph-edge-notes-debug-log" });
    this.renderDebugLogs();
  }

  private renderDebugLogs(): void {
    if (!this.debugLogEl) {
      return;
    }

    this.debugLogEl.empty();
    if (this.debugLogs.length === 0) {
      this.debugLogEl.createDiv({ text: "No debug events yet." });
      return;
    }

    for (const line of this.debugLogs) {
      this.debugLogEl.createDiv({ text: line });
    }
  }

  private scheduleDebugFlush(): void {
    if (!this.settings.debugMode) {
      return;
    }

    if (this.debugFlushTimer !== null) {
      return;
    }

    this.debugFlushTimer = window.setTimeout(() => {
      this.debugFlushTimer = null;
      void this.flushDebugLog();
    }, 250);
  }

  private async flushDebugLog(): Promise<void> {
    if (!this.settings.debugMode) {
      return;
    }

    try {
      await this.app.vault.adapter.write(this.debugLogPath, this.debugLogs.join("\n"));
    } catch (error) {
      console.error("Graph Edge Notes debug log flush failed", error);
    }
  }

  private async syncDebugStorage(): Promise<void> {
    if (this.settings.debugMode) {
      this.debugLogs = [];
      await this.flushDebugLog();
      return;
    }

    this.debugPanelEl?.remove();
    this.debugPanelEl = null;
    this.debugHeaderEl = null;
    this.debugLogEl = null;
    this.debugLogs = [];

    if (this.debugFlushTimer !== null) {
      window.clearTimeout(this.debugFlushTimer);
      this.debugFlushTimer = null;
    }

    try {
      const exists = await this.app.vault.adapter.exists(this.debugLogPath);
      if (exists) {
        await this.app.vault.adapter.remove(this.debugLogPath);
      }
    } catch (error) {
      console.error("Graph Edge Notes debug log cleanup failed", error);
    }
  }

  private startControlsObserver(): void {
    this.controlsObserver?.disconnect();
    this.controlsObserver = new MutationObserver(() => {
      this.installGraphControlSections();
    });

    this.controlsObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  private installGraphControlSections(forceRebuild = false): void {
    const controlsList = Array.from(document.querySelectorAll<HTMLElement>(".graph-controls"));
    for (const controlsEl of controlsList) {
      const existing = controlsEl.querySelector<HTMLElement>(".graph-control-section.mod-edge-note");
      if (existing && !forceRebuild) {
        continue;
      }

      existing?.remove();
      this.createGraphControlSection(controlsEl);
    }
  }

  private createGraphControlSection(controlsEl: HTMLElement): void {
    const i18n = t();
    const sectionEl = createDiv({ cls: "tree-item graph-control-section mod-edge-note" });
    const selfEl = sectionEl.createDiv({ cls: "tree-item-self mod-collapsible is-clickable" });
    const collapseEl = selfEl.createDiv({ cls: "tree-item-icon collapse-icon" });
    setIcon(collapseEl, "right-triangle");
    const innerEl = selfEl.createDiv({ cls: "tree-item-inner" });
    innerEl.createEl("header", {
      cls: "graph-control-section-header",
      text: i18n.graphSectionTitle
    });
    selfEl.dataset.ignoreSwipe = "true";

    const bodyEl = sectionEl.createDiv({ cls: "tree-item-children graph-edge-notes-controls" });
    const applyCollapsedState = (): void => {
      sectionEl.toggleClass("is-collapsed", this.settings.graphControlsCollapsed);
      collapseEl.toggleClass("is-collapsed", this.settings.graphControlsCollapsed);
      bodyEl.toggleClass("is-hidden", this.settings.graphControlsCollapsed);
    };
    applyCollapsedState();
    selfEl.addEventListener("click", (event) => {
      if (event.button !== 0) {
        return;
      }
      this.settings.graphControlsCollapsed = !this.settings.graphControlsCollapsed;
      applyCollapsedState();
      void this.saveData(this.settings);
    });

    new Setting(bodyEl)
      .setName(i18n.showAnnotationsName)
      .addToggle((toggle) => {
        toggle.setValue(this.settings.showLabels).onChange(async (value: boolean) => {
          this.settings.showLabels = value;
          await this.saveSettings();
          this.refreshGraphOverlay("graph controls show annotations changed", true);
        });
      });

    new Setting(bodyEl)
      .setName(i18n.showDetailOnHoverName)
      .addToggle((toggle) => {
        toggle.setValue(this.settings.showTooltip).onChange(async (value: boolean) => {
          this.settings.showTooltip = value;
          await this.saveSettings();
          this.refreshGraphOverlay("graph controls show detail changed", true);
        });
      });

    new Setting(bodyEl)
      .setName(i18n.graphFontSizeName)
      .addSlider((slider) => {
        slider
          .setLimits(0.6, 1.8, 0.05)
          .setValue(this.settings.labelSizeRatio)
          .setDynamicTooltip()
          .onChange(async (value: number) => {
            this.settings.labelSizeRatio = value;
            await this.saveSettings();
            this.refreshGraphOverlay("graph controls font size changed", true);
          });
      });

    new Setting(bodyEl)
      .setName(i18n.graphOpacityName)
      .addSlider((slider) => {
        slider
          .setLimits(0.2, 1, 0.05)
          .setValue(this.settings.labelOpacity)
          .setDynamicTooltip()
          .onChange(async (value: number) => {
            this.settings.labelOpacity = value;
            await this.saveSettings();
            this.refreshGraphOverlay("graph controls opacity changed", true);
          });
      });

    new Setting(bodyEl)
      .setName(i18n.graphColorName)
      .addText((text) => {
        text
          .setPlaceholder("#7c3aed")
          .setValue(this.settings.defaultLabelColor)
          .onChange(async (value: string) => {
            this.settings.defaultLabelColor = value.trim();
            await this.saveSettings();
            this.refreshGraphOverlay("graph controls color changed", true);
          });
      });

    const displaySection = controlsEl.querySelector(".graph-control-section.mod-display");
    const forceSection = controlsEl.querySelector(".graph-control-section.mod-forces");
    if (displaySection?.parentElement === controlsEl) {
      displaySection.insertAdjacentElement("afterend", sectionEl);
    } else if (forceSection?.parentElement === controlsEl) {
      controlsEl.insertBefore(sectionEl, forceSection);
    } else {
      controlsEl.appendChild(sectionEl);
    }
  }
}
