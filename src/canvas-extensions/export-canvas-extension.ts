import * as HtmlToImage from 'html-to-image'
import { Modal, Notice, Setting } from "obsidian"
import { BBox, Canvas, CanvasNode } from "src/@types/Canvas"
import BBoxHelper from "src/utils/bbox-helper"
import CanvasHelper from "src/utils/canvas-helper"
import CanvasExtension from "./canvas-extension"

const MAX_ALLOWED_LOADING_TIME = 10_000

export default class ExportCanvasExtension extends CanvasExtension {
  isEnabled() { return 'betterExportFeatureEnabled' }

  init() {
    this.plugin.registerEvent(this.plugin.app.workspace.on(
      'advanced-canvas:node-breakpoint-changed',
      (canvas: Canvas, node: CanvasNode, breakpointRef: { value: boolean }) => {
        if (canvas.screenshotting) breakpointRef.value = true
      }
    ))
    
    this.plugin.addCommand({
      id: 'export-all-as-image',
      name: 'Export canvas as image',
      checkCallback: CanvasHelper.canvasCommand(
        this.plugin,
        (canvas: Canvas) => canvas.nodes.size > 0,
        (canvas: Canvas) => this.showExportImageSettingsModal(canvas, null)
      )
    })

    this.plugin.addCommand({
      id: 'export-selected-as-image',
      name: 'Export selected nodes as image',
      checkCallback: CanvasHelper.canvasCommand(
        this.plugin,
        (canvas: Canvas) => canvas.selection.size > 0,
        (canvas: Canvas) => this.showExportImageSettingsModal(
          canvas, 
          canvas.getSelectionData().nodes
            .map(nodeData => canvas.nodes.get(nodeData.id))
            .filter(node => node !== undefined) as CanvasNode[]
        )
      )
    })
  }

  private async showExportImageSettingsModal(canvas: Canvas, nodesToExport: CanvasNode[] | null) {
    const modal = new Modal(this.plugin.app)
    modal.setTitle('Export image settings')

    // Create ref to dynamic settings
    let pixelRatioSetting: Setting | null = null
    let noFontExportSetting: Setting | null = null
    let transparentBackgroundSetting: Setting | null = null
    const updateDynamicSettings = () => {
      if (svg) {
        pixelRatioSetting?.settingEl?.hide()
        noFontExportSetting?.settingEl?.show()
        transparentBackgroundSetting?.settingEl?.hide()
      } else {
        pixelRatioSetting?.settingEl?.show()
        noFontExportSetting?.settingEl?.hide()
        transparentBackgroundSetting?.settingEl?.show()
      }
    }

    let svg = false
    new Setting(modal.contentEl)
      .setName('Export file format')
      .setDesc('Choose the file format to export the canvas as.')
      .addDropdown(dropdown => dropdown
        .addOptions({
          png: 'PNG',
          svg: 'SVG'
        })
        .setValue(svg ? 'svg' : 'png')
        .onChange(value => {
          svg = value === 'svg'
          updateDynamicSettings()
        })
      )

    let pixelRatioFactor = 1
    pixelRatioSetting = new Setting(modal.contentEl)
      .setName('Pixel ratio')
      .setDesc('Higher pixel ratios result in higher resolution images but also larger file sizes.')
      .addSlider(slider => slider
        .setDynamicTooltip()
        .setLimits(0.2, 5, 0.1)
        .setValue(pixelRatioFactor)
        .onChange(value => pixelRatioFactor = value)
      )
    
    let noFontExport = true
    noFontExportSetting = new Setting(modal.contentEl)
      .setName('Skip font export')
      .setDesc('This will not include the fonts in the exported SVG. This will make the SVG file smaller.')
      .addToggle(toggle => toggle
        .setValue(noFontExport)
        .onChange(value => noFontExport = value)
      )

    let watermark = false
    new Setting(modal.contentEl)
      .setName('Show logo')
      .setDesc('This will add an Obsidian + Advanced Canvas logo to the bottom left.')
      .addToggle(toggle => toggle
        .setValue(watermark)
        .onChange(value => watermark = value)
      )

    let garbledText = false
    new Setting(modal.contentEl)
      .setName('Privacy mode')
      .setDesc('This will obscure any text on your canvas.')
      .addToggle(toggle => toggle
        .setValue(garbledText)
        .onChange(value => garbledText = value)
      )
    
    let transparentBackground = false
    transparentBackgroundSetting = new Setting(modal.contentEl)
      .setName('Transparent background')
      .setDesc('This will make the background of the image transparent.')
      .addToggle(toggle => toggle
        .setValue(transparentBackground)
        .onChange(value => transparentBackground = value)
      )

    new Setting(modal.contentEl)
      .addButton(button => button
        .setButtonText('Save')
        .setCta()
        .onClick(async () => {
          modal.close()

          this.exportImage(
            canvas, 
            nodesToExport, 
            svg, 
            svg ? 1 : pixelRatioFactor, 
            svg ? noFontExport : false,
            watermark,
            garbledText,
            svg ? true : transparentBackground
          )
        })
      )

    updateDynamicSettings()
    modal.open()
  }

  private async exportImage(canvas: Canvas, nodesToExport: CanvasNode[] | null, svg: boolean, pixelRatioFactor: number, noFontExport: boolean, watermark: boolean, garbledText: boolean, transparentBackground: boolean) {
    const isWholeCanvas = nodesToExport === null
    if (!nodesToExport) nodesToExport = [...canvas.nodes.values()]
    
    // Filter all edges that should be exported
    const nodesToExportIds = nodesToExport.map(node => node.getData().id)
    const edgesToExport = [...canvas.edges.values()]
      .filter(edge => {
        const edgeData = edge.getData()
        return nodesToExportIds.includes(edgeData.fromNode) && nodesToExportIds.includes(edgeData.toNode)
      })

    // Set the background color
    const backgroundColor = transparentBackground ? undefined : 
      window.getComputedStyle(canvas.canvasEl).getPropertyValue('--canvas-background')

    // Create loading overlay
    new Notice('Exporting the canvas. Please wait...')
    const interactionBlocker = this.getInteractionBlocker()
    document.body.appendChild(interactionBlocker)

    // Prepare the canvas
    canvas.screenshotting = true
    canvas.canvasEl.classList.add('is-exporting')
    if (garbledText) canvas.canvasEl.classList.add('is-text-garbled')
    let watermarkEl = null

    const cachedSelection = new Set(canvas.selection)
    canvas.deselectAll()

    // Cache the current viewport
    const cachedViewport = { x: canvas.x, y: canvas.y, zoom: canvas.zoom }

    try {
      // Calculate the bounding box of the elements to export
      const targetBoundingBox = CanvasHelper.getBBox([...nodesToExport, ...edgesToExport])
      let enlargedTargetBoundingBox = BBoxHelper.scaleBBox(targetBoundingBox, 1.1) // Enlarge the bounding box by 10%

      // Calculate pixel ratio
      const enlargedTargetBoundingBoxSize = { width: enlargedTargetBoundingBox.maxX - enlargedTargetBoundingBox.minX, height: enlargedTargetBoundingBox.maxY - enlargedTargetBoundingBox.minY }
      const canvasElSize = { width: canvas.canvasEl.clientWidth, height: canvas.canvasEl.clientHeight }
      const requiredPixelRatio = Math.max(enlargedTargetBoundingBoxSize.width / canvasElSize.width, enlargedTargetBoundingBoxSize.height / canvasElSize.height)
      const pixelRatio = svg ? undefined : Math.round(requiredPixelRatio * pixelRatioFactor)

      // Add watermark
      watermarkEl = watermark ? this.getWatermark(enlargedTargetBoundingBox) : null
      if (watermarkEl) canvas.canvasEl.appendChild(watermarkEl)

      // Offset bounding box to respect the aspect ratio
      const actualAspectRatio = canvas.canvasRect.width / canvas.canvasRect.height
      const targetAspectRatio = (enlargedTargetBoundingBox.maxX - enlargedTargetBoundingBox.minX) / (enlargedTargetBoundingBox.maxY - enlargedTargetBoundingBox.minY)

      let adjustedBoundingBox = { ...enlargedTargetBoundingBox }
      if (actualAspectRatio > targetAspectRatio) {
        // The actual bounding box is wider than the target bounding box
        const targetHeight = enlargedTargetBoundingBox.maxY - enlargedTargetBoundingBox.minY
        const actualWidth = targetHeight * actualAspectRatio

        adjustedBoundingBox.maxX = enlargedTargetBoundingBox.minX + actualWidth
      } else {
        // The actual bounding box is taller than the target bounding box
        const targetWidth = enlargedTargetBoundingBox.maxX - enlargedTargetBoundingBox.minX
        const actualHeight = targetWidth / actualAspectRatio

        adjustedBoundingBox.maxY = enlargedTargetBoundingBox.minY + actualHeight
      }

      // Zoom to the bounding box of the elements to export
      canvas.zoomToRealBbox(adjustedBoundingBox) // Zoom to the bounding box (without padding)
      canvas.setViewport(canvas.tx, canvas.ty, canvas.tZoom) // Accelerate zoomToBbox by setting the canvas to the desired position and zoom
      await sleep(10) // Wait for viewport to update

      // Calculate bounding boxes that also contain the complete edge paths
      // Not before, because some nodes might have been outside the viewport
      let canvasScale = parseFloat(canvas.canvasEl.style.transform.match(/scale\((\d+(\.\d+)?)\)/)?.[1] || '1')
      const edgePathsBBox = BBoxHelper.combineBBoxes(edgesToExport.map(edge => {
        const edgeCenter = edge.getCenter()
        const labelWidth = edge.labelElement ? edge.labelElement.wrapperEl.getBoundingClientRect().width / canvasScale : 0

        return { minX: edgeCenter.x - labelWidth / 2, minY: edgeCenter.y, maxX: edgeCenter.x + labelWidth / 2, maxY: edgeCenter.y }
      }))
      const enlargedEdgePathsBBox = BBoxHelper.enlargeBBox(edgePathsBBox, 1.1) // Enlarge the bounding box by 10%
      enlargedTargetBoundingBox = BBoxHelper.combineBBoxes([enlargedTargetBoundingBox, enlargedEdgePathsBBox])
      adjustedBoundingBox = BBoxHelper.combineBBoxes([adjustedBoundingBox, enlargedEdgePathsBBox])

      canvas.zoomToRealBbox(adjustedBoundingBox) // Zoom to the bounding box
      canvas.setViewport(canvas.tx, canvas.ty, canvas.tZoom) // Accelerate zoomToBbox by setting the canvas to the desired position and zoom
      await sleep(10) // Wait for viewport to update

      // Calculate the output image size
      const canvasViewportBBox = canvas.getViewportBBox()
      canvasScale = parseFloat(canvas.canvasEl.style.transform.match(/scale\((\d+(\.\d+)?)\)/)?.[1] || '1')
      let width = (canvasViewportBBox.maxX - canvasViewportBBox.minX) * canvasScale
      let height = (canvasViewportBBox.maxY - canvasViewportBBox.minY) * canvasScale

      if (actualAspectRatio > targetAspectRatio)
        width = height * targetAspectRatio // The actual bounding box is wider than the target bounding box
      else height = width / targetAspectRatio // The actual bounding box is taller than the target bounding box

      // Wait for everything to render
      let unloadedNodes = nodesToExport.filter(node => node.initialized === false || node.isContentMounted === false)
      const startTimestamp = performance.now()
      while (unloadedNodes.length > 0 && performance.now() - startTimestamp < MAX_ALLOWED_LOADING_TIME) {
        await sleep(10)

        unloadedNodes = nodesToExport.filter(node => node.initialized === false || node.isContentMounted === false)
        console.info(`Waiting for ${unloadedNodes.length} nodes to finish loading...`)
      }

      if (unloadedNodes.length === 0) {
        // Create a filter to only export the desired elements
        const nodeElements = nodesToExport
          .map(node => node.nodeEl)

        const edgePathAndArrowElements = edgesToExport
          .map(edge => [edge.lineGroupEl, edge.lineEndGroupEl])
          .flat()

        const edgeLabelElements = edgesToExport
          .map(edge => edge.labelElement?.wrapperEl)
          .filter(labelElement => labelElement !== undefined) as HTMLElement[]

        const filter = (element: HTMLElement) => {
          // Filter nodes
          if (element.classList?.contains('canvas-node') && !nodeElements.includes(element)) 
            return false

          // Filter edge paths and arrows
          if (element.parentElement?.classList?.contains('canvas-edges') && !edgePathAndArrowElements.includes(element))
            return false

          // Filter edge labels
          if (element.classList?.contains('canvas-path-label-wrapper') && !edgeLabelElements.includes(element)) 
            return false

          return true
        }

        // Generate the image
        const options: any = {
          pixelRatio: pixelRatio,
          backgroundColor: backgroundColor,
          height: height,
          width: width,
          filter: filter
        }
        if (noFontExport) options.fontEmbedCSS = ""
        const imageDataUri = svg ? await HtmlToImage.toSvg(canvas.canvasEl, options) : await HtmlToImage.toPng(canvas.canvasEl, options)

        // Download the image
        let baseFilename = `${canvas.view.file?.basename || 'Untitled'}`
        if (!isWholeCanvas) baseFilename += ` - Selection of ${nodesToExport.length}`
        const filename = `${baseFilename}.${svg ? 'svg' : 'png'}`
        
        const downloadEl = document.createElement('a')
        downloadEl.href = imageDataUri
        downloadEl.download = filename
        downloadEl.click()
      } else {
        const ERROR_MESSAGE = 'Export cancelled: Nodes did not finish loading in time'
        new Notice(ERROR_MESSAGE)
        console.error(ERROR_MESSAGE)
      }
    } finally {
      // Reset the canvas
      canvas.screenshotting = false
      canvas.canvasEl.classList.remove('is-exporting')
      if (garbledText) canvas.canvasEl.classList.remove('is-text-garbled')
      if (watermarkEl) canvas.canvasEl.removeChild(watermarkEl)
      canvas.updateSelection(() => canvas.selection = cachedSelection)
      canvas.setViewport(cachedViewport.x, cachedViewport.y, cachedViewport.zoom)

      // Remove the loading overlay
      interactionBlocker.remove()
    }
  }

