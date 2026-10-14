/* Diagrams are written in Mermaid syntax and drawn in Chia's own Oat & Earth style: soft
   sage, eucalyptus and terracotta fills, rounded shapes, Nunito labels, light and dark. */
import type { Mermaid, MermaidConfig } from 'mermaid'
import { useEffect, useState } from 'react'

export type Mode = 'light' | 'dark'

const FONT = "'Nunito Variable', Nunito, ui-rounded, system-ui, sans-serif"

interface Palette {
  page: string
  ink: string
  soft: string
  line: string
  fills: string[] // soft fills, one per accent
  strokes: string[] // matching accents
  note: string
  noteStroke: string
  cluster: string
}

const PALETTES: Record<Mode, Palette> = {
  light: {
    page: '#FDFCF9',
    ink: '#2C2C29',
    soft: '#55554F',
    line: '#8A877D',
    fills: ['#E4EADB', '#DCEAE6', '#F4E1DA', '#F3E8CF', '#ECE0EA', '#DFE5EC', '#EFE5DC', '#E9E6DE'],
    strokes: ['#5A6B47', '#3F6E66', '#B05A47', '#9A7424', '#7A4F72', '#4A5A6E', '#8C5A3C', '#6F6E66'],
    note: '#F6EDD7',
    noteStroke: '#C9A65A',
    cluster: '#F4F1EA',
  },
  dark: {
    page: '#22211D',
    ink: '#ECE7DC',
    soft: '#C4BFB3',
    line: '#8F8C82',
    fills: ['#323A29', '#25382F', '#45302A', '#41371F', '#3B2C39', '#2A3340', '#3D3027', '#33322C'],
    strokes: ['#A3B68F', '#8BB5AC', '#DC9A8A', '#D9B562', '#C79BC0', '#9DB0C6', '#C99A7C', '#A9A69B'],
    note: '#3A3423',
    noteStroke: '#B39350',
    cluster: '#2A2924',
  },
}

