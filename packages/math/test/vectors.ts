import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export type FeeCase = {
  name: string
  amount: string
  fee_bps: number
  fee: string
  working: string
}

export type PromiseCase = {
  name: string
  working: string
  rate_bps: number
  seconds: number
  promised: string
}

export type SplitEvenCase = {
  name: string
  total: string
  rungs: number
  parts: string[]
}

export type SplitWeightedCase = {
  name: string
  total: string
  weights_bps: number[]
  parts: string[]
}

type Vectors = {
  version: number
  constants: { bps_denominator: number; seconds_per_year: number }
  fee: { cases: FeeCase[] }
  promise: { cases: PromiseCase[] }
  split: { even_cases: SplitEvenCase[]; weighted_cases: SplitWeightedCase[] }
}

const path = fileURLToPath(new URL('../../../fixtures/vectors.json', import.meta.url))

export const vectors = JSON.parse(readFileSync(path, 'utf8')) as Vectors