  private getInteractionBlocker() {
    // Progress bar (like when loading the workspace)
    const interactionBlocker = document.createElement('div')
    interactionBlocker.classList.add('progress-bar-container')

    const progressBar = document.createElement('div')
    progressBar.classList.add('progress-bar')
    interactionBlocker.appendChild(progressBar)

    const progressBarMessage = document.createElement('div')
    progressBarMessage.classList.add('progress-bar-message', 'u-center-text')
    progressBarMessage.innerText = 'Generating image...'
    progressBar.appendChild(progressBarMessage)

    const progressBarIndicator = document.createElement('div')
    progressBarIndicator.classList.add('progress-bar-indicator')
    progressBar.appendChild(progressBarIndicator)

    const progressBarLine = document.createElement('div')
    progressBarLine.classList.add('progress-bar-line')
    progressBarIndicator.appendChild(progressBarLine)

    const progressBarSublineIncrease = document.createElement('div')
    progressBarSublineIncrease.classList.add('progress-bar-subline', 'mod-increase')
    progressBarIndicator.appendChild(progressBarSublineIncrease)

    const progressBarSublineDecrease = document.createElement('div')
    progressBarSublineDecrease.classList.add('progress-bar-subline', 'mod-decrease')
    progressBarIndicator.appendChild(progressBarSublineDecrease)

    return interactionBlocker
  }

