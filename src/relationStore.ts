import { App, Notice, TFile } from "obsidian";
import type GraphEdgeNotesPlugin from "./main";
import { RelationInput, ResolvedRelation } from "./types";

type FrontmatterRecord = Record<string, unknown>;

export class RelationStore {
  private readonly app: App;

  constructor(private readonly plugin: GraphEdgeNotesPlugin) {
    this.app = plugin.app;
  }

  getApp(): App {
    return this.app;
  }

  getRelationPropertyName(): string {
    const value = this.plugin.settings.relationProperty;
    return typeof value === "string" && value.trim() ? value.trim() : "relations";
  }

  getRelationsForConnection(pathA: string, pathB: string): ResolvedRelation[] {
    const resolvedA = this.resolveNodePath(pathA);
    const resolvedB = this.resolveNodePath(pathB);

    if (!resolvedA || !resolvedB) {
      return [];
    }

    return [
      ...this.getRelationsBetween(resolvedA, resolvedB),
      ...this.getRelationsBetween(resolvedB, resolvedA)
    ];
  }

  getCleanTargetInput(rawTarget: string): string {
    let value = rawTarget.trim();

    if (value.startsWith("[[") && value.endsWith("]]")) {
      value = value.slice(2, -2);
    }

    const pipeIndex = value.indexOf("|");
    if (pipeIndex >= 0) {
      value = value.slice(0, pipeIndex);
    }

    const headingIndex = value.indexOf("#");
    if (headingIndex >= 0) {
      value = value.slice(0, headingIndex);
    }

    if (value.endsWith(".md")) {
      value = value.slice(0, -3);
    }

    return value.trim();
  }

