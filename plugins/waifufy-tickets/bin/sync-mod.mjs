#!/usr/bin/env node
// Copies src/tools.mjs TOOLS into mod.json, the one place the mod's tool list is generated.
// test/mod.test.mjs fails when the two drift; run this after editing a tool.
import { readFileSync, writeFileSync } from 'node:fs'
import { TOOLS } from '../src/tools.mjs'

const file = new URL('../mod.json', import.meta.url)
const mod = JSON.parse(readFileSync(file, 'utf8'))
mod.tools = TOOLS
writeFileSync(file, JSON.stringify(mod, null, 2) + '\n')