function config(mode: Mode): MermaidConfig {
  const p = PALETTES[mode]
  const vars: Record<string, string | boolean> = {
    darkMode: mode === 'dark',
    background: p.page,
    fontFamily: FONT,
    fontSize: '15px',
    textColor: p.ink,
    lineColor: p.line,
    primaryColor: p.fills[0],
    primaryBorderColor: p.strokes[0],
    primaryTextColor: p.ink,
    secondaryColor: p.fills[1],
    secondaryBorderColor: p.strokes[1],
    secondaryTextColor: p.ink,
    tertiaryColor: p.fills[2],
    tertiaryBorderColor: p.strokes[2],
    tertiaryTextColor: p.ink,
    mainBkg: p.fills[0],
    nodeBorder: p.strokes[0],
    nodeTextColor: p.ink,
    clusterBkg: p.cluster,
    clusterBorder: p.line,
    titleColor: p.ink,
    edgeLabelBackground: p.page,
    noteBkgColor: p.note,
    noteBorderColor: p.noteStroke,
    noteTextColor: p.ink,
    actorBkg: p.fills[0],
    actorBorder: p.strokes[0],
    actorTextColor: p.ink,
    actorLineColor: p.line,
    signalColor: p.soft,
    signalTextColor: p.ink,
    labelBoxBkgColor: p.fills[1],
    labelBoxBorderColor: p.strokes[1],
    labelTextColor: p.ink,
    loopTextColor: p.ink,
    activationBkgColor: p.fills[2],
    activationBorderColor: p.strokes[2],
    sequenceNumberColor: p.page,
    pieTitleTextColor: p.ink,
    pieSectionTextColor: mode === 'dark' ? p.page : '#FDFCF9',
    pieLegendTextColor: p.ink,
    pieStrokeColor: p.page,
    pieOuterStrokeColor: p.line,
    pieOpacity: '1',
    sectionBkgColor: p.fills[0],
    altSectionBkgColor: p.page,
    sectionBkgColor2: p.fills[1],
    taskBkgColor: p.fills[1],
    taskBorderColor: p.strokes[1],
    taskTextColor: p.ink,
    taskTextDarkColor: p.ink,
    taskTextOutsideColor: p.ink,
    activeTaskBkgColor: p.fills[0],
    activeTaskBorderColor: p.strokes[0],
    doneTaskBkgColor: p.fills[7],
    doneTaskBorderColor: p.strokes[7],
    critBkgColor: p.fills[2],
    critBorderColor: p.strokes[2],
    todayLineColor: p.strokes[2],
    gridColor: p.line,
    quadrant1Fill: p.fills[0],
    quadrant2Fill: p.fills[1],
    quadrant3Fill: p.fills[3],
    quadrant4Fill: p.fills[2],
    quadrantPointFill: p.strokes[2],
    quadrantTitleFill: p.ink,
    quadrantXAxisTextFill: p.soft,
    quadrantYAxisTextFill: p.soft,
    quadrantInternalBorderStrokeFill: p.page,
    quadrantExternalBorderStrokeFill: p.line,
    attributeBackgroundColorOdd: p.page,
    attributeBackgroundColorEven: p.cluster,
  }
  p.strokes.forEach((s, i) => {
    vars[`pie${i + 1}`] = s
    vars[`cScale${i}`] = p.fills[i]
    vars[`cScalePeer${i}`] = s
    vars[`cScaleLabel${i}`] = p.ink
    vars[`cScaleInv${i}`] = s // mind map branch underlines
    vars[`git${i}`] = s // the mind map's central topic uses git0
    vars[`gitBranchLabel${i}`] = p.page
  })
  for (let i = 8; i < 12; i++) {
    vars[`cScale${i}`] = p.fills[i % 8]
    vars[`cScaleLabel${i}`] = p.ink
  }
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: vars,
    fontFamily: FONT,
    htmlLabels: false, // plain SVG text: rasterises cleanly and survives PDF/Word export
    flowchart: { curve: 'basis', padding: 14, nodeSpacing: 44, rankSpacing: 52, diagramPadding: 12 },
    sequence: { actorMargin: 56, boxMargin: 12, messageMargin: 38, mirrorActors: false, noteMargin: 12 },
    mindmap: { padding: 14 },
    journey: { actorColours: p.strokes, sectionFills: p.fills, sectionColours: p.strokes.map(() => p.ink) },
    gantt: { useWidth: 820, barHeight: 26, barGap: 6, fontSize: 13, sectionFontSize: 13, leftPadding: 90 },
    themeCSS: `
      .node rect, .node polygon, .node circle, .node ellipse, .node path { stroke-width: 1.4px; }
      .node rect, rect.actor, .cluster rect, rect.note, rect.task, .er.entityBox { rx: 10px; ry: 10px; }
      .nodeLabel, .label text, text.actor, .messageText, .taskText, .sectionTitle, .titleText { font-weight: 650; }
      .edgePath .path, .flowchart-link { stroke-width: 1.6px; }
      .edgeLabel, .edgeLabel rect { font-weight: 600; }
      .cluster-label .nodeLabel, .cluster text { fill: ${p.soft}; font-weight: 750; }
      .pieTitleText, .titleText { font-size: 18px; font-weight: 800; }
      .mindmap-node .node-bkg, .section-root rect { rx: 14px; ry: 14px; }
      text.messageText { fill: ${p.ink}; }
    `,
  }
}

let loader: Promise<Mermaid> | null = null
const loadMermaid = () => (loader ??= import('mermaid').then((m) => m.default))

// Mermaid has one global config, so renders run one at a time.
let queue: Promise<unknown> = Promise.resolve()
let counter = 0

export interface Rendered {
  svg: string
  width: number
  height: number
}

function size(svg: string): { width: number; height: number } {
  const box = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg)
  return { width: box ? Math.ceil(parseFloat(box[1])) : 600, height: box ? Math.ceil(parseFloat(box[2])) : 400 }
}

/** Draws `code`; rejects with a readable message when the syntax is wrong. */
export function renderDiagram(code: string, mode: Mode): Promise<Rendered> {
  const run = async () => {
    const mermaid = await loadMermaid()
    mermaid.initialize(config(mode))
    const id = `chia-diagram-${++counter}`
    try {
      const { svg } = await mermaid.render(id, code.trim())
      return { svg, ...size(svg) }
    } catch (err) {
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
      throw new Error(friendlyError(err, code))
    }
  }
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

function friendlyError(err: unknown, code: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/No diagram type detected|UnknownDiagramError/i.test(raw))
    return 'Start with a diagram type on the first line, like “flowchart TD” or “sequenceDiagram”.'
  const lines = raw.split('\n').map((l) => l.trim())
  const line = /line (\d+)/i.exec(raw)?.[1]
  const source = line ? code.trim().split('\n')[Number(line) - 1]?.trim() : ''
  if (line && source) return `Line ${line} looks unfinished or has a typo: “${source.length > 48 ? source.slice(0, 47) + '…' : source}”`
  if (line) return `Line ${line} has a typo. Check its arrows and brackets.`
  return lines.find((l) => l) ?? 'This diagram has a mistake in it.'
}

