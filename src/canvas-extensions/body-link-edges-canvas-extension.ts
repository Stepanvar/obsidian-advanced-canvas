import { TFile } from "obsidian"
import CanvasExtension from "./canvas-extension"
import { Canvas, CanvasNode, CanvasEdge } from "src/@types/Canvas"
import { CanvasEdgeData } from "src/@types/AdvancedJsonCanvas"
import BBoxHelper from "src/utils/bbox-helper"
import CanvasHelper from "src/utils/canvas-helper"

const BODY_EDGE_ID_PREFIX = "ble"
const BULLET_LINK_REGEX = /^\s*-\s*\[([^\]]+)\]\s*\[\[([^\]]+)\]\]/

export default class BodyLinkEdgesCanvasExtension extends CanvasExtension {
  isEnabled() { return 'bodyLinkEdgesFeatureEnabled' }

  init() {
    this.plugin.registerEvent(this.plugin.app.vault.on('modify', (file: TFile) => {
      for (const canvas of this.plugin.getCanvases())
        this.onFileModified(canvas, file)
    }))

    this.plugin.registerEvent(this.plugin.app.workspace.on(
      'advanced-canvas:node-added',
      (canvas: Canvas, node: CanvasNode) => this.onNodeChanged(canvas, node)
    ))

    this.plugin.registerEvent(this.plugin.app.workspace.on(
      'advanced-canvas:node-changed',
      (canvas: Canvas, node: CanvasNode) => this.onNodeChanged(canvas, node)
    ))

    this.plugin.registerEvent(this.plugin.app.workspace.on(
      'advanced-canvas:edge-added',
      (canvas: Canvas, edge: CanvasEdge) => this.onEdgeChanged(canvas, edge)
    ))

    this.plugin.registerEvent(this.plugin.app.workspace.on(
      'advanced-canvas:edge-changed',
      (canvas: Canvas, edge: CanvasEdge) => this.onEdgeChanged(canvas, edge)
    ))

    this.plugin.registerEvent(this.plugin.app.workspace.on(
      'advanced-canvas:edge-removed',
      (canvas: Canvas, edge: CanvasEdge) => this.onEdgeRemoved(canvas, edge)
    ))
  }

  private async onFileModified(canvas: Canvas, file: TFile) {
    for (const node of canvas.nodes.values()) {
      if (node.getData().type !== 'file' || node.file?.path !== file.path) continue
      await this.updateBodyEdges(canvas, node)
    }
  }

  private async onNodeChanged(canvas: Canvas, _node: CanvasNode) {
    for (const node of canvas.nodes.values()) {
      if (node.getData().type !== 'file') continue
      await this.updateBodyEdges(canvas, node)
    }
  }

  private async onEdgeChanged(canvas: Canvas, edge: CanvasEdge) {
    const edgeData = edge.getData()
    const from = edge.from.node
    const to = edge.to.node
    if (from.getData().type !== 'file' || to.getData().type !== 'file') return
    if (!edgeData.label) return
    if (!from.file || !to.file) return

    const linktext = this.plugin.app.metadataCache.fileToLinktext(to.file, from.file.path)
    const line = `- [${edgeData.label}] [[${linktext}]]`
    let content = await this.plugin.app.vault.cachedRead(from.file)
    if (!content.split(/\n/).some(l => l.trim() === line.trim())) {
      if (!content.endsWith('\n')) content += '\n'
      content += line + '\n'
      await this.plugin.app.vault.modify(from.file, content)
    }
  }

  private async onEdgeRemoved(canvas: Canvas, edge: CanvasEdge) {
    const edgeData = edge.getData()
    const from = edge.from.node
    const to = edge.to.node
    if (from.getData().type !== 'file' || to.getData().type !== 'file') return
    if (!from.file || !to.file) return

    const linktext = this.plugin.app.metadataCache.fileToLinktext(to.file, from.file.path)
    const line = `- [${edgeData.label ?? ''}] [[${linktext}]]`
    let content = await this.plugin.app.vault.cachedRead(from.file)
    const lines = content.split(/\n/)
    const filtered = lines.filter(l => l.trim() !== line.trim())
    if (lines.length !== filtered.length) {
      await this.plugin.app.vault.modify(from.file, filtered.join('\n'))
    }
  }

  private async updateBodyEdges(canvas: Canvas, node: CanvasNode) {
    const edges = await this.getBodyEdges(canvas, node)
    const newEdges = Array.from(edges.values()).filter(edge => !canvas.edges.has(edge.id))
    canvas.importData({ nodes: [], edges: newEdges }, false, false)
    for (const edge of canvas.edges.values()) {
      if (edge.id.startsWith(`${BODY_EDGE_ID_PREFIX}${node.id}`) && !edges.has(edge.id))
        canvas.removeEdge(edge)
    }
  }

  private async getBodyEdges(canvas: Canvas, node: CanvasNode): Promise<Map<string, CanvasEdgeData>> {
    if (!node.file) return new Map()
    const canvasFile = canvas.view.file
    if (!canvasFile) return new Map()

    const content = await this.plugin.app.vault.cachedRead(node.file)
    const lines = content.split(/\n/)
    const nodes = Array.from(canvas.nodes.values())
    const edges: Map<string, CanvasEdgeData> = new Map()
    let idx = 0

    for (const line of lines) {
      const match = line.match(BULLET_LINK_REGEX)
      if (!match) continue
      const label = match[1].trim()
      const link = match[2].split('|')[0].trim()
      const targetFile = this.plugin.app.metadataCache.getFirstLinkpathDest(link, canvasFile.path)
      const targetNode = nodes.find(n => n.id !== node.id && n.getData().type === 'file' && n.file?.path === targetFile?.path)
      if (!targetNode) continue

      const edgeId = `${BODY_EDGE_ID_PREFIX}${node.id}${targetNode.id}-${idx++}`
      const bestFromSide = CanvasHelper.getBestSideForFloatingEdge(BBoxHelper.getCenterOfBBoxSide(targetNode.getBBox(), 'right'), node)
      const bestToSide = CanvasHelper.getBestSideForFloatingEdge(BBoxHelper.getCenterOfBBoxSide(node.getBBox(), 'left'), targetNode)

      edges.set(edgeId, {
        id: edgeId,
        fromNode: node.id,
        fromSide: bestFromSide,
        fromFloating: true,
        toNode: targetNode.id,
        toSide: bestToSide,
        toFloating: true,
        label
      })
    }

    return edges
  }
}