  private getWatermark(bbox: BBox) {
    const bboxWidth = bbox.maxX - bbox.minX
    const width = Math.max(200, bboxWidth * 0.3)

    const WATERMARK_SIZE = { width: 215, height: 25 }
    const height = (WATERMARK_SIZE.height / WATERMARK_SIZE.width) * width

    const watermarkPadding = {
      x: bboxWidth * 0.02,
      y: bboxWidth * 0.014
    }

    // Enlarge the bounding box in the bottom
    bbox.maxY += height + watermarkPadding.y

    const watermarkEl = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    watermarkEl.id = 'watermark-ac'
    watermarkEl.style.transform = `translate(${bbox.minX + watermarkPadding.x}px, ${bbox.maxY - height - watermarkPadding.y}px)`

    watermarkEl.setAttrs({
      viewBox: `0 0 ${WATERMARK_SIZE.width} ${WATERMARK_SIZE.height}`,
      width: width.toString(),
      fill: "currentColor"
    })
    watermarkEl.innerHTML = '<path d="M7 14.6a12 12 0 0 1 2.8-.6 10 10 0 0 1 .5-8.8l.4-.7a32.9 32.9 0 0 0 .9-2.3v-1c-.1-.4-.3-.7-.7-1.1-.6-.2-1.1 0-1.6.3L4.2 5.1c-.3.2-.5.6-.6 1l-.4 3a14.6 14.6 0 0 1 3.7 5.5Zm-4-4.2-.1.3-2.8 6c-.2.7-.1 1.4.4 1.9L4.8 23a8.7 8.7 0 0 0 .8-8.7c-.7-1.8-1.9-3.2-2.6-4Z"/><path d="M5.8 23.5H6a23.8 23.8 0 0 1 7.4 1.4c1.2.4 2.3-.5 2.5-1.7a7 7 0 0 1 .8-2.7c-.8-2-1.6-3.2-2.6-4a5 5 0 0 0-2.9-1.3c-1.6-.2-3 .2-4 .5.6 2.3.4 5-1.4 7.8Z"/><path d="m17.4 19.3 2-3c0-.4 0-.7-.2-1a18 18 0 0 1-2-3.5c-.7-1.4-.7-3.5-.8-4.6 0-.4 0-.7-.3-1l-3.4-4.3v.6L12 4l-.5 1-.3.6A11 11 0 0 0 10 9.4c0 1.3 0 2.8.9 4.7h.4c1.1.2 2.3.6 3.5 1.6 1 .8 1.8 2 2.5 3.6ZM39.8 4.5c-6 0-10.3 3.7-10.3 8.9 0 5.1 4.3 8.9 10.3 8.9 5.9 0 10.2-3.8 10.2-9 0-5-4.3-8.8-10.2-8.8Zm0 3.5c3.5 0 6.1 2.1 6.1 5.4 0 3.2-2.6 5.4-6.1 5.4-3.6 0-6.2-2.2-6.2-5.4 0-3.3 2.6-5.4 6.2-5.4Zm15.7 12.6c.8.9 2.5 1.7 4.6 1.7 4.3 0 6.8-3 6.8-6.6C67 12 64.4 9 60.1 9c-2.1 0-3.8.8-4.6 1.7v-6h-3.9V22h3.9v-1.4Zm-.1-5c0-2 1.7-3.4 3.9-3.4 2 0 3.9 1.2 3.9 3.5 0 2.2-1.8 3.5-4 3.5-2.1 0-3.8-1.4-3.8-3.4v-.2ZM67.3 20a11 11 0 0 0 7.2 2.3c4 0 7-1.5 7-4.4 0-3-2.9-3.5-6.1-3.8-2.8-.4-3.6-.4-3.6-1.1 0-.7.9-1 2.5-1 2 0 3.7.5 4.8 1.6l2-2.3A9.7 9.7 0 0 0 74.5 9c-4 0-6.5 1.7-6.5 4.3 0 2.7 2.5 3.3 5.6 3.7 2.8.3 4 .3 4 1.2 0 .8-1 1.1-2.8 1.1-2.2 0-4.1-.7-5.7-2l-1.8 2.5ZM82.8 8h4V4.9h-4V8Zm3.9 1.4h-3.8V22h3.8V9.4Zm13.1 11.2V22h3.9V4.8h-3.9v6C99 9.8 97.4 9 95.2 9c-4.3 0-6.8 3-6.8 6.6 0 3.6 2.5 6.6 6.8 6.6 2.2 0 3.8-.8 4.6-1.7Zm.1-5v.2c0 2-1.7 3.4-3.9 3.4-2 0-3.9-1.3-3.9-3.5 0-2.3 1.8-3.5 4-3.5 2.1 0 3.8 1.4 3.8 3.4ZM106 8h4V4.9h-4V8Zm3.9 1.4H106V22h3.9V9.4Zm7 12.9a8 8 0 0 0 5.2-1.7c.6 1.2 2.2 2 5 1.4v-2.8c-1.4.3-1.7 0-1.7-.7v-4.6c0-3.2-2.3-4.8-6.4-4.8-3.5 0-6.2 1.5-7 3.8l3.4 1c.4-1 1.7-1.8 3.5-1.8 2 0 2.8.8 2.8 1.7v.1l-5 .5c-3 .3-5.2 1.5-5.2 4 0 2.4 2.2 3.9 5.4 3.9Zm4.8-5.1c0 1.4-2.2 2.3-4.1 2.3-1.5 0-2.4-.5-2.4-1.3s.7-1.1 2-1.3l4.5-.4v.7Zm6.7 4.8h3.8v-6c0-2.2 1.2-3.5 3.3-3.5 2 0 3 1.3 3 3.4V22h3.8v-7.2c0-3.5-2.2-5.7-5.5-5.7-2 0-3.6.8-4.6 1.8V9.4h-3.8V22Z"/><path fill-rule="evenodd" stroke="currentColor" stroke-width="0.5px" d="M191.822 20.035A3.288 3.288 0 0 0 191.812 19.951A2.225 2.225 0 0 0 191.728 19.825A3.914 3.914 0 0 0 191.649 19.779A2.868 2.868 0 0 0 191.535 19.755Q191.388 19.755 191.329 19.85A9.99 9.99 0 0 0 191.248 20.005A9.059 9.059 0 0 0 191.234 20.042A20.576 20.576 0 0 1 191.04 20.456A15.291 15.291 0 0 1 190.688 20.854A13.176 13.176 0 0 1 190.086 21.116A18.046 18.046 0 0 1 189.778 21.141A16.538 16.538 0 0 1 189.506 21.117A22.39 22.39 0 0 1 189.246 21.057A12.53 12.53 0 0 1 188.825 20.838A15.259 15.259 0 0 1 188.718 20.746Q188.476 20.518 188.315 20.126A19.046 19.046 0 0 1 188.212 19.778Q188.177 19.602 188.163 19.395A41.406 41.406 0 0 1 188.154 19.118A38.021 38.021 0 0 1 188.176 18.694Q188.2 18.485 188.249 18.307A18.247 18.247 0 0 1 188.319 18.1A22.415 22.415 0 0 1 188.472 17.79Q188.57 17.628 188.687 17.506A13.277 13.277 0 0 1 188.732 17.463A15.164 15.164 0 0 1 189.051 17.229A13.142 13.142 0 0 1 189.274 17.134A20.296 20.296 0 0 1 189.592 17.058A16.216 16.216 0 0 1 189.834 17.039Q190.032 17.039 190.179 17.076A8.428 8.428 0 0 1 190.265 17.102A20.826 20.826 0 0 1 190.385 17.15Q190.443 17.176 190.492 17.203A10.532 10.532 0 0 1 190.548 17.235A13.851 13.851 0 0 1 190.796 17.429A16.001 16.001 0 0 1 190.849 17.484Q190.989 17.634 191.087 17.816A28.524 28.524 0 0 0 191.143 17.923A32.076 32.076 0 0 0 191.164 17.96A8.099 8.099 0 0 0 191.246 18.077A7.413 7.413 0 0 0 191.259 18.093A5.796 5.796 0 0 0 191.329 18.16A4.911 4.911 0 0 0 191.371 18.191A2.41 2.41 0 0 0 191.488 18.228A2.956 2.956 0 0 0 191.507 18.229A3.152 3.152 0 0 0 191.589 18.219A2.121 2.121 0 0 0 191.714 18.131A4.225 4.225 0 0 0 191.758 18.048A3.083 3.083 0 0 0 191.78 17.935A2.636 2.636 0 0 0 191.777 17.896Q191.77 17.853 191.751 17.792A15.123 15.123 0 0 0 191.735 17.743A12.471 12.471 0 0 0 191.685 17.624Q191.648 17.544 191.595 17.456Q191.506 17.308 191.365 17.148A29.801 29.801 0 0 0 191.346 17.127A16.118 16.118 0 0 0 191.103 16.907A19.423 19.423 0 0 0 190.972 16.819A20.302 20.302 0 0 0 190.685 16.673A25.928 25.928 0 0 0 190.461 16.591A19.442 19.442 0 0 0 190.11 16.518A25.565 25.565 0 0 0 189.806 16.5A24.519 24.519 0 0 0 189.175 16.579A21.58 21.58 0 0 0 188.868 16.686Q188.441 16.871 188.13 17.207A22.873 22.873 0 0 0 187.739 17.792A27.604 27.604 0 0 0 187.643 18.023A28.76 28.76 0 0 0 187.489 18.699A36.041 36.041 0 0 0 187.468 19.09Q187.468 19.657 187.65 20.189A25.617 25.617 0 0 0 187.925 20.762A21.934 21.934 0 0 0 188.182 21.085Q188.35 21.26 188.553 21.376Q188.756 21.491 188.973 21.558Q189.19 21.624 189.411 21.652Q189.631 21.68 189.841 21.68Q190.33 21.68 190.687 21.519A14.886 14.886 0 0 0 190.758 21.484A23.571 23.571 0 0 0 191.1 21.27A18.016 18.016 0 0 0 191.371 21.019A21.893 21.893 0 0 0 191.572 20.749A16.519 16.519 0 0 0 191.714 20.473A24.164 24.164 0 0 0 191.766 20.326Q191.812 20.183 191.82 20.08A5.511 5.511 0 0 0 191.822 20.035ZM210.729 20.539A10.256 10.256 0 0 0 210.709 20.331Q210.681 20.195 210.613 20.089A6.408 6.408 0 0 0 210.603 20.074Q210.477 19.888 210.285 19.769Q210.092 19.65 209.865 19.58Q209.637 19.51 209.427 19.468Q209.112 19.398 208.909 19.332Q208.769 19.286 208.67 19.234A8.38 8.38 0 0 1 208.591 19.188Q208.506 19.132 208.459 19.069A3.226 3.226 0 0 1 208.43 19.024A4.079 4.079 0 0 1 208.384 18.844A4.773 4.773 0 0 1 208.384 18.831Q208.384 18.614 208.563 18.485A6.016 6.016 0 0 1 208.611 18.453A9.288 9.288 0 0 1 208.884 18.349Q209.018 18.32 209.175 18.32A15.627 15.627 0 0 1 209.378 18.332Q209.479 18.346 209.562 18.373A6.348 6.348 0 0 1 209.714 18.446A8.886 8.886 0 0 1 209.849 18.555Q209.934 18.64 209.98 18.739A5.694 5.694 0 0 1 209.98 18.74A21.387 21.387 0 0 0 210.014 18.808Q210.051 18.879 210.082 18.923A4.301 4.301 0 0 0 210.103 18.95A1.554 1.554 0 0 0 210.167 18.995Q210.193 19.005 210.226 19.01A4.094 4.094 0 0 0 210.281 19.013Q210.34 19.013 210.381 19A1.678 1.678 0 0 0 210.421 18.982A2.886 2.886 0 0 0 210.467 18.945A2.322 2.322 0 0 0 210.498 18.908A2.481 2.481 0 0 0 210.521 18.867A1.908 1.908 0 0 0 210.533 18.824Q210.539 18.79 210.54 18.77A1.657 1.657 0 0 0 210.54 18.761Q210.54 18.719 210.503 18.605A25.229 25.229 0 0 0 210.491 18.569Q210.451 18.451 210.345 18.329A12.347 12.347 0 0 0 210.295 18.275A9.871 9.871 0 0 0 210.149 18.153Q210.034 18.074 209.879 18.005A12.077 12.077 0 0 0 209.651 17.933Q209.534 17.907 209.395 17.895A28.523 28.523 0 0 0 209.161 17.886Q208.923 17.886 208.736 17.922A15.474 15.474 0 0 0 208.692 17.932A15.47 15.47 0 0 0 208.491 17.991A11.956 11.956 0 0 0 208.335 18.061Q208.083 18.201 207.943 18.439A10.425 10.425 0 0 0 207.835 18.69A8.678 8.678 0 0 0 207.803 18.922A8.458 8.458 0 0 0 207.827 19.126A6.855 6.855 0 0 0 207.898 19.304A10.914 10.914 0 0 0 208.01 19.466A8.765 8.765 0 0 0 208.118 19.573A13.929 13.929 0 0 0 208.273 19.684A12.994 12.994 0 0 0 208.276 19.685A9.406 9.406 0 0 0 208.342 19.722Q208.379 19.741 208.423 19.759A19.716 19.716 0 0 0 208.482 19.783Q208.569 19.817 208.683 19.854A61.793 61.793 0 0 0 208.794 19.888Q208.975 19.943 209.246 20.011A175.761 175.761 0 0 0 209.259 20.014Q209.392 20.049 209.543 20.091A11.079 11.079 0 0 1 209.724 20.159A9.425 9.425 0 0 1 209.812 20.207Q209.931 20.28 210.011 20.389A3.951 3.951 0 0 1 210.079 20.538Q210.092 20.597 210.092 20.665A4.625 4.625 0 0 1 209.993 20.949A7.213 7.213 0 0 1 209.879 21.068A6.795 6.795 0 0 1 209.657 21.188Q209.485 21.246 209.245 21.246Q208.982 21.246 208.8 21.18A6.716 6.716 0 0 1 208.611 21.078Q208.398 20.91 208.293 20.665A7.271 7.271 0 0 0 208.241 20.564A5.814 5.814 0 0 0 208.192 20.497A1.892 1.892 0 0 0 208.095 20.437Q208.064 20.429 208.027 20.427A3.869 3.869 0 0 0 208.013 20.427A2.684 2.684 0 0 0 207.902 20.45A2.607 2.607 0 0 0 207.824 20.504A2.794 2.794 0 0 0 207.773 20.573A2.276 2.276 0 0 0 207.747 20.679Q207.747 20.868 207.849 21.029A18.825 18.825 0 0 0 207.938 21.159Q207.996 21.236 208.055 21.295A13.024 13.024 0 0 0 208.518 21.581A14.764 14.764 0 0 0 208.521 21.582A14.51 14.51 0 0 0 208.761 21.645Q208.883 21.667 209.025 21.675A30.93 30.93 0 0 0 209.203 21.68Q209.548 21.68 209.798 21.62A13.282 13.282 0 0 0 210.019 21.547A17.031 17.031 0 0 0 210.226 21.44Q210.382 21.345 210.481 21.229A11.064 11.064 0 0 0 210.597 21.065A7.971 7.971 0 0 0 210.684 20.851A23.38 23.38 0 0 0 210.707 20.737Q210.728 20.629 210.729 20.55A6.492 6.492 0 0 0 210.729 20.539ZM149.486 20.469A20.565 20.565 0 0 0 149.509 20.43Q149.535 20.385 149.569 20.321A90.19 90.19 0 0 0 149.602 20.259Q149.675 20.119 149.749 19.962A37.1 37.1 0 0 0 149.84 19.75A31.562 31.562 0 0 0 149.874 19.657A12.867 12.867 0 0 0 149.902 19.573Q149.927 19.482 149.927 19.419Q149.927 19.3 149.843 19.22Q149.759 19.139 149.64 19.139A2.273 2.273 0 0 0 149.482 19.204Q149.434 19.248 149.395 19.321A14.995 14.995 0 0 0 149.383 19.346Q149.363 19.388 149.329 19.465Q149.283 19.566 149.231 19.682Q149.178 19.797 149.133 19.899A99.51 99.51 0 0 1 149.111 19.946Q149.082 20.011 149.066 20.042Q148.968 19.938 148.891 19.851A68.292 68.292 0 0 1 148.881 19.839A1775.331 1775.331 0 0 1 148.805 19.754Q148.754 19.696 148.695 19.629A79.458 79.458 0 0 1 148.64 19.566Q148.552 19.465 148.44 19.328A466.983 466.983 0 0 1 148.358 19.23Q148.246 19.093 148.095 18.907A1543.854 1543.854 0 0 1 148.044 18.845Q148.506 18.6 148.8 18.303A10.277 10.277 0 0 0 149.021 17.98A9.508 9.508 0 0 0 149.094 17.606Q149.094 17.473 149.047 17.311A16.194 16.194 0 0 0 149.031 17.26A10.364 10.364 0 0 0 148.872 16.958A12.188 12.188 0 0 0 148.825 16.899A10.761 10.761 0 0 0 148.611 16.71A13.818 13.818 0 0 0 148.45 16.616Q148.241 16.511 147.945 16.501A18.707 18.707 0 0 0 147.883 16.5A15.973 15.973 0 0 0 147.614 16.522A11.629 11.629 0 0 0 147.334 16.605A13.053 13.053 0 0 0 147.095 16.742A10.73 10.73 0 0 0 146.945 16.875A10.831 10.831 0 0 0 146.739 17.186A10.281 10.281 0 0 0 146.718 17.239A11.786 11.786 0 0 0 146.65 17.524A10.583 10.583 0 0 0 146.644 17.634A10.236 10.236 0 0 0 146.703 17.97A13.462 13.462 0 0 0 146.788 18.163A32.918 32.918 0 0 0 146.933 18.407Q147.038 18.57 147.176 18.747Q146.98 18.852 146.773 18.985Q146.567 19.118 146.396 19.29Q146.224 19.461 146.112 19.689A10.729 10.729 0 0 0 146.016 20.001A14.179 14.179 0 0 0 146 20.217A12.88 12.88 0 0 0 146.038 20.523A16.369 16.369 0 0 0 146.098 20.714A13.928 13.928 0 0 0 146.374 21.16A15.957 15.957 0 0 0 146.399 21.187A14.894 14.894 0 0 0 146.71 21.434A18.905 18.905 0 0 0 146.914 21.54A15.13 15.13 0 0 0 147.256 21.645Q147.417 21.675 147.602 21.679A26.164 26.164 0 0 0 147.659 21.68Q147.953 21.68 148.181 21.614A20.209 20.209 0 0 0 148.417 21.529A15.925 15.925 0 0 0 148.583 21.446A16.498 16.498 0 0 0 148.784 21.309A13.958 13.958 0 0 0 148.888 21.218A33.819 33.819 0 0 0 149.023 21.079A26.636 26.636 0 0 0 149.115 20.973L149.266 21.124Q149.338 21.196 149.462 21.307A122.767 122.767 0 0 0 149.542 21.379Q149.655 21.479 149.734 21.54A17.292 17.292 0 0 0 149.752 21.554Q149.821 21.606 149.869 21.634A5.331 5.331 0 0 0 149.889 21.645A4.838 4.838 0 0 0 149.916 21.659Q149.95 21.674 149.973 21.677A5.79 5.79 0 0 0 150.011 21.68A4.806 4.806 0 0 0 150.032 21.68A2.48 2.48 0 0 0 150.12 21.663Q150.153 21.651 150.188 21.629A5.246 5.246 0 0 0 150.225 21.603Q150.326 21.526 150.326 21.372A2.778 2.778 0 0 0 150.319 21.308A2.031 2.031 0 0 0 150.284 21.232A5.843 5.843 0 0 0 150.256 21.198Q150.214 21.15 150.144 21.085A119.856 119.856 0 0 1 150.081 21.031Q150.004 20.966 149.948 20.916A37.409 37.409 0 0 1 149.931 20.9Q149.85 20.826 149.784 20.767Q149.717 20.707 149.654 20.641A52.27 52.27 0 0 0 149.62 20.605Q149.565 20.548 149.486 20.469ZM172.432 21.183L172.432 19.279A51.556 51.556 0 0 0 172.432 19.211Q172.431 19.149 172.429 19.073A18.916 18.916 0 0 0 172.409 18.853A21.017 21.017 0 0 0 172.404 18.821Q172.383 18.691 172.334 18.565Q172.285 18.439 172.194 18.334Q172.005 18.117 171.757 18.002A12.033 12.033 0 0 0 171.449 17.908A16.569 16.569 0 0 0 171.172 17.886A16.106 16.106 0 0 0 170.97 17.898Q170.864 17.912 170.773 17.94A9.472 9.472 0 0 0 170.745 17.949Q170.563 18.012 170.427 18.107A14.499 14.499 0 0 0 170.272 18.229A12 12 0 0 0 170.192 18.31Q170.094 18.418 170.024 18.509A59.749 59.749 0 0 0 170.024 18.43Q170.023 18.399 170.022 18.372A28.64 28.64 0 0 0 170.021 18.32Q170.018 18.267 170.016 18.224A56.933 56.933 0 0 0 170.014 18.187Q170.01 18.131 169.996 18.093Q169.982 18.054 169.961 18.019A1.527 1.527 0 0 0 169.935 17.979Q169.912 17.952 169.874 17.928A2.736 2.736 0 0 0 169.733 17.886A3.297 3.297 0 0 0 169.723 17.886A3.514 3.514 0 0 0 169.666 17.891Q169.625 17.897 169.594 17.914A7.268 7.268 0 0 0 169.552 17.938Q169.533 17.95 169.517 17.962A3.925 3.925 0 0 0 169.506 17.97A2.17 2.17 0 0 0 169.455 18.054Q169.444 18.085 169.44 18.122A3.872 3.872 0 0 0 169.44 18.124A16 16 0 0 0 169.433 18.203Q169.431 18.239 169.43 18.281A34.968 34.968 0 0 0 169.429 18.369L169.429 21.183Q169.429 21.294 169.434 21.378A16.104 16.104 0 0 0 169.44 21.439A2.976 2.976 0 0 0 169.455 21.508A2.094 2.094 0 0 0 169.513 21.596A3.572 3.572 0 0 0 169.615 21.658A3.123 3.123 0 0 0 169.73 21.68Q169.849 21.68 169.947 21.596A2.227 2.227 0 0 0 170.009 21.503A3.192 3.192 0 0 0 170.024 21.439Q170.034 21.366 170.037 21.265A29.244 29.244 0 0 0 170.038 21.183L170.038 20.028A136.267 136.267 0 0 1 170.039 19.891Q170.041 19.696 170.049 19.559Q170.059 19.377 170.08 19.258A13.249 13.249 0 0 1 170.096 19.182Q170.112 19.114 170.133 19.066Q170.164 18.992 170.206 18.922Q170.332 18.691 170.57 18.555Q170.808 18.418 171.074 18.418Q171.263 18.418 171.438 18.506Q171.613 18.593 171.711 18.768A5.723 5.723 0 0 1 171.751 18.856Q171.768 18.902 171.781 18.956A12.31 12.31 0 0 1 171.795 19.027Q171.823 19.188 171.823 19.454L171.823 21.183Q171.823 21.294 171.828 21.378A16.104 16.104 0 0 0 171.834 21.439A2.976 2.976 0 0 0 171.849 21.508A2.094 2.094 0 0 0 171.907 21.596A3.143 3.143 0 0 0 172.114 21.68A4.083 4.083 0 0 0 172.131 21.68Q172.25 21.68 172.348 21.596A2.116 2.116 0 0 0 172.409 21.5A3.049 3.049 0 0 0 172.422 21.439A17.011 17.011 0 0 0 172.428 21.359Q172.432 21.282 172.432 21.183ZM199.648 21.183L199.648 19.279A51.556 51.556 0 0 0 199.648 19.211Q199.647 19.149 199.645 19.073A18.916 18.916 0 0 0 199.625 18.853A21.017 21.017 0 0 0 199.62 18.821Q199.599 18.691 199.55 18.565Q199.501 18.439 199.41 18.334Q199.221 18.117 198.973 18.002A12.033 12.033 0 0 0 198.665 17.908A16.569 16.569 0 0 0 198.388 17.886A16.106 16.106 0 0 0 198.186 17.898Q198.08 17.912 197.989 17.94A9.472 9.472 0 0 0 197.961 17.949Q197.779 18.012 197.643 18.107A14.499 14.499 0 0 0 197.488 18.229A12 12 0 0 0 197.408 18.31Q197.31 18.418 197.24 18.509A59.749 59.749 0 0 0 197.24 18.43Q197.239 18.399 197.238 18.372A28.64 28.64 0 0 0 197.237 18.32Q197.234 18.267 197.232 18.224A56.933 56.933 0 0 0 197.23 18.187Q197.226 18.131 197.212 18.093Q197.198 18.054 197.177 18.019A1.527 1.527 0 0 0 197.151 17.979Q197.128 17.952 197.09 17.928A2.736 2.736 0 0 0 196.949 17.886A3.297 3.297 0 0 0 196.939 17.886A3.514 3.514 0 0 0 196.882 17.891Q196.841 17.897 196.81 17.914A7.268 7.268 0 0 0 196.768 17.938Q196.749 17.95 196.733 17.962A3.925 3.925 0 0 0 196.722 17.97A2.17 2.17 0 0 0 196.671 18.054Q196.66 18.085 196.656 18.122A3.872 3.872 0 0 0 196.656 18.124A16 16 0 0 0 196.649 18.203Q196.647 18.239 196.646 18.281A34.968 34.968 0 0 0 196.645 18.369L196.645 21.183Q196.645 21.294 196.65 21.378A16.104 16.104 0 0 0 196.656 21.439A2.976 2.976 0 0 0 196.671 21.508A2.094 2.094 0 0 0 196.729 21.596A3.572 3.572 0 0 0 196.831 21.658A3.123 3.123 0 0 0 196.946 21.68Q197.065 21.68 197.163 21.596A2.227 2.227 0 0 0 197.225 21.503A3.192 3.192 0 0 0 197.24 21.439Q197.25 21.366 197.253 21.265A29.244 29.244 0 0 0 197.254 21.183L197.254 20.028A136.267 136.267 0 0 1 197.255 19.891Q197.257 19.696 197.265 19.559Q197.275 19.377 197.296 19.258A13.249 13.249 0 0 1 197.312 19.182Q197.328 19.114 197.349 19.066Q197.38 18.992 197.422 18.922Q197.548 18.691 197.786 18.555Q198.024 18.418 198.29 18.418Q198.479 18.418 198.654 18.506Q198.829 18.593 198.927 18.768A5.723 5.723 0 0 1 198.967 18.856Q198.984 18.902 198.997 18.956A12.31 12.31 0 0 1 199.011 19.027Q199.039 19.188 199.039 19.454L199.039 21.183Q199.039 21.294 199.044 21.378A16.104 16.104 0 0 0 199.05 21.439A2.976 2.976 0 0 0 199.065 21.508A2.094 2.094 0 0 0 199.123 21.596A3.143 3.143 0 0 0 199.33 21.68A4.083 4.083 0 0 0 199.347 21.68Q199.466 21.68 199.564 21.596A2.116 2.116 0 0 0 199.625 21.5A3.049 3.049 0 0 0 199.638 21.439A17.011 17.011 0 0 0 199.644 21.359Q199.648 21.282 199.648 21.183ZM176.534 20.532A3.117 3.117 0 0 0 176.522 20.444A2.336 2.336 0 0 0 176.443 20.326A3.647 3.647 0 0 0 176.368 20.278A2.675 2.675 0 0 0 176.254 20.252Q176.195 20.252 176.154 20.273A1.457 1.457 0 0 0 176.132 20.287Q176.086 20.322 176.051 20.364A0.884 0.884 0 0 0 176.043 20.373Q176.031 20.389 176.013 20.424Q175.988 20.469 175.96 20.522A19.281 19.281 0 0 1 175.922 20.59A16.39 16.39 0 0 1 175.904 20.62Q175.877 20.664 175.869 20.685A0.832 0.832 0 0 0 175.869 20.686Q175.729 20.938 175.481 21.071Q175.232 21.204 174.938 21.204A11.312 11.312 0 0 1 174.567 21.146A9.482 9.482 0 0 1 174.123 20.823A12.884 12.884 0 0 1 173.909 20.4Q173.825 20.123 173.825 19.762Q173.825 19.265 174.005 18.929A11.724 11.724 0 0 1 174.133 18.737A9.92 9.92 0 0 1 174.858 18.365A13.208 13.208 0 0 1 174.952 18.362Q175.149 18.362 175.297 18.41A7.63 7.63 0 0 1 175.348 18.429A11.407 11.407 0 0 1 175.489 18.497A8.28 8.28 0 0 1 175.621 18.59Q175.729 18.684 175.796 18.782A95.188 95.188 0 0 1 175.827 18.828Q175.857 18.874 175.879 18.908A25.527 25.527 0 0 1 175.897 18.936Q175.946 19.027 175.988 19.076Q176.018 19.111 176.044 19.133A2.786 2.786 0 0 0 176.065 19.15Q176.093 19.169 176.119 19.175A1.041 1.041 0 0 0 176.132 19.178A5.79 5.79 0 0 0 176.17 19.181A4.806 4.806 0 0 0 176.191 19.181A2.779 2.779 0 0 0 176.373 19.113A3.543 3.543 0 0 0 176.38 19.107A2.405 2.405 0 0 0 176.464 18.932A3.241 3.241 0 0 0 176.464 18.915Q176.464 18.824 176.426 18.737A9.75 9.75 0 0 0 176.371 18.629A8.253 8.253 0 0 0 176.338 18.579A16.685 16.685 0 0 0 176.24 18.444A21.161 21.161 0 0 0 176.149 18.338A11.789 11.789 0 0 0 175.991 18.194A14.908 14.908 0 0 0 175.873 18.114A13.143 13.143 0 0 0 175.68 18.017A17.807 17.807 0 0 0 175.481 17.949A16.11 16.11 0 0 0 175.266 17.906Q175.155 17.891 175.03 17.887A28.494 28.494 0 0 0 174.945 17.886Q174.427 17.886 174.095 18.065A15.968 15.968 0 0 0 173.748 18.312A13.867 13.867 0 0 0 173.566 18.523Q173.37 18.803 173.293 19.139Q173.216 19.475 173.216 19.79A33.884 33.884 0 0 0 173.227 20.07Q173.238 20.204 173.26 20.318A15.789 15.789 0 0 0 173.297 20.466Q173.357 20.666 173.426 20.811A13.31 13.31 0 0 0 173.475 20.903A12.835 12.835 0 0 0 173.544 21.018Q173.583 21.076 173.631 21.136A21.776 21.776 0 0 0 173.647 21.155A11.374 11.374 0 0 0 173.779 21.291A15.635 15.635 0 0 0 173.93 21.407Q174.105 21.526 174.361 21.603A16.697 16.697 0 0 0 174.604 21.656Q174.772 21.68 174.973 21.68Q175.414 21.68 175.712 21.53A20.695 20.695 0 0 0 175.965 21.379A14.971 14.971 0 0 0 176.195 21.183A16.44 16.44 0 0 0 176.327 21.025Q176.39 20.939 176.432 20.854A8.98 8.98 0 0 0 176.457 20.798Q176.53 20.62 176.534 20.541A1.736 1.736 0 0 0 176.534 20.532ZM153.742 20.147L155.975 20.147L156.423 21.253Q156.492 21.426 156.55 21.53A10.295 10.295 0 0 0 156.574 21.572A2.117 2.117 0 0 0 156.693 21.663Q156.745 21.68 156.815 21.68A3.648 3.648 0 0 0 156.926 21.664A2.913 2.913 0 0 0 157.06 21.575Q157.151 21.47 157.151 21.372Q157.151 21.295 157.127 21.218Q157.108 21.159 157.071 21.067A48.599 48.599 0 0 0 157.046 21.008L155.401 17.088Q155.352 16.969 155.293 16.833A12.279 12.279 0 0 0 155.259 16.762Q155.217 16.68 155.177 16.64A3.694 3.694 0 0 0 155.091 16.569A4.791 4.791 0 0 0 155.03 16.539Q154.939 16.5 154.841 16.5A6.137 6.137 0 0 0 154.757 16.506Q154.692 16.515 154.642 16.539A4.007 4.007 0 0 0 154.506 16.645A4.629 4.629 0 0 0 154.502 16.651Q154.448 16.717 154.403 16.814A11.485 11.485 0 0 0 154.393 16.836Q154.344 16.948 154.288 17.095L152.699 21.036A43.035 43.035 0 0 0 152.676 21.093Q152.648 21.163 152.631 21.215A13.482 13.482 0 0 0 152.626 21.232Q152.601 21.309 152.601 21.386Q152.601 21.49 152.69 21.583A4.693 4.693 0 0 0 152.692 21.586A3.044 3.044 0 0 0 152.91 21.68A4.049 4.049 0 0 0 152.923 21.68A4.561 4.561 0 0 0 153.008 21.673Q153.057 21.663 153.093 21.643A1.998 1.998 0 0 0 153.165 21.575A9.744 9.744 0 0 0 153.207 21.5Q153.248 21.42 153.293 21.305A35.447 35.447 0 0 0 153.308 21.267L153.742 20.147ZM167.875 21.085A156.604 156.604 0 0 0 167.919 21.236A174.514 174.514 0 0 0 167.935 21.288A9.866 9.866 0 0 0 167.991 21.434A8.679 8.679 0 0 0 168.015 21.481Q168.064 21.568 168.127 21.624Q168.19 21.68 168.281 21.68Q168.4 21.68 168.488 21.607A2.978 2.978 0 0 0 168.535 21.557Q168.567 21.514 168.573 21.467A1.833 1.833 0 0 0 168.575 21.442A5.283 5.283 0 0 0 168.567 21.354Q168.559 21.307 168.544 21.257A113.074 113.074 0 0 1 168.533 21.221Q168.511 21.15 168.505 21.127A9.687 9.687 0 0 1 168.48 21.059Q168.468 21.022 168.456 20.98A21.964 21.964 0 0 1 168.439 20.91Q168.412 20.799 168.408 20.605A35.786 35.786 0 0 1 168.407 20.525Q168.407 20.467 168.41 20.329A329.739 329.739 0 0 1 168.411 20.305Q168.414 20.147 168.418 19.965Q168.421 19.783 168.425 19.619A290.299 290.299 0 0 0 168.426 19.542Q168.428 19.437 168.428 19.384A50.037 50.037 0 0 0 168.415 19.009A40.849 40.849 0 0 0 168.393 18.796A10.854 10.854 0 0 0 168.312 18.497A9.517 9.517 0 0 0 168.211 18.32Q168.064 18.117 167.767 18.002Q167.472 17.887 166.962 17.886A46.251 46.251 0 0 0 166.951 17.886Q166.608 17.886 166.356 17.946A13.799 13.799 0 0 0 166.15 18.012Q165.917 18.108 165.764 18.227A10.032 10.032 0 0 0 165.677 18.303Q165.509 18.467 165.453 18.632A19.398 19.398 0 0 0 165.429 18.708Q165.407 18.782 165.4 18.833A3.082 3.082 0 0 0 165.397 18.873A2.545 2.545 0 0 0 165.417 18.975A2.432 2.432 0 0 0 165.478 19.059Q165.558 19.132 165.67 19.132Q165.76 19.132 165.815 19.096A1.703 1.703 0 0 0 165.866 19.045Q165.922 18.957 165.971 18.838Q166.027 18.698 166.136 18.6Q166.244 18.502 166.381 18.443A11.745 11.745 0 0 1 166.636 18.365A13.202 13.202 0 0 1 166.675 18.359Q166.832 18.334 166.993 18.334Q167.28 18.334 167.443 18.404A5.36 5.36 0 0 1 167.459 18.411A6.24 6.24 0 0 1 167.586 18.489A4.723 4.723 0 0 1 167.7 18.621A7.268 7.268 0 0 1 167.786 18.86A8.677 8.677 0 0 1 167.795 18.922A52.243 52.243 0 0 1 167.815 19.182A58.488 58.488 0 0 1 167.819 19.272A58.673 58.673 0 0 1 167.762 19.292Q167.682 19.319 167.627 19.335Q167.553 19.356 167.476 19.377Q167.425 19.39 167.299 19.415A131.725 131.725 0 0 1 167.277 19.419Q167.133 19.447 166.972 19.475A202.132 202.132 0 0 0 166.738 19.517A176.919 176.919 0 0 0 166.664 19.531A182.46 182.46 0 0 0 166.596 19.544Q166.511 19.561 166.465 19.571A21.283 21.283 0 0 0 166.454 19.573A87.884 87.884 0 0 0 166.304 19.607Q166.228 19.625 166.144 19.646A150.463 150.463 0 0 0 166.087 19.661Q165.88 19.713 165.698 19.829A9.901 9.901 0 0 0 165.422 20.092A11.635 11.635 0 0 0 165.39 20.14Q165.28 20.312 165.266 20.569A14.069 14.069 0 0 0 165.264 20.644Q165.264 20.833 165.334 21.019Q165.404 21.204 165.551 21.351A10.381 10.381 0 0 0 165.782 21.523A13.004 13.004 0 0 0 165.919 21.589A11.509 11.509 0 0 0 166.167 21.659Q166.282 21.678 166.413 21.68A19.554 19.554 0 0 0 166.44 21.68A22.373 22.373 0 0 0 166.719 21.663A16.841 16.841 0 0 0 166.969 21.614Q167.203 21.547 167.382 21.453A21.631 21.631 0 0 0 167.527 21.369Q167.6 21.322 167.661 21.274A12.71 12.71 0 0 0 167.683 21.257A45.541 45.541 0 0 0 167.754 21.196Q167.825 21.135 167.872 21.088A13.449 13.449 0 0 0 167.875 21.085ZM195.091 21.085A156.604 156.604 0 0 0 195.135 21.236A174.514 174.514 0 0 0 195.151 21.288A9.866 9.866 0 0 0 195.207 21.434A8.679 8.679 0 0 0 195.231 21.481Q195.28 21.568 195.343 21.624Q195.406 21.68 195.497 21.68Q195.616 21.68 195.704 21.607A2.978 2.978 0 0 0 195.751 21.557Q195.783 21.514 195.789 21.467A1.833 1.833 0 0 0 195.791 21.442A5.283 5.283 0 0 0 195.783 21.354Q195.775 21.307 195.76 21.257A113.074 113.074 0 0 1 195.749 21.221Q195.727 21.15 195.721 21.127A9.687 9.687 0 0 1 195.696 21.059Q195.684 21.022 195.672 20.98A21.964 21.964 0 0 1 195.655 20.91Q195.628 20.799 195.624 20.605A35.786 35.786 0 0 1 195.623 20.525Q195.623 20.467 195.626 20.329A329.739 329.739 0 0 1 195.627 20.305Q195.63 20.147 195.634 19.965Q195.637 19.783 195.641 19.619A290.299 290.299 0 0 0 195.642 19.542Q195.644 19.437 195.644 19.384A50.037 50.037 0 0 0 195.631 19.009A40.849 40.849 0 0 0 195.609 18.796A10.854 10.854 0 0 0 195.528 18.497A9.517 9.517 0 0 0 195.427 18.32Q195.28 18.117 194.983 18.002Q194.688 17.887 194.178 17.886A46.251 46.251 0 0 0 194.167 17.886Q193.824 17.886 193.572 17.946A13.799 13.799 0 0 0 193.366 18.012Q193.133 18.108 192.98 18.227A10.032 10.032 0 0 0 192.893 18.303Q192.725 18.467 192.669 18.632A19.398 19.398 0 0 0 192.645 18.708Q192.623 18.782 192.616 18.833A3.082 3.082 0 0 0 192.613 18.873A2.545 2.545 0 0 0 192.633 18.975A2.432 2.432 0 0 0 192.694 19.059Q192.774 19.132 192.886 19.132Q192.976 19.132 193.031 19.096A1.703 1.703 0 0 0 193.082 19.045Q193.138 18.957 193.187 18.838Q193.243 18.698 193.352 18.6Q193.46 18.502 193.597 18.443A11.745 11.745 0 0 1 193.852 18.365A13.202 13.202 0 0 1 193.891 18.359Q194.048 18.334 194.209 18.334Q194.496 18.334 194.659 18.404A5.36 5.36 0 0 1 194.675 18.411A6.24 6.24 0 0 1 194.802 18.489A4.723 4.723 0 0 1 194.916 18.621A7.268 7.268 0 0 1 195.002 18.86A8.677 8.677 0 0 1 195.011 18.922A52.243 52.243 0 0 1 195.031 19.182A58.488 58.488 0 0 1 195.035 19.272A58.673 58.673 0 0 1 194.978 19.292Q194.898 19.319 194.843 19.335Q194.769 19.356 194.692 19.377Q194.641 19.39 194.515 19.415A131.725 131.725 0 0 1 194.493 19.419Q194.349 19.447 194.188 19.475A202.132 202.132 0 0 0 193.954 19.517A176.919 176.919 0 0 0 193.88 19.531A182.46 182.46 0 0 0 193.812 19.544Q193.727 19.561 193.681 19.571A21.283 21.283 0 0 0 193.67 19.573A87.884 87.884 0 0 0 193.52 19.607Q193.444 19.625 193.36 19.646A150.463 150.463 0 0 0 193.303 19.661Q193.096 19.713 192.914 19.829A9.901 9.901 0 0 0 192.638 20.092A11.635 11.635 0 0 0 192.606 20.14Q192.496 20.312 192.482 20.569A14.069 14.069 0 0 0 192.48 20.644Q192.48 20.833 192.55 21.019Q192.62 21.204 192.767 21.351A10.381 10.381 0 0 0 192.998 21.523A13.004 13.004 0 0 0 193.135 21.589A11.509 11.509 0 0 0 193.383 21.659Q193.498 21.678 193.629 21.68A19.554 19.554 0 0 0 193.656 21.68A22.373 22.373 0 0 0 193.935 21.663A16.841 16.841 0 0 0 194.185 21.614Q194.419 21.547 194.598 21.453A21.631 21.631 0 0 0 194.743 21.369Q194.816 21.322 194.877 21.274A12.71 12.71 0 0 0 194.899 21.257A45.541 45.541 0 0 0 194.97 21.196Q195.041 21.135 195.088 21.088A13.449 13.449 0 0 0 195.091 21.085ZM206.424 21.085A156.604 156.604 0 0 0 206.468 21.236A174.514 174.514 0 0 0 206.484 21.288A9.866 9.866 0 0 0 206.54 21.434A8.679 8.679 0 0 0 206.564 21.481Q206.613 21.568 206.676 21.624Q206.739 21.68 206.83 21.68Q206.949 21.68 207.037 21.607A2.978 2.978 0 0 0 207.084 21.557Q207.116 21.514 207.122 21.467A1.833 1.833 0 0 0 207.124 21.442A5.283 5.283 0 0 0 207.116 21.354Q207.108 21.307 207.093 21.257A113.074 113.074 0 0 1 207.082 21.221Q207.06 21.15 207.054 21.127A9.687 9.687 0 0 1 207.029 21.059Q207.017 21.022 207.005 20.98A21.964 21.964 0 0 1 206.988 20.91Q206.961 20.799 206.957 20.605A35.786 35.786 0 0 1 206.956 20.525Q206.956 20.467 206.959 20.329A329.739 329.739 0 0 1 206.96 20.305Q206.963 20.147 206.967 19.965Q206.97 19.783 206.974 19.619A290.299 290.299 0 0 0 206.975 19.542Q206.977 19.437 206.977 19.384A50.037 50.037 0 0 0 206.964 19.009A40.849 40.849 0 0 0 206.942 18.796A10.854 10.854 0 0 0 206.861 18.497A9.517 9.517 0 0 0 206.76 18.32Q206.613 18.117 206.316 18.002Q206.021 17.887 205.511 17.886A46.251 46.251 0 0 0 205.5 17.886Q205.157 17.886 204.905 17.946A13.799 13.799 0 0 0 204.699 18.012Q204.466 18.108 204.313 18.227A10.032 10.032 0 0 0 204.226 18.303Q204.058 18.467 204.002 18.632A19.398 19.398 0 0 0 203.978 18.708Q203.956 18.782 203.949 18.833A3.082 3.082 0 0 0 203.946 18.873A2.545 2.545 0 0 0 203.966 18.975A2.432 2.432 0 0 0 204.027 19.059Q204.107 19.132 204.219 19.132Q204.309 19.132 204.364 19.096A1.703 1.703 0 0 0 204.415 19.045Q204.471 18.957 204.52 18.838Q204.576 18.698 204.685 18.6Q204.793 18.502 204.93 18.443A11.745 11.745 0 0 1 205.185 18.365A13.202 13.202 0 0 1 205.224 18.359Q205.381 18.334 205.542 18.334Q205.829 18.334 205.992 18.404A5.36 5.36 0 0 1 206.008 18.411A6.24 6.24 0 0 1 206.135 18.489A4.723 4.723 0 0 1 206.249 18.621A7.268 7.268 0 0 1 206.335 18.86A8.677 8.677 0 0 1 206.344 18.922A52.243 52.243 0 0 1 206.364 19.182A58.488 58.488 0 0 1 206.368 19.272A58.673 58.673 0 0 1 206.311 19.292Q206.231 19.319 206.176 19.335Q206.102 19.356 206.025 19.377Q205.974 19.39 205.848 19.415A131.725 131.725 0 0 1 205.826 19.419Q205.682 19.447 205.521 19.475A202.132 202.132 0 0 0 205.287 19.517A176.919 176.919 0 0 0 205.213 19.531A182.46 182.46 0 0 0 205.145 19.544Q205.06 19.561 205.014 19.571A21.283 21.283 0 0 0 205.003 19.573A87.884 87.884 0 0 0 204.853 19.607Q204.777 19.625 204.693 19.646A150.463 150.463 0 0 0 204.636 19.661Q204.429 19.713 204.247 19.829A9.901 9.901 0 0 0 203.971 20.092A11.635 11.635 0 0 0 203.939 20.14Q203.829 20.312 203.815 20.569A14.069 14.069 0 0 0 203.813 20.644Q203.813 20.833 203.883 21.019Q203.953 21.204 204.1 21.351A10.381 10.381 0 0 0 204.331 21.523A13.004 13.004 0 0 0 204.468 21.589A11.509 11.509 0 0 0 204.716 21.659Q204.831 21.678 204.962 21.68A19.554 19.554 0 0 0 204.989 21.68A22.373 22.373 0 0 0 205.268 21.663A16.841 16.841 0 0 0 205.518 21.614Q205.752 21.547 205.931 21.453A21.631 21.631 0 0 0 206.076 21.369Q206.149 21.322 206.21 21.274A12.71 12.71 0 0 0 206.232 21.257A45.541 45.541 0 0 0 206.303 21.196Q206.374 21.135 206.421 21.088A13.449 13.449 0 0 0 206.424 21.085ZM177.794 19.902L179.971 19.902Q180.062 19.902 180.157 19.895Q180.251 19.888 180.332 19.853Q180.412 19.818 180.461 19.738Q180.51 19.657 180.51 19.51A8.226 8.226 0 0 0 180.508 19.461Q180.504 19.391 180.489 19.283A16.26 16.26 0 0 0 180.46 19.129Q180.442 19.055 180.416 18.973A26.778 26.778 0 0 0 180.409 18.95A17.318 17.318 0 0 0 180.314 18.72A21.358 21.358 0 0 0 180.237 18.579A13.255 13.255 0 0 0 179.998 18.285A15.344 15.344 0 0 0 179.943 18.236Q179.761 18.082 179.502 17.984A14.303 14.303 0 0 0 179.228 17.912Q179.1 17.891 178.954 17.887A24.995 24.995 0 0 0 178.886 17.886Q178.461 17.886 178.146 18.023A13.781 13.781 0 0 0 178.123 18.033Q177.801 18.18 177.591 18.436A16.765 16.765 0 0 0 177.319 18.911A19.805 19.805 0 0 0 177.276 19.038A24.845 24.845 0 0 0 177.174 19.655A28.502 28.502 0 0 0 177.171 19.776Q177.171 20.175 177.273 20.525Q177.374 20.875 177.588 21.131Q177.801 21.386 178.127 21.533A15.933 15.933 0 0 0 178.507 21.648Q178.679 21.678 178.874 21.68A26.983 26.983 0 0 0 178.9 21.68A24.666 24.666 0 0 0 179.157 21.667Q179.289 21.654 179.401 21.625A13.385 13.385 0 0 0 179.478 21.603A19.788 19.788 0 0 0 179.675 21.529Q179.793 21.477 179.887 21.414Q180.055 21.302 180.157 21.176Q180.234 21.08 180.289 21A17.945 17.945 0 0 0 180.321 20.952A14.683 14.683 0 0 0 180.372 20.859A17.681 17.681 0 0 0 180.402 20.798Q180.44 20.714 180.44 20.63A2.258 2.258 0 0 0 180.378 20.474A2.928 2.928 0 0 0 180.374 20.469A2.17 2.17 0 0 0 180.216 20.399A2.698 2.698 0 0 0 180.209 20.399Q180.097 20.399 180.041 20.466A26.352 26.352 0 0 0 180.002 20.513Q179.987 20.532 179.974 20.549A12.788 12.788 0 0 0 179.95 20.581Q179.873 20.7 179.786 20.819Q179.698 20.938 179.583 21.029A8.961 8.961 0 0 1 179.405 21.137A11.002 11.002 0 0 1 179.31 21.176Q179.152 21.232 178.928 21.232Q178.711 21.232 178.512 21.162A9.41 9.41 0 0 1 178.157 20.937A10.742 10.742 0 0 1 178.155 20.935A10.148 10.148 0 0 1 177.998 20.73A13.99 13.99 0 0 1 177.899 20.522A14.497 14.497 0 0 1 177.829 20.268Q177.806 20.143 177.798 20A26.817 26.817 0 0 1 177.794 19.902ZM160.49 21.05L160.49 21.267A12.437 12.437 0 0 0 160.49 21.29Q160.491 21.321 160.493 21.362A37.885 37.885 0 0 0 160.494 21.376A4.031 4.031 0 0 0 160.51 21.469A4.921 4.921 0 0 0 160.525 21.512Q160.553 21.582 160.613 21.631Q160.66 21.67 160.74 21.678A4.425 4.425 0 0 0 160.784 21.68A3.105 3.105 0 0 0 160.895 21.661A2.79 2.79 0 0 0 160.994 21.596A2.175 2.175 0 0 0 161.062 21.48A2.923 2.923 0 0 0 161.068 21.446A13.958 13.958 0 0 0 161.073 21.381Q161.078 21.305 161.078 21.204A44.546 44.546 0 0 0 161.078 21.197L161.078 17.004A44.226 44.226 0 0 0 161.076 16.874A49.881 49.881 0 0 0 161.075 16.829A5.027 5.027 0 0 0 161.062 16.732A4.139 4.139 0 0 0 161.04 16.665Q161.008 16.591 160.945 16.546Q160.882 16.5 160.77 16.5Q160.694 16.5 160.641 16.521A2.056 2.056 0 0 0 160.595 16.546Q160.532 16.591 160.504 16.665A4.762 4.762 0 0 0 160.478 16.766A5.995 5.995 0 0 0 160.473 16.829Q160.469 16.92 160.469 17.011L160.469 18.516A2.504 2.504 0 0 0 160.457 18.498Q160.428 18.459 160.357 18.38A10.281 10.281 0 0 0 160.279 18.302Q160.234 18.262 160.179 18.22A21.748 21.748 0 0 0 160.105 18.166Q159.944 18.054 159.717 17.97A13.078 13.078 0 0 0 159.455 17.905Q159.329 17.886 159.188 17.886Q158.801 17.886 158.524 18.01A11.161 11.161 0 0 0 158.411 18.068A15.529 15.529 0 0 0 158.032 18.379A14.284 14.284 0 0 0 157.918 18.527Q157.732 18.803 157.659 19.132A31.593 31.593 0 0 0 157.6 19.484A24.8 24.8 0 0 0 157.585 19.748A25.356 25.356 0 0 0 157.6 20.012Q157.616 20.17 157.652 20.347Q157.718 20.679 157.9 20.977Q158.082 21.274 158.394 21.477A11.715 11.715 0 0 0 158.748 21.629Q158.901 21.667 159.08 21.677A22.684 22.684 0 0 0 159.202 21.68A19.893 19.893 0 0 0 159.439 21.667Q159.56 21.652 159.664 21.622A11.619 11.619 0 0 0 159.703 21.61Q159.916 21.54 160.07 21.442Q160.224 21.344 160.326 21.236Q160.425 21.13 160.487 21.054A20.372 20.372 0 0 0 160.49 21.05ZM184.01 21.05L184.01 21.267A12.437 12.437 0 0 0 184.01 21.29Q184.011 21.321 184.013 21.362A37.885 37.885 0 0 0 184.014 21.376A4.031 4.031 0 0 0 184.03 21.469A4.921 4.921 0 0 0 184.045 21.512Q184.073 21.582 184.133 21.631Q184.18 21.67 184.26 21.678A4.425 4.425 0 0 0 184.304 21.68A3.105 3.105 0 0 0 184.415 21.661A2.79 2.79 0 0 0 184.514 21.596A2.175 2.175 0 0 0 184.582 21.48A2.923 2.923 0 0 0 184.588 21.446A13.958 13.958 0 0 0 184.593 21.381Q184.598 21.305 184.598 21.204A44.546 44.546 0 0 0 184.598 21.197L184.598 17.004A44.226 44.226 0 0 0 184.596 16.874A49.881 49.881 0 0 0 184.595 16.829A5.027 5.027 0 0 0 184.582 16.732A4.139 4.139 0 0 0 184.56 16.665Q184.528 16.591 184.465 16.546Q184.402 16.5 184.29 16.5Q184.214 16.5 184.161 16.521A2.056 2.056 0 0 0 184.115 16.546Q184.052 16.591 184.024 16.665A4.762 4.762 0 0 0 183.998 16.766A5.995 5.995 0 0 0 183.993 16.829Q183.989 16.92 183.989 17.011L183.989 18.516A2.504 2.504 0 0 0 183.977 18.498Q183.948 18.459 183.877 18.38A10.281 10.281 0 0 0 183.799 18.302Q183.754 18.262 183.699 18.22A21.748 21.748 0 0 0 183.625 18.166Q183.464 18.054 183.237 17.97A13.078 13.078 0 0 0 182.975 17.905Q182.849 17.886 182.708 17.886Q182.321 17.886 182.044 18.01A11.161 11.161 0 0 0 181.931 18.068A15.529 15.529 0 0 0 181.552 18.379A14.284 14.284 0 0 0 181.438 18.527Q181.252 18.803 181.179 19.132A31.593 31.593 0 0 0 181.12 19.484A24.8 24.8 0 0 0 181.105 19.748A25.356 25.356 0 0 0 181.12 20.012Q181.136 20.17 181.172 20.347Q181.238 20.679 181.42 20.977Q181.602 21.274 181.914 21.477A11.715 11.715 0 0 0 182.268 21.629Q182.421 21.667 182.6 21.677A22.684 22.684 0 0 0 182.722 21.68A19.893 19.893 0 0 0 182.959 21.667Q183.08 21.652 183.184 21.622A11.619 11.619 0 0 0 183.223 21.61Q183.436 21.54 183.59 21.442Q183.744 21.344 183.846 21.236Q183.945 21.13 184.007 21.054A20.372 20.372 0 0 0 184.01 21.05ZM164.312 18.264L163.325 20.903L162.331 18.264Q162.271 18.09 162.211 17.993A6.228 6.228 0 0 0 162.205 17.984A2.038 2.038 0 0 0 162.077 17.895Q162.04 17.886 161.995 17.886Q161.848 17.886 161.771 17.977A4.199 4.199 0 0 0 161.73 18.035Q161.694 18.095 161.694 18.152A4.814 4.814 0 0 0 161.699 18.22A3.684 3.684 0 0 0 161.712 18.278A9.92 9.92 0 0 0 161.723 18.311Q161.738 18.355 161.766 18.427A84.529 84.529 0 0 0 161.785 18.474L162.891 21.232Q162.952 21.378 163.01 21.483A12.632 12.632 0 0 0 163.056 21.558A2.582 2.582 0 0 0 163.21 21.666Q163.255 21.678 163.309 21.68A5.626 5.626 0 0 0 163.325 21.68A4.256 4.256 0 0 0 163.424 21.669A2.598 2.598 0 0 0 163.588 21.558Q163.646 21.469 163.706 21.338A30.263 30.263 0 0 0 163.752 21.232L164.858 18.474A79.208 79.208 0 0 0 164.883 18.411Q164.913 18.334 164.927 18.292A7.545 7.545 0 0 0 164.932 18.278A3.771 3.771 0 0 0 164.946 18.209A4.945 4.945 0 0 0 164.949 18.152Q164.949 18.097 164.909 18.032A4.909 4.909 0 0 0 164.872 17.981A2.49 2.49 0 0 0 164.723 17.893A3.793 3.793 0 0 0 164.648 17.886A3.446 3.446 0 0 0 164.568 17.895Q164.513 17.908 164.475 17.941A2.009 2.009 0 0 0 164.438 17.984A7.867 7.867 0 0 0 164.399 18.054Q164.358 18.133 164.318 18.248A26.244 26.244 0 0 0 164.312 18.264ZM202.861 18.264L201.874 20.903L200.88 18.264Q200.82 18.09 200.76 17.993A6.228 6.228 0 0 0 200.754 17.984A2.038 2.038 0 0 0 200.626 17.895Q200.589 17.886 200.544 17.886Q200.397 17.886 200.32 17.977A4.199 4.199 0 0 0 200.279 18.035Q200.243 18.095 200.243 18.152A4.814 4.814 0 0 0 200.248 18.22A3.684 3.684 0 0 0 200.261 18.278A9.92 9.92 0 0 0 200.272 18.311Q200.287 18.355 200.315 18.427A84.529 84.529 0 0 0 200.334 18.474L201.44 21.232Q201.501 21.378 201.559 21.483A12.632 12.632 0 0 0 201.605 21.558A2.582 2.582 0 0 0 201.759 21.666Q201.804 21.678 201.858 21.68A5.626 5.626 0 0 0 201.874 21.68A4.256 4.256 0 0 0 201.973 21.669A2.598 2.598 0 0 0 202.137 21.558Q202.195 21.469 202.255 21.338A30.263 30.263 0 0 0 202.301 21.232L203.407 18.474A79.208 79.208 0 0 0 203.432 18.411Q203.462 18.334 203.476 18.292A7.545 7.545 0 0 0 203.481 18.278A3.771 3.771 0 0 0 203.495 18.209A4.945 4.945 0 0 0 203.498 18.152Q203.498 18.097 203.458 18.032A4.909 4.909 0 0 0 203.421 17.981A2.49 2.49 0 0 0 203.272 17.893A3.793 3.793 0 0 0 203.197 17.886A3.446 3.446 0 0 0 203.117 17.895Q203.062 17.908 203.024 17.941A2.009 2.009 0 0 0 202.987 17.984A7.867 7.867 0 0 0 202.948 18.054Q202.907 18.133 202.867 18.248A26.244 26.244 0 0 0 202.861 18.264ZM159.076 21.172A9.992 9.992 0 0 0 159.321 21.204Q159.524 21.204 159.731 21.134A9.14 9.14 0 0 0 159.831 21.093A9.773 9.773 0 0 0 160.102 20.9A10.93 10.93 0 0 0 160.26 20.697A14.782 14.782 0 0 0 160.371 20.473Q160.437 20.309 160.461 20.094A24.26 24.26 0 0 0 160.476 19.818Q160.476 19.356 160.343 19.073A18.755 18.755 0 0 0 160.322 19.029Q160.196 18.777 160.025 18.632A12.131 12.131 0 0 0 159.883 18.528A9.354 9.354 0 0 0 159.64 18.418A19.608 19.608 0 0 0 159.535 18.392Q159.402 18.362 159.3 18.362A11.478 11.478 0 0 0 159.207 18.366A9.465 9.465 0 0 0 158.845 18.467Q158.642 18.572 158.499 18.761Q158.355 18.95 158.282 19.206A17.995 17.995 0 0 0 158.242 19.373A20.798 20.798 0 0 0 158.208 19.755A27.923 27.923 0 0 0 158.211 19.894Q158.227 20.21 158.317 20.438Q158.371 20.576 158.438 20.688A11.647 11.647 0 0 0 158.586 20.886Q158.747 21.057 158.943 21.131A12.502 12.502 0 0 0 159.076 21.172ZM182.596 21.172A9.992 9.992 0 0 0 182.841 21.204Q183.044 21.204 183.251 21.134A9.14 9.14 0 0 0 183.351 21.093A9.773 9.773 0 0 0 183.622 20.9A10.93 10.93 0 0 0 183.78 20.697A14.782 14.782 0 0 0 183.891 20.473Q183.957 20.309 183.981 20.094A24.26 24.26 0 0 0 183.996 19.818Q183.996 19.356 183.863 19.073A18.755 18.755 0 0 0 183.842 19.029Q183.716 18.777 183.545 18.632A12.131 12.131 0 0 0 183.403 18.528A9.354 9.354 0 0 0 183.16 18.418A19.608 19.608 0 0 0 183.055 18.392Q182.922 18.362 182.82 18.362A11.478 11.478 0 0 0 182.727 18.366A9.465 9.465 0 0 0 182.365 18.467Q182.162 18.572 182.019 18.761Q181.875 18.95 181.802 19.206A17.995 17.995 0 0 0 181.762 19.373A20.798 20.798 0 0 0 181.728 19.755A27.923 27.923 0 0 0 181.731 19.894Q181.747 20.21 181.837 20.438Q181.891 20.576 181.958 20.688A11.647 11.647 0 0 0 182.106 20.886Q182.267 21.057 182.463 21.131A12.502 12.502 0 0 0 182.596 21.172ZM155.772 19.608L153.931 19.608L154.834 17.263L155.772 19.608ZM147.704 19.422A124.043 124.043 0 0 0 147.736 19.461A187.068 187.068 0 0 0 147.977 19.75A209.521 209.521 0 0 0 148.062 19.85Q148.233 20.049 148.405 20.238A280.942 280.942 0 0 0 148.527 20.372Q148.575 20.424 148.619 20.471A146.266 146.266 0 0 0 148.702 20.56A32.139 32.139 0 0 1 148.675 20.594Q148.644 20.633 148.602 20.683A116.402 116.402 0 0 1 148.562 20.732A12.456 12.456 0 0 1 148.433 20.863A15.356 15.356 0 0 1 148.342 20.938A13.22 13.22 0 0 1 148.163 21.051A16.357 16.357 0 0 1 148.041 21.11Q147.869 21.183 147.652 21.183A9.592 9.592 0 0 1 147.375 21.144A8.638 8.638 0 0 1 147.243 21.092Q147.057 21.001 146.921 20.854Q146.784 20.707 146.711 20.525Q146.637 20.343 146.637 20.154A8.237 8.237 0 0 1 146.655 19.979A6.431 6.431 0 0 1 146.711 19.822A10.984 10.984 0 0 1 146.895 19.564A12.277 12.277 0 0 1 146.903 19.556A14.899 14.899 0 0 1 147.147 19.354A16.679 16.679 0 0 1 147.176 19.335Q147.33 19.237 147.491 19.146Q147.572 19.259 147.704 19.422ZM167.826 19.706Q167.826 20.014 167.802 20.256A11.719 11.719 0 0 1 167.753 20.495A9.411 9.411 0 0 1 167.672 20.679Q167.595 20.819 167.469 20.917Q167.343 21.015 167.193 21.078Q167.042 21.141 166.885 21.173A16.044 16.044 0 0 1 166.654 21.202A14.108 14.108 0 0 1 166.58 21.204A10.041 10.041 0 0 1 166.436 21.194Q166.337 21.18 166.258 21.145A7.637 7.637 0 0 1 166.147 21.084A5.572 5.572 0 0 1 166.045 20.998A5.836 5.836 0 0 1 165.939 20.839A5.49 5.49 0 0 1 165.926 20.805A6.447 6.447 0 0 1 165.894 20.689A5.291 5.291 0 0 1 165.887 20.602Q165.887 20.553 165.905 20.476A4.746 4.746 0 0 1 165.935 20.386A6.234 6.234 0 0 1 165.971 20.319A4.921 4.921 0 0 1 166.039 20.232A6.678 6.678 0 0 1 166.111 20.168A5.299 5.299 0 0 1 166.201 20.113Q166.247 20.091 166.302 20.072A10.661 10.661 0 0 1 166.356 20.056A55.947 55.947 0 0 1 166.613 19.996A71.051 71.051 0 0 1 166.832 19.955A87.518 87.518 0 0 0 167.072 19.909Q167.194 19.884 167.329 19.853A147.944 147.944 0 0 0 167.42 19.832Q167.527 19.805 167.61 19.781A25.521 25.521 0 0 0 167.658 19.766A34.628 34.628 0 0 0 167.728 19.742Q167.762 19.731 167.792 19.719A18.009 18.009 0 0 0 167.826 19.706ZM195.042 19.706Q195.042 20.014 195.018 20.256A11.719 11.719 0 0 1 194.969 20.495A9.411 9.411 0 0 1 194.888 20.679Q194.811 20.819 194.685 20.917Q194.559 21.015 194.409 21.078Q194.258 21.141 194.101 21.173A16.044 16.044 0 0 1 193.87 21.202A14.108 14.108 0 0 1 193.796 21.204A10.041 10.041 0 0 1 193.652 21.194Q193.553 21.18 193.474 21.145A7.637 7.637 0 0 1 193.363 21.084A5.572 5.572 0 0 1 193.261 20.998A5.836 5.836 0 0 1 193.155 20.839A5.49 5.49 0 0 1 193.142 20.805A6.447 6.447 0 0 1 193.11 20.689A5.291 5.291 0 0 1 193.103 20.602Q193.103 20.553 193.121 20.476A4.746 4.746 0 0 1 193.151 20.386A6.234 6.234 0 0 1 193.187 20.319A4.921 4.921 0 0 1 193.255 20.232A6.678 6.678 0 0 1 193.327 20.168A5.299 5.299 0 0 1 193.417 20.113Q193.463 20.091 193.518 20.072A10.661 10.661 0 0 1 193.572 20.056A55.947 55.947 0 0 1 193.829 19.996A71.051 71.051 0 0 1 194.048 19.955A87.518 87.518 0 0 0 194.288 19.909Q194.41 19.884 194.545 19.853A147.944 147.944 0 0 0 194.636 19.832Q194.743 19.805 194.826 19.781A25.521 25.521 0 0 0 194.874 19.766A34.628 34.628 0 0 0 194.944 19.742Q194.978 19.731 195.008 19.719A18.009 18.009 0 0 0 195.042 19.706ZM206.375 19.706Q206.375 20.014 206.351 20.256A11.719 11.719 0 0 1 206.302 20.495A9.411 9.411 0 0 1 206.221 20.679Q206.144 20.819 206.018 20.917Q205.892 21.015 205.742 21.078Q205.591 21.141 205.434 21.173A16.044 16.044 0 0 1 205.203 21.202A14.108 14.108 0 0 1 205.129 21.204A10.041 10.041 0 0 1 204.985 21.194Q204.886 21.18 204.807 21.145A7.637 7.637 0 0 1 204.696 21.084A5.572 5.572 0 0 1 204.594 20.998A5.836 5.836 0 0 1 204.488 20.839A5.49 5.49 0 0 1 204.475 20.805A6.447 6.447 0 0 1 204.443 20.689A5.291 5.291 0 0 1 204.436 20.602Q204.436 20.553 204.454 20.476A4.746 4.746 0 0 1 204.484 20.386A6.234 6.234 0 0 1 204.52 20.319A4.921 4.921 0 0 1 204.588 20.232A6.678 6.678 0 0 1 204.66 20.168A5.299 5.299 0 0 1 204.75 20.113Q204.796 20.091 204.851 20.072A10.661 10.661 0 0 1 204.905 20.056A55.947 55.947 0 0 1 205.162 19.996A71.051 71.051 0 0 1 205.381 19.955A87.518 87.518 0 0 0 205.621 19.909Q205.743 19.884 205.878 19.853A147.944 147.944 0 0 0 205.969 19.832Q206.076 19.805 206.159 19.781A25.521 25.521 0 0 0 206.207 19.766A34.628 34.628 0 0 0 206.277 19.742Q206.311 19.731 206.341 19.719A18.009 18.009 0 0 0 206.375 19.706ZM179.887 19.482L177.801 19.482A28.069 28.069 0 0 1 177.814 19.387Q177.827 19.303 177.847 19.202A10.166 10.166 0 0 1 177.92 18.976A12.334 12.334 0 0 1 177.969 18.88Q178.018 18.789 178.095 18.691A8.296 8.296 0 0 1 178.243 18.546A9.616 9.616 0 0 1 178.284 18.516Q178.396 18.439 178.54 18.387Q178.683 18.334 178.865 18.334Q179.166 18.334 179.376 18.464Q179.586 18.593 179.705 18.796A14.726 14.726 0 0 1 179.78 18.94Q179.813 19.014 179.831 19.082A7.079 7.079 0 0 1 179.849 19.164A57.705 57.705 0 0 1 179.879 19.404A51.717 51.717 0 0 1 179.887 19.482ZM147.722 18.46A5.735 5.735 0 0 0 147.714 18.448Q147.698 18.426 147.666 18.383A159.702 159.702 0 0 1 147.622 18.324A204.664 204.664 0 0 1 147.575 18.261Q147.526 18.194 147.484 18.138A28.341 28.341 0 0 0 147.469 18.119Q147.447 18.089 147.435 18.075A1.535 1.535 0 0 0 147.428 18.068Q147.372 17.991 147.313 17.854A6.976 6.976 0 0 1 147.255 17.63A6.56 6.56 0 0 1 147.253 17.578Q147.253 17.466 147.299 17.357Q147.344 17.249 147.428 17.165A6.428 6.428 0 0 1 147.588 17.049A7.566 7.566 0 0 1 147.631 17.029A6.258 6.258 0 0 1 147.86 16.977A7.29 7.29 0 0 1 147.89 16.976A6.985 6.985 0 0 1 148.099 17.006A5.558 5.558 0 0 1 148.342 17.158Q148.513 17.34 148.513 17.585A5.96 5.96 0 0 1 148.479 17.788A5.572 5.572 0 0 1 148.45 17.854A8.463 8.463 0 0 1 148.321 18.039A9.906 9.906 0 0 1 148.279 18.082A14.839 14.839 0 0 1 148.113 18.22A17.789 17.789 0 0 1 148.027 18.278A67.874 67.874 0 0 1 147.801 18.415A77.011 77.011 0 0 1 147.722 18.46Z"/>'

    return watermarkEl
  }
}