/** Sheet formulas, evaluated in the browser so the server never spends CPU on them.

    Cells keep the raw text (`=SUM(A1:A3)`), which is what MCP agents and exports see; the
    sheet shows the result. References name columns by letter and data rows from 1 (A1 is the
    first cell under the header), the same numbering `update_sheet_cells` uses.

    Supported: numbers, "strings", TRUE/FALSE, cell references (A1, $B$2), ranges (A1:B10),
    + - * / ^ & %, comparisons (= <> < > <= >=), parentheses, and SUM, AVERAGE (AVG), MIN, MAX,
    COUNT, COUNTA, IF, ROUND, CONCAT (CONCATENATE). Problems show as values, never as crashes:
    #ERROR! (can't read it), #DIV/0!, #REF! (outside the sheet), #NAME? (unknown function),
    #VALUE! (wrong kind of value), #CYCLE! (refers back to itself). */

export type Raw = string | number | boolean | null | undefined

export type ErrorCode = '#ERROR!' | '#DIV/0!' | '#REF!' | '#NAME?' | '#VALUE!' | '#CYCLE!'

export class FormulaError {
  readonly code: ErrorCode
  constructor(code: ErrorCode) {
    this.code = code
  }
  toString() {
    return this.code
  }
}

export type Value = number | string | boolean | FormulaError

const err = (code: ErrorCode) => new FormulaError(code)

export const isFormula = (cell: Raw): cell is string => typeof cell === 'string' && cell.startsWith('=') && cell.length > 1

// ───────────── Cell names ─────────────

export function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  return name
}

function columnIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64
  return n - 1
}

// ───────────── Tokens ─────────────

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; col: number; row: number }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }
  | { t: 'err'; v: ErrorCode }

class SyntaxProblem extends Error {}

const REF = /^\$?([A-Za-z]{1,3})\$?([0-9]+)/
const NUM = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/
const NAME = /^[A-Za-z_][A-Za-z0-9_.]*/
const OPS = ['<>', '<=', '>=', '+', '-', '*', '/', '^', '&', '%', '=', '<', '>', '(', ')', ',', ':', ';']

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i)
    const ch = rest[0]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '"') {
      let s = ''
      let j = 1
      for (;;) {
        if (j >= rest.length) throw new SyntaxProblem('unclosed string')
        if (rest[j] === '"') {
          if (rest[j + 1] === '"') {
            s += '"'
            j += 2
            continue
          }
          break
        }
        s += rest[j++]
      }
      out.push({ t: 'str', v: s })
      i += j + 1
      continue
    }
    if (rest.toUpperCase().startsWith('#REF!')) {
      out.push({ t: 'err', v: '#REF!' }) // left behind where a referenced row was deleted
      i += 5
      continue
    }
    const ref = REF.exec(rest)
    // A reference, unless the letters run on into a longer name (e.g. LOG10 is a function).
    if (ref && !/^[A-Za-z0-9_(]/.test(rest.slice(ref[0].length))) {
      out.push({ t: 'ref', col: columnIndex(ref[1]), row: Number(ref[2]) - 1 })
      i += ref[0].length
      continue
    }
    const num = NUM.exec(rest)
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) })
      i += num[0].length
      continue
    }
    const name = NAME.exec(rest)
    if (name) {
      out.push({ t: 'name', v: name[0].toUpperCase() })
      i += name[0].length
      continue
    }
    const op = OPS.find((o) => rest.startsWith(o))
    if (!op) throw new SyntaxProblem(`unexpected ${ch}`)
    out.push({ t: 'op', v: op === ';' ? ',' : op })
    i += op.length
  }
  return out
}

// ───────────── Moving rows ─────────────

const CELL_OR_RANGE = /(?<![A-Za-z0-9_$.])(\$?[A-Za-z]{1,3}\$?)([0-9]+)(?::(\$?[A-Za-z]{1,3}\$?)([0-9]+))?(?![A-Za-z0-9_(])/g

/** Rewrite a formula's references after a row was inserted (delta 1) or deleted (delta -1) at
    data row index `at` (0-based), as spreadsheets do: references below move with their rows,
    ranges stretch or shrink, and a reference to a deleted row becomes #REF!. */
export function shiftRows(formula: string, at: number, delta: 1 | -1): string {
  if (!isFormula(formula)) return formula
  const row = at + 1 // A1 numbering
  const move = (n: number, end: boolean): number | null => {
    if (delta === 1) return n >= row ? n + 1 : n
    if (n < row) return n
    if (n > row) return n - 1
    return end ? n - 1 : null // the deleted row itself: a range's end pulls back, a cell is gone
  }
  // Leave text in "quotes" alone.
  return formula
    .split(/("(?:[^"]|"")*"?)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(CELL_OR_RANGE, (_, c1: string, r1: string, c2?: string, r2?: string) => {
            if (c2 === undefined || r2 === undefined) {
              const n = move(Number(r1), false)
              return n === null ? '#REF!' : `${c1}${n}`
            }
            const a = Number(r1)
            const b = Number(r2)
            let start = move(Math.min(a, b), false)
            const end = move(Math.max(a, b), true)
            if (start === null) start = Math.min(a, b) // the first row went; the range starts at the next
            if (end === null || end < start) return '#REF!'
            return `${c1}${start}:${c2}${end}`
          }),
    )
    .join('')
}