/** The theme currently shown, following both the system setting and Chia's switch. */
export function useMode(): Mode {
  const read = (): Mode => {
    const set = document.documentElement.dataset.theme
    if (set === 'light' || set === 'dark') return set
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  const [mode, setMode] = useState<Mode>(read)
  useEffect(() => {
    const update = () => setMode(read())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    query.addEventListener('change', update)
    return () => {
      observer.disconnect()
      query.removeEventListener('change', update)
    }
  }, [])
  return mode
}

export interface Template {
  key: string
  label: string
  hint: string
  code: string
}

export const TEMPLATES: Template[] = [
  {
    key: 'flowchart',
    label: 'Flowchart',
    hint: 'Steps and decisions',
    code: `flowchart TD
  idea([Idea]) --> draft[Write a draft]
  draft --> review{Ready?}
  review -- Yes --> publish[Publish]
  review -- Not yet --> draft
  publish --> share([Share it])`,
  },
  {
    key: 'sequence',
    label: 'Sequence',
    hint: 'Who talks to whom, in order',
    code: `sequenceDiagram
  actor Reader
  participant Chia
  participant Drive as Google Drive
  Reader->>Chia: Edit a doc
  Chia-->>Reader: Saved
  Chia->>Drive: Back up a copy
  Note over Chia,Drive: Runs quietly in the background`,
  },
  {
    key: 'mindmap',
    label: 'Mind map',
    hint: 'Ideas branching from one topic',
    code: `mindmap
  root((Launch plan))
    Product
      Polish onboarding
      Fix top bugs
    Marketing
      Blog post
      Newsletter
    Support
      Help articles`,
  },
  {
    key: 'org',
    label: 'Org chart',
    hint: 'Teams and reporting lines',
    code: `flowchart TB
  ceo[Founder]
  ceo --> eng[Engineering]
  ceo --> design[Design]
  ceo --> ops[Operations]
  eng --> web[Web]
  eng --> api[API]
  design --> brand[Brand]`,
  },
  {
    key: 'timeline',
    label: 'Timeline',
    hint: 'Milestones over time',
    code: `timeline
  title Project milestones
  January : Research : Interviews
  March : Prototype
  May : Beta launch
  July : General release`,
  },
  {
    key: 'gantt',
    label: 'Schedule',
    hint: 'Tasks across dates (Gantt)',
    code: `gantt
  title Website refresh
  dateFormat YYYY-MM-DD
  section Plan
    Research        :done, r1, 2026-01-05, 10d
    Wireframes      :active, w1, after r1, 8d
  section Build
    Front end       :b1, after w1, 15d
    Content         :b2, after w1, 12d
  section Launch
    Go live         :milestone, after b1, 0d`,
  },
  {
    key: 'pie',
    label: 'Pie chart',
    hint: 'Parts of a whole',
    code: `pie showData
  title Where time goes
  "Writing" : 45
  "Editing" : 25
  "Research" : 20
  "Meetings" : 10`,
  },
  {
    key: 'quadrant',
    label: 'Quadrant',
    hint: 'Two-by-two prioritising',
    code: `quadrantChart
  title Effort vs impact
  x-axis Low effort --> High effort
  y-axis Low impact --> High impact
  quadrant-1 Plan carefully
  quadrant-2 Do first
  quadrant-3 Maybe later
  quadrant-4 Skip
  Dark mode: [0.3, 0.7]
  Offline: [0.8, 0.8]
  New icons: [0.2, 0.2]
  Rewrite: [0.85, 0.3]`,
  },
  {
    key: 'state',
    label: 'States',
    hint: 'How something changes status',
    code: `stateDiagram-v2
  [*] --> Draft
  Draft --> Review: Submit
  Review --> Draft: Changes needed
  Review --> Published: Approve
  Published --> [*]`,
  },
  {
    key: 'journey',
    label: 'Journey',
    hint: 'How a person feels at each step',
    code: `journey
  title Signing up
  section Discover
    Find Chia: 4: Visitor
    Read the homepage: 3: Visitor
  section Start
    Create an account: 5: Visitor
    Write the first doc: 4: Writer`,
  },
  {
    key: 'er',
    label: 'Data model',
    hint: 'Records and how they relate',
    code: `erDiagram
  USER ||--o{ DOCUMENT : owns
  DOCUMENT ||--o{ IMAGE : contains
  USER {
    string email
    string username
  }
  DOCUMENT {
    string title
    string kind
  }`,
  },
  {
    key: 'class',
    label: 'Classes',
    hint: 'Types, fields and links',
    code: `classDiagram
  class Document {
    +String title
    +save()
  }
  class Sheet {
    +rows
  }
  class Slides {
    +slides
  }
  Document <|-- Sheet
  Document <|-- Slides`,
  },
]
