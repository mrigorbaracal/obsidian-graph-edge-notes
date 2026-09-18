export interface RelationInput {
  target: string;
  label: string;
  detail?: string;
}

export interface ResolvedRelation extends RelationInput {
  sourcePath: string;
  targetPath: string;
  targetDisplay: string;
  index: number;
  key: string;
  sourceFrontmatter?: Record<string, any>;
}

export interface GraphEdgeNotesSettings {
  relationProperty: string;
  enableGlobalGraph: boolean;
  enableLocalGraph: boolean;
  showLabels: boolean;
  showTooltip: boolean;
  graphControlsCollapsed: boolean;
  debugMode: boolean;
  labelSizeRatio: number;
  labelOpacity: number;
  rebuildEveryNFrames: number;
  defaultLabelColor: string;
}

export const DEFAULT_SETTINGS: GraphEdgeNotesSettings = {
  relationProperty: "relations",
  enableGlobalGraph: true,
  enableLocalGraph: true,
  showLabels: true,
  showTooltip: true,
  graphControlsCollapsed: true,
  debugMode: false,
  labelSizeRatio: 1,
  labelOpacity: 0.9,
  rebuildEveryNFrames: 20,
  defaultLabelColor: ""
};