// ───────────── Parser (precedence climbing) ─────────────

export type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'err'; v: ErrorCode }
  | { k: 'ref'; col: number; row: number }
  | { k: 'range'; from: { col: number; row: number }; to: { col: number; row: number } }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'unary'; op: string; arg: Node }
  | { k: 'binary'; op: string; left: Node; right: Node }
  | { k: 'percent'; arg: Node }

const BINARY: Record<string, number> = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 }

function parse(tokens: Token[]): Node {
  let pos = 0
  const peek = () => tokens[pos]
  const isOp = (v: string) => peek()?.t === 'op' && (peek() as { v: string }).v === v
  const expect = (v: string) => {
    if (!isOp(v)) throw new SyntaxProblem(`expected ${v}`)
    pos++
  }

  function primary(): Node {
    const tok = tokens[pos++]
    if (!tok) throw new SyntaxProblem('formula ends too soon')
    switch (tok.t) {
      case 'num':
        return { k: 'num', v: tok.v }
      case 'str':
        return { k: 'str', v: tok.v }
      case 'err':
        return { k: 'err', v: tok.v }
      case 'ref': {
        if (isOp(':')) {
          pos++
          const end = tokens[pos++]
          if (end?.t !== 'ref') throw new SyntaxProblem('a range needs two cells')
          return {
            k: 'range',
            from: { col: Math.min(tok.col, end.col), row: Math.min(tok.row, end.row) },
            to: { col: Math.max(tok.col, end.col), row: Math.max(tok.row, end.row) },
          }
        }
        return { k: 'ref', col: tok.col, row: tok.row }
      }
      case 'name': {
        if (isOp('(')) {
          pos++
          const args: Node[] = []
          if (!isOp(')')) {
            for (;;) {
              args.push(expression(0))
              if (isOp(',')) pos++
              else break
            }
          }
          expect(')')
          return { k: 'call', name: tok.v, args }
        }
        if (tok.v === 'TRUE' || tok.v === 'FALSE') return { k: 'bool', v: tok.v === 'TRUE' }
        throw new SyntaxProblem(`unknown name ${tok.v}`)
      }
      case 'op':
        if (tok.v === '(') {
          const inner = expression(0)
          expect(')')
          return inner
        }
        if (tok.v === '-' || tok.v === '+') return { k: 'unary', op: tok.v, arg: unary() }
        throw new SyntaxProblem(`unexpected ${tok.v}`)
    }
  }

  function unary(): Node {
    let node = primary()
    while (isOp('%')) {
      pos++
      node = { k: 'percent', arg: node }
    }
    return node
  }

  function expression(min: number): Node {
    let left = unary()
    for (;;) {
      const tok = peek()
      if (tok?.t !== 'op' || !(tok.v in BINARY)) return left
      const prec = BINARY[tok.v]
      if (prec < min) return left
      pos++
      // ^ binds right-to-left; everything else left-to-right.
      const right = expression(tok.v === '^' ? prec : prec + 1)
      left = { k: 'binary', op: tok.v, left, right }
    }
  }

  const tree = expression(0)
  if (pos < tokens.length) throw new SyntaxProblem('unexpected text after the formula')
  return tree
}

const parsed = new Map<string, Node | SyntaxProblem>()

/** The formula's syntax tree (cached), or null when it can't be read. */
export function parseFormula(formula: string): Node | null {
  let tree = parsed.get(formula)
  if (tree === undefined) {
    try {
      tree = parse(tokenize(formula.replace(/^=/, '')))
    } catch (e) {
      if (!(e instanceof SyntaxProblem)) throw e
      tree = e
    }
    if (parsed.size > 5000) parsed.clear()
    parsed.set(formula, tree)
  }
  return tree instanceof SyntaxProblem ? null : tree
}

// ───────────── Evaluation ─────────────

