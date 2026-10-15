import { Plus, Trash } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import type { Slide, SlidesBody } from '../lib/api'
import { softSpring } from '../lib/kinds'

/** A short random id for a new slide, so edits to it can be matched up with other people's. */
const slideId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)

export default function SlidesEditor({ body, onChange, readOnly }: { body: SlidesBody; onChange: (b: SlidesBody) => void; readOnly: boolean }) {
  const [current, setCurrent] = useState(0)
  const slides = body.slides.length ? body.slides : [{ id: 'first', title: '', body: '' }]
  const index = Math.min(current, slides.length - 1)
  const slide = slides[index]

  const update = (patch: Partial<typeof slide>) => onChange({ slides: slides.map((s, i) => (i === index ? { ...s, ...patch } : s)) })
  const add = () => {
    onChange({ slides: [...slides.slice(0, index + 1), { id: slideId(), title: '', body: '' }, ...slides.slice(index + 1)] })
    setCurrent(index + 1)
  }
  const remove = () => {
    if (slides.length === 1) return
    onChange({ slides: slides.filter((_, i) => i !== index) })
    setCurrent(Math.max(0, index - 1))
  }

  return (
    <div className="deck">
      <ol className="filmstrip" aria-label="Slides">
        {slides.map((s, i) => (
          <motion.li key={s.id ?? i} layout>
            <button className="film" data-active={i === index} onClick={() => setCurrent(i)}>
              <span className="film-num">{i + 1}</span>
              <span className="film-frame">
                <span className="film-title">{s.title || 'Untitled'}</span>
              </span>
            </button>
          </motion.li>
        ))}
        {!readOnly && (
          <li>
            <button className="film film-add" onClick={add} aria-label="Add slide">
              <Plus size={18} weight="bold" />
            </button>
          </li>
        )}
      </ol>
      <AnimatePresence mode="wait">
        <motion.section
          key={slide.id ?? index}
          className="stage"
          initial={{ opacity: 0, scale: 0.97, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
          transition={softSpring}
        >
          <input className="stage-title" readOnly={readOnly} value={slide.title} onChange={(e) => update({ title: e.target.value })} placeholder="Slide title" />
          <textarea className="stage-body" readOnly={readOnly} value={slide.body} onChange={(e) => update({ body: e.target.value })} placeholder="Points or notes. Lines starting with - become bullets" />
          <button className="icon-btn stage-remove" onClick={remove} disabled={readOnly || slides.length === 1} aria-label="Delete slide" title="Delete slide">
            <Trash />
          </button>
        </motion.section>
      </AnimatePresence>
      <PrintDeck slides={slides} />
    </div>
  )
}

/** Every slide, one per landscape page; shown only when printing (see @media print). */
export function PrintDeck({ slides }: { slides: Slide[] }) {
  return (
    <div className="print-deck" aria-hidden="true">
      {slides.map((s, i) => (
        <section key={s.id ?? i} className="print-slide">
          <SlideFace slide={s} />
        </section>
      ))}
    </div>
  )
}

/** A slide as it reads: the title, then its lines; "- " lines are bullets. */
export function SlideFace({ slide }: { slide: Slide }) {
  const groups: { bullets: boolean; lines: string[] }[] = []
  for (const line of slide.body.split('\n')) {
    if (!line.trim()) continue
    const bullet = /^\s*[-*] /.test(line)
    const text = bullet ? line.trim().slice(2) : line.trim()
    const last = groups.at(-1)
    if (last && last.bullets === bullet) last.lines.push(text)
    else groups.push({ bullets: bullet, lines: [text] })
  }
  return (
    <>
      <h2 className="slide-face-title">{slide.title || 'Untitled'}</h2>
      {groups.map((g, i) =>
        g.bullets ? (
          <ul key={i}>
            {g.lines.map((l, j) => (
              <li key={j}>{l}</li>
            ))}
          </ul>
        ) : (
          g.lines.map((l, j) => <p key={`${i}-${j}`}>{l}</p>)
        ),
      )}
    </>
  )
}