  async addRelation(sourcePath: string, relation: RelationInput): Promise<void> {
    const file = this.getFile(sourcePath);
    if (!file) {
      throw new Error(`Source file not found: ${sourcePath}`);
    }

    const prepared = this.prepareRelationForSave(sourcePath, relation);

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const relations = this.getMutableRelationsArray(frontmatter);
      relations.push(prepared);
      frontmatter[this.getRelationPropertyName()] = relations;
    });
  }

  async updateRelation(sourcePath: string, index: number, relation: RelationInput): Promise<void> {
    const file = this.getFile(sourcePath);
    if (!file) {
      throw new Error(`Source file not found: ${sourcePath}`);
    }

    const prepared = this.prepareRelationForSave(sourcePath, relation);

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const relations = this.getMutableRelationsArray(frontmatter);
      if (index < 0 || index >= relations.length) {
        throw new Error(`Relation index out of range: ${index}`);
      }
      relations[index] = prepared;
      frontmatter[this.getRelationPropertyName()] = relations;
    });
  }

  async deleteRelation(sourcePath: string, index: number): Promise<void> {
    const file = this.getFile(sourcePath);
    if (!file) {
      throw new Error(`Source file not found: ${sourcePath}`);
    }

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const relations = this.getMutableRelationsArray(frontmatter);
      if (index < 0 || index >= relations.length) {
        throw new Error(`Relation index out of range: ${index}`);
      }
      relations.splice(index, 1);

      if (relations.length === 0) {
        delete frontmatter[this.getRelationPropertyName()];
      } else {
        frontmatter[this.getRelationPropertyName()] = relations;
      }
    });
  }

  notifySaveError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`Graph Edge Notes: ${message}`);
  }

  private getRelationsBetween(sourcePath: string, targetPath: string): ResolvedRelation[] {
    const sourceFile = this.getFile(sourcePath);
    if (!sourceFile) {
      return [];
    }

    const cache = this.app.metadataCache.getFileCache(sourceFile);
    const frontmatter = cache?.frontmatter;
    const rawRelations = frontmatter?.[this.getRelationPropertyName()];
    if (!Array.isArray(rawRelations)) {
      return [];
    }

    const result: ResolvedRelation[] = [];

    rawRelations.forEach((rawRelation, index) => {
      const parsed = this.parseRawRelation(rawRelation, sourceFile.path, index);
      if (!parsed) {
        return;
      }

      if (parsed.targetPath === targetPath) {
        result.push({
          ...parsed,
          sourceFrontmatter: frontmatter as Record<string, any>
        });
      }
    });

    return result;
  }

  private parseRawRelation(rawRelation: unknown, sourcePath: string, index: number): ResolvedRelation | null {
    if (typeof rawRelation === "string") {
      return this.parseStringRelation(rawRelation, sourcePath, index);
    }

    if (!rawRelation || typeof rawRelation !== "object" || Array.isArray(rawRelation)) {
      return null;
    }

    const relation = rawRelation as FrontmatterRecord;
    const target = typeof relation.target === "string" ? relation.target.trim() : "";
    const label = typeof relation.label === "string" ? relation.label.trim() : "";
    const detail = typeof relation.detail === "string" ? relation.detail.trim() : "";
    if (!target || !label) {
      return null;
    }

    return this.buildParsedRelation(sourcePath, index, target, label, detail);
  }

  private parseStringRelation(rawRelation: string, sourcePath: string, index: number): ResolvedRelation | null {
    const value = rawRelation.trim();
    const match = /^\("((?:[^"\\]|\\.)*)"\)\s*\[\[([^\]]+)\]\]\s*(?:\("((?:[^"\\]|\\.)*)"\)|<\("((?:[^"\\]|\\.)*"\)>))?$/u.exec(value);
    if (!match) {
      return null;
    }

    const [, encodedLabel = "", rawTarget = "", encodedDetailA = "", encodedDetailB = ""] = match;
    return this.buildParsedRelation(
      sourcePath,
      index,
      `[[${rawTarget.trim()}]]`,
      this.decodeRelationText(encodedLabel),
      this.decodeRelationText(encodedDetailA ?? encodedDetailB ?? "")
    );
  }

  private buildParsedRelation(
    sourcePath: string,
    index: number,
    target: string,
    label: string,
    detail?: string
  ): ResolvedRelation | null {
    const cleanTarget = this.getCleanTargetInput(target);
    const targetFile = this.app.metadataCache.getFirstLinkpathDest(cleanTarget, sourcePath);
    if (!targetFile) {
      return null;
    }

    return {
      sourcePath,
      target,
      label,
      detail: detail || undefined,
      targetPath: targetFile.path,
      targetDisplay: targetFile.basename,
      index,
      key: `${sourcePath}::${targetFile.path}::${index}`
    };
  }

  private encodeRelationText(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private decodeRelationText(value: string): string {
    return value ? value.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : "";
  }

  private prepareRelationForSave(sourcePath: string, relation: RelationInput): string {
    const label = relation.label.trim();
    const cleanTarget = this.getCleanTargetInput(relation.target);
    const detail = relation.detail?.trim();

    if (!label) {
      throw new Error("Relation label cannot be empty");
    }

    if (!cleanTarget) {
      throw new Error("Relation target cannot be empty");
    }

    const targetFile = this.app.metadataCache.getFirstLinkpathDest(cleanTarget, sourcePath);
    if (!targetFile) {
      throw new Error(`Could not resolve target note: ${cleanTarget}`);
    }

    const base = `(\"${this.encodeRelationText(label)}\")[[${cleanTarget}]]`;
    return detail ? `${base}(\"${this.encodeRelationText(detail)}\")` : base;
  }

  private getMutableRelationsArray(frontmatter: FrontmatterRecord): Array<string | FrontmatterRecord> {
    const current = frontmatter[this.getRelationPropertyName()];
    if (!Array.isArray(current)) {
      return [];
    }

    return [...current];
  }

  private getFile(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  private resolveNodePath(nodeId: string): string | null {
    const direct = this.getFile(nodeId);
    if (direct) {
      return direct.path;
    }

    const withExtension = this.getFile(`${nodeId}.md`);
    if (withExtension) {
      return withExtension.path;
    }

    const fromLinkpath = this.app.metadataCache.getFirstLinkpathDest(nodeId, "");
    if (fromLinkpath) {
      return fromLinkpath.path;
    }

    const basenameMatch = this.app.vault
      .getMarkdownFiles()
      .find((file) => file.basename === nodeId || file.path === nodeId);

    return basenameMatch?.path ?? null;
  }
}