type Range = Value[] // cell values of a range, row by row; only function arguments take them

/** Text that reads as a number counts as one: the sheet stores what people type as text. */
function asNumberLike(v: Value | Raw): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return null
}

function toNumber(v: Value): number | FormulaError {
  if (v instanceof FormulaError) return v
  if (v === '') return 0
  const n = asNumberLike(v)
  return n === null ? err('#VALUE!') : n
}

function toText(v: Value): string | FormulaError {
  if (v instanceof FormulaError) return v
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return formatNumber(v)
  return v
}

function toBool(v: Value): boolean | FormulaError {
  if (v instanceof FormulaError) return v
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const up = v.trim().toUpperCase()
  if (up === 'TRUE') return true
  if (up === 'FALSE' || up === '') return false
  const n = asNumberLike(v)
  return n === null ? err('#VALUE!') : n !== 0
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '#DIV/0!'
  return String(Number(n.toPrecision(12))) // hides float noise: 0.1 + 0.2 shows 0.3
}

function compare(op: string, a: Value, b: Value): boolean {
  const na = asNumberLike(a === '' ? 0 : a)
  const nb = asNumberLike(b === '' ? 0 : b)
  let order: number
  if (na !== null && nb !== null && typeof a !== 'string' && typeof b !== 'string') order = na - nb
  else if (na !== null && nb !== null) order = na - nb
  else order = String(toText(a)).toLowerCase().localeCompare(String(toText(b)).toLowerCase())
  switch (op) {
    case '=':
      return order === 0
    case '<>':
      return order !== 0
    case '<':
      return order < 0
    case '>':
      return order > 0
    case '<=':
      return order <= 0
    default:
      return order >= 0
  }
}

function round(value: number, digits: number): number {
  const f = 10 ** Math.trunc(digits)
  const shifted = Math.abs(value) * f
  // Round half away from zero, like spreadsheets, despite binary fractions (2.675 -> 2.68).
  const r = Math.round(Number(shifted.toPrecision(15))) / f
  return value < 0 ? -r : r
}

type Lookup = (row: number, col: number) => Value

class Evaluator {
  private readonly cell: Lookup
  private readonly rows: number
  private readonly cols: number

  constructor(cell: Lookup, rows: number, cols: number) {
    this.cell = cell
    this.rows = rows
    this.cols = cols
  }

  private inside(row: number, col: number) {
    return row >= 0 && col >= 0 && row < this.rows && col < this.cols
  }

  private range(node: Extract<Node, { k: 'range' }>): Range | FormulaError {
    const out: Value[] = []
    const lastRow = Math.min(node.to.row, this.rows - 1)
    const lastCol = Math.min(node.to.col, this.cols - 1)
    if (node.from.row > lastRow || node.from.col > lastCol) return err('#REF!')
    for (let r = node.from.row; r <= lastRow; r++) for (let c = node.from.col; c <= lastCol; c++) out.push(this.cell(r, c))
    return out
  }

  /** A scalar value; ranges are only allowed as function arguments. */
  value(node: Node): Value {
    switch (node.k) {
      case 'num':
      case 'str':
      case 'bool':
        return node.v
      case 'err':
        return err(node.v)
      case 'ref':
        return this.inside(node.row, node.col) ? this.cell(node.row, node.col) : err('#REF!')
      case 'range':
        return err('#VALUE!')
      case 'percent': {
        const n = toNumber(this.value(node.arg))
        return n instanceof FormulaError ? n : n / 100
      }
      case 'unary': {
        const n = toNumber(this.value(node.arg))
        return n instanceof FormulaError ? n : node.op === '-' ? -n : n
      }
      case 'binary':
        return this.binary(node.op, this.value(node.left), this.value(node.right))
      case 'call':
        return this.call(node.name, node.args)
    }
  }

  private binary(op: string, a: Value, b: Value): Value {
    if (a instanceof FormulaError) return a
    if (b instanceof FormulaError) return b
    if (op === '&') return String(toText(a)) + String(toText(b))
    if (BINARY[op] === 1) return compare(op, a, b)
    const x = toNumber(a)
    const y = toNumber(b)
    if (x instanceof FormulaError) return x
    if (y instanceof FormulaError) return y
    let r: number
    switch (op) {
      case '+':
        r = x + y
        break
      case '-':
        r = x - y
        break
      case '*':
        r = x * y
        break
      case '/':
        if (y === 0) return err('#DIV/0!')
        r = x / y
        break
      default:
        r = x ** y
    }
    return Number.isFinite(r) ? r : err('#ERROR!')
  }

