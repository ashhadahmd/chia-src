/** Run: npm test (Node's own test runner; Node strips the types). */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { display, evaluate, evaluateSheet, FormulaError, isFormula, shiftRows, type Raw } from './formulas.ts'

const shown = (rows: Raw[][]) => evaluateSheet(rows).map((row) => row.map(display))
const one = (formula: string, rows: Raw[][] = []) => display(evaluate(formula, rows))

const grid: Raw[][] = [
  ['Apples', 4, '1.25', '=B1*C1'],
  ['Milk', '2', 0.9, '=B2*C2'],
  ['Bread', 1, 2.5, '=B3*C3'],
  ['', '', '', ''],
]

test('cell references and arithmetic', () => {
  assert.deepEqual(shown(grid).map((r) => r[3]), ['5', '1.8', '2.5', ''])
  assert.equal(one('=1+2*3'), '7')
  assert.equal(one('=(1+2)*3'), '9')
  assert.equal(one('=2^3^2'), '512') // right-associative
  assert.equal(one('=-2^2'), '4') // unary minus binds tighter, as in spreadsheets
  assert.equal(one('=10/4'), '2.5')
  assert.equal(one('=0.1+0.2'), '0.3')
  assert.equal(one('=50%*B1', grid), '2')
  assert.equal(one('=$B$1+b2', grid), '6')
  assert.equal(one('="a"&"b"&B1', grid), 'ab4')
})

test('SUM, AVERAGE, MIN, MAX, COUNT, COUNTA', () => {
  assert.equal(one('=SUM(B1:B3)', grid), '7')
  assert.equal(one('=SUM(B1:C3, 10)', grid), String(Number((7 + 1.25 + 0.9 + 2.5 + 10).toPrecision(12))))
  assert.equal(one('=AVERAGE(B1:B3)', grid), String(Number((7 / 3).toPrecision(12))))
  assert.equal(one('=AVG(C1:C3)', grid), '1.55')
  assert.equal(one('=MIN(C1:C3)', grid), '0.9')
  assert.equal(one('=MAX(B1:B3)', grid), '4')
  assert.equal(one('=COUNT(A1:C4)', grid), '6') // numbers and number-like text; names and blanks skipped
  assert.equal(one('=COUNTA(A1:C4)', grid), '9')
  assert.equal(one('=SUM(D1:D3)', grid), '9.3') // sums formula results
  assert.equal(one('=sum(B1:B100)', grid), '7') // ranges past the end are clipped
  assert.equal(one('=AVERAGE(A1:A3)', grid), '#DIV/0!')
})

test('IF, ROUND, CONCAT and comparisons', () => {
  assert.equal(one('=IF(B1>3, "many", "few")', grid), 'many')
  assert.equal(one('=IF(B3>3, "many", "few")', grid), 'few')
  assert.equal(one('=IF(B4=0, 0, B1/B4)', grid), '0') // the untaken branch never divides by zero
  assert.equal(one('=IF(FALSE, 1)'), 'FALSE')
  assert.equal(one('=ROUND(2.675, 2)'), '2.68')
  assert.equal(one('=ROUND(-1.5)'), '-2')
  assert.equal(one('=ROUND(1234, -2)'), '1200')
  assert.equal(one('=CONCAT(A1, " x", B1)', grid), 'Apples x4')
  assert.equal(one('=CONCATENATE(A1:A3)', grid), 'ApplesMilkBread')
  assert.equal(one('=A1="apples"', grid), 'TRUE') // text compares case-insensitively
  assert.equal(one('=B2>=2', grid), 'TRUE')
  assert.equal(one('=1<>1'), 'FALSE')
})

test('errors show as values and propagate', () => {
  assert.equal(one('=1/0'), '#DIV/0!')
  assert.equal(one('=SUM(1, 1/0)'), '#DIV/0!')
  assert.equal(one('=Z99', grid), '#REF!')
  assert.equal(one('=SUM(Z1:Z9)', grid), '#REF!')
  assert.equal(one('=1+'), '#ERROR!')
  assert.equal(one('=(1+2'), '#ERROR!')
  assert.equal(one('="open'), '#ERROR!')
  assert.equal(one('=1 2'), '#ERROR!')
  assert.equal(one('=NOPE(1)'), '#NAME?')
  assert.equal(one('=A1*2', grid), '#VALUE!')
  assert.ok(evaluate('=1/0', []) instanceof FormulaError)
})

test('circular references give #CYCLE! instead of hanging', () => {
  const cyc = shown([
    ['=B1', '=A1', '=A1+1'],
    ['=A2+1', 5, '=SUM(A1:C1)'],
  ])
  assert.deepEqual(cyc[0], ['#CYCLE!', '#CYCLE!', '#CYCLE!'])
  assert.equal(cyc[1][0], '#CYCLE!')
  assert.equal(cyc[1][1], '5')
  assert.equal(cyc[1][2], '#CYCLE!')
  assert.equal(shown([['=IF(TRUE, 1, A1)']])[0][0], '1') // a self-reference on a branch not taken is fine
})

test('long chains of references down a column', () => {
  const rows: Raw[][] = [[1]]
  for (let i = 2; i <= 3000; i++) rows.push([`=A${i - 1}+1`])
  assert.equal(shown(rows)[2999][0], '3000')
})

test('plain cells pass through; only "=" text is a formula', () => {
  assert.deepEqual(shown([['hello', 3, null, '=', '= 1 + 1']])[0], ['hello', '3', '', '=', '2'])
  assert.equal(isFormula('=A1'), true)
  assert.equal(isFormula('='), false)
  assert.equal(isFormula(5), false)
})

test('inserting and deleting rows moves references with their rows', () => {
  // Insert a row above data row 3 (index 2).
  assert.equal(shiftRows('=SUM(A1:A5)+B3-$C$2', 2, 1), '=SUM(A1:A6)+B4-$C$2')
  assert.equal(shiftRows('=A3&"A3"', 2, 1), '=A4&"A3"') // text in quotes stays
  assert.equal(shiftRows('=SUM(B6:B8)', 2, 1), '=SUM(B7:B9)')
  assert.equal(shiftRows('=LOG10(1)+A1', 0, 1), '=LOG10(1)+A2') // function names aren't references
  // Delete data row 3 (index 2).
  assert.equal(shiftRows('=SUM(A1:A5)+B4', 2, -1), '=SUM(A1:A4)+B3')
  assert.equal(shiftRows('=A3*2', 2, -1), '=#REF!*2')
  assert.equal(shiftRows('=SUM(A3:A3)', 2, -1), '=SUM(#REF!)')
  assert.equal(one('=SUM(#REF!)'), '#REF!')
  assert.equal(shiftRows('=SUM(A3:A5)', 2, -1), '=SUM(A3:A4)')
  assert.equal(shiftRows('plain A3', 2, -1), 'plain A3')
  assert.equal(one(shiftRows('=A3*2', 2, -1)), '#REF!')
})
