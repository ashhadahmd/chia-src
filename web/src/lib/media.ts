/* Image preparation for docs: everything is stored as PNG, JPEG or GIF so PDF, Word and
   Google exports can embed it. Large photos are scaled down before upload. */
import nunitoUrl from '@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2?url'
import { api } from './api'
import { renderDiagram } from './diagram'

const STORED = ['image/png', 'image/jpeg', 'image/gif']
const MAX_SIDE = 2400
const KEEP_BYTES = 3 * 1024 * 1024
const MAX_BYTES = 10 * 1024 * 1024

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp,image/svg+xml'

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('That image could not be opened'))
    img.src = src
  })
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the image'))), type, quality),
  )
}

function hasAlpha(img: HTMLImageElement): boolean {
  const c = document.createElement('canvas')
  c.width = c.height = 48
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, 48, 48)
  const { data } = ctx.getImageData(0, 0, 48, 48)
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true
  return false
}

/** A PNG/JPEG/GIF no larger than MAX_SIDE, ready for upload. */
export async function prepareImage(file: Blob): Promise<Blob> {
  if (file.type === 'image/gif' && file.size <= MAX_BYTES) return file // keeps animation
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    let w = img.naturalWidth || 1200
    let h = img.naturalHeight || 800
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h))
    if (STORED.includes(file.type) && scale === 1 && file.size <= KEEP_BYTES) return file
    w = Math.max(1, Math.round(w * scale))
    h = Math.max(1, Math.round(h * scale))
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h })
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
    if (file.type === 'image/jpeg' || !hasAlpha(img)) return toBlob(canvas, 'image/jpeg', 0.88)
    return toBlob(canvas, 'image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}

let fontCss: Promise<string> | null = null

/** @font-face for Nunito as a data: URI; SVG drawn as an image can't reach the page's fonts. */
function embeddedFont(): Promise<string> {
  fontCss ??= fetch(nunitoUrl)
    .then((r) => r.blob())
    .then(
      (b) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = () =>
            resolve(`@font-face{font-family:'Nunito Variable';font-weight:200 1000;src:url(${reader.result}) format('woff2');}`)
          reader.readAsDataURL(b)
        }),
    )
    .catch(() => '')
  return fontCss
}

/** Rasterise an SVG (a rendered diagram) to a transparent PNG at `scale`× its size. */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const font = await embeddedFont()
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  root.removeAttribute('style')
  const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style')
  style.textContent = font
  root.insertBefore(style, root.firstChild)
  const blob = new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImage(url)
    const canvas = Object.assign(document.createElement('canvas'), {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    })
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0, width, height)
    return toBlob(canvas, 'image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}

export type Align = 'left' | 'center' | 'right'

/** Width of the page's text column in CSS px (Letter, 1in margins). */
export const TEXT_WIDTH = 626

export const clampWidth = (n: number) => Math.min(100, Math.max(10, Math.round(n)))

/** Diagrams without a chosen size show at their drawn size, as a share of the text column. */
export const autoWidth = (natural: number | null) => clampWidth(natural ? Math.max(30, (natural / TEXT_WIDTH) * 100) : 100)

/** Upload pictures (files, pastes, drops) and return their asset URLs. */
export async function uploadImages(files: Blob[]): Promise<string[]> {
  const urls: string[] = []
  for (const file of files) {
    const ready = await prepareImage(file)
    const { url } = await api.uploadAsset(ready, file instanceof File ? file.name : 'image')
    urls.push(url)
  }
  return urls
}

/** Light-theme picture of a diagram, stored for PDF, Word and Google exports. */
export async function diagramPicture(code: string): Promise<{ src: string; natural: number }> {
  const drawn = await renderDiagram(code, 'light')
  const png = await svgToPng(drawn.svg, drawn.width, drawn.height, 2)
  const { url } = await api.uploadAsset(png, 'diagram.png')
  return { src: url, natural: drawn.width }
}