  /** Every value the arguments hold, ranges flattened. */
  private spread(args: Node[]): Value[] | FormulaError {
    const out: Value[] = []
    for (const a of args) {
      if (a.k === 'range') {
        const values = this.range(a)
        if (values instanceof FormulaError) return values
        out.push(...values)
      } else out.push(this.value(a))
    }
    return out
  }

  /** Numbers among the arguments (text that reads as a number counts; other text is skipped). */
  private numbers(args: Node[]): number[] | FormulaError {
    const values = this.spread(args)
    if (values instanceof FormulaError) return values
    const out: number[] = []
    for (const v of values) {
      if (v instanceof FormulaError) return v
      const n = asNumberLike(v)
      if (n !== null) out.push(n)
    }
    return out
  }

  private call(name: string, args: Node[]): Value {
    switch (name) {
      case 'SUM': {
        const ns = this.numbers(args)
        return ns instanceof FormulaError ? ns : ns.reduce((s, n) => s + n, 0)
      }
      case 'AVERAGE':
      case 'AVG': {
        const ns = this.numbers(args)
        if (ns instanceof FormulaError) return ns
        return ns.length ? ns.reduce((s, n) => s + n, 0) / ns.length : err('#DIV/0!')
      }
      case 'MIN':
      case 'MAX': {
        const ns = this.numbers(args)
        if (ns instanceof FormulaError) return ns
        return ns.length ? (name === 'MIN' ? Math.min(...ns) : Math.max(...ns)) : 0
      }
      case 'COUNT': {
        const values = this.spread(args)
        return values instanceof FormulaError ? values : values.filter((v) => !(v instanceof FormulaError) && asNumberLike(v) !== null).length
      }
      case 'COUNTA': {
        const values = this.spread(args)
        return values instanceof FormulaError ? values : values.filter((v) => v !== '').length
      }
      case 'IF': {
        if (args.length < 2 || args.length > 3) return err('#ERROR!')
        const test = toBool(this.value(args[0]))
        if (test instanceof FormulaError) return test
        // Only the branch taken is evaluated, so IF(B1=0, 0, A1/B1) never divides by zero.
        if (test) return this.value(args[1])
        return args.length === 3 ? this.value(args[2]) : false
      }
      case 'ROUND': {
        if (args.length < 1 || args.length > 2) return err('#ERROR!')
        const n = toNumber(this.value(args[0]))
        const d = args.length === 2 ? toNumber(this.value(args[1])) : 0
        if (n instanceof FormulaError) return n
        if (d instanceof FormulaError) return d
        return round(n, d)
      }
      case 'CONCAT':
      case 'CONCATENATE': {
        const values = this.spread(args)
        if (values instanceof FormulaError) return values
        let s = ''
        for (const v of values) {
          const t = toText(v)
          if (t instanceof FormulaError) return t
          s += t
        }
        return s
      }
      default:
        return err('#NAME?')
    }
  }
}

/** A plain cell's value: numbers stay numbers, everything else is text. */
function literal(raw: Raw): Value {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw
  return raw
}

/** Every cell's value: formulas evaluated, other cells as they are. */
export function evaluateSheet(rows: readonly (readonly Raw[])[]): Value[][] {
  const height = rows.length
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0)
  const done = new Map<number, Value>()
  const busy = new Set<number>()

  const cell: Lookup = (r, c) => {
    const key = r * width + c
    const known = done.get(key)
    if (known !== undefined) return known
    const raw = rows[r]?.[c]
    if (!isFormula(raw)) return literal(raw)
    if (busy.has(key)) return err('#CYCLE!')
    busy.add(key)
    let result: Value
    try {
      const tree = parseFormula(raw)
      result = tree ? evaluator.value(tree) : err('#ERROR!')
    } catch (e) {
      if (!(e instanceof RangeError)) throw e
      result = err('#ERROR!') // a dependency chain too deep to follow
    }
    busy.delete(key)
    // A cell whose value came from a cycle through itself shows #CYCLE! too.
    done.set(key, result)
    return result
  }
  const evaluator = new Evaluator(cell, height, width)

  // Top to bottom, so the usual "refers to the rows above" chains resolve without deep recursion.
  return rows.map((row, r) => row.map((_, c) => cell(r, c)))
}

/** One formula against a sheet (for a formula typed somewhere other than a cell). */
export function evaluate(formula: string, rows: readonly (readonly Raw[])[]): Value {
  return evaluateSheet([...rows, [formula]]).at(-1)![0]
}

/** How a value shows in a cell. */
export function display(v: Value): string {
  if (v instanceof FormulaError) return v.code
  if (typeof v === 'number') return formatNumber(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return v
}
