// The CLI 2.1.309's spinner line (docs/research/cli-input.md §3): a random verb, then (elapsed · ↓ tokens · thinking
// status), and a "Baked for 1m 3s" line when the turn ends. The words are the CLI's own, so it reads the same.

/** The CLI's 187 spinner verbs. A `spinnerVerbs` setting ({ mode: 'replace' | 'append', verbs }) changes them. */
export const SPINNER_VERBS = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking', 'Beaming', "Beboppin'", 'Befuddling',
  'Billowing', 'Blanching', 'Bloviating', 'Boogieing', 'Boondoggling', 'Booping', 'Bootstrapping', 'Brewing',
  'Bunning', 'Burrowing', 'Calculating', 'Caramelizing', 'Cascading', 'Catapulting', 'Cerebrating', 'Channeling',
  'Choreographing', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Combobulating', 'Composing', 'Computing',
  'Concocting', 'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Crystallizing',
  'Cultivating', 'Deciphering', 'Deliberating', 'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing',
  'Doodling', 'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing', 'Enchanting', 'Envisioning',
  'Fermenting', 'Fiddle-faddling', 'Finagling', 'Flambéing', 'Flibbertigibbeting', 'Flowing', 'Flummoxing',
  'Fluttering', 'Forging', 'Forming', 'Frolicking', 'Frosting', 'Gallivanting', 'Galloping', 'Garnishing',
  'Generating', 'Gesticulating', 'Germinating', 'Gitifying', 'Grooving', 'Gusting', 'Harmonizing', 'Hashing',
  'Hatching', 'Herding', 'Honking', 'Hullaballooing', 'Hyperspacing', 'Ideating', 'Imagining', 'Improvising',
  'Incubating', 'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning', 'Kerfuffling', 'Kneading',
  'Leavening', 'Levitating', 'Lollygagging', 'Manifesting', 'Marinating', 'Meandering', 'Metamorphosing', 'Misting',
  'Moonwalking', 'Moseying', 'Mulling', 'Mustering', 'Nebulizing', 'Nesting', 'Newspapering', 'Noodling',
  'Nucleating', 'Onioning', 'Orbiting', 'Orchestrating', 'Osmosing', 'Perambulating', 'Percolating', 'Perusing',
  'Philosophizing', 'Photosynthesizing', 'Polishing', 'Pollinating', 'Pondering', 'Pontificating', 'Pouncing',
  'Precipitating', 'Prestidigitating', 'Processing', 'Proofing', 'Propagating', 'Puttering', 'Puzzling',
  'Quantumizing', 'Razzle-dazzling', 'Razzmatazzing', 'Recombobulating', 'Reticulating', 'Roosting', 'Ruminating',
  'Sautéing', 'Scampering', 'Schlepping', 'Scurrying', 'Seasoning', 'Shenaniganing', 'Shimmying', 'Simmering',
  'Skedaddling', 'Sketching', 'Slithering', 'Smooshing', 'Sock-hopping', 'Spelunking', 'Spinning', 'Sprouting',
  'Stewing', 'Sublimating', 'Swirling', 'Swooping', 'Symbioting', 'Synthesizing', 'Tempering', 'Thinking',
  'Thundering', 'Tinkering', 'Tomfoolering', 'Topsy-turvying', 'Transfiguring', 'Transmogrifying', 'Transmuting',
  'Twisting', 'Undulating', 'Unfurling', 'Unraveling', 'Vibing', 'Waddling', 'Wandering', 'Warping',
  'Whatchamacalliting', 'Whirlpooling', 'Whirring', 'Whisking', 'Wibbling', 'Working', 'Wrangling', 'Zesting',
  'Zigzagging',
]

/** The completion line's verbs ("Baked for 12s"), picked by a hash of the turn so a turn keeps its verb. */
const DONE_VERBS = ['Baked', 'Brewed', 'Churned', 'Cogitated', 'Cooked', 'Crunched', 'Sautéed', 'Worked']

export type SpinnerVerbs = { mode?: 'replace' | 'append'; verbs?: string[] }

/** The verb list after the user's `spinnerVerbs` setting. */
export function verbList(custom?: SpinnerVerbs): string[] {
  const own = (custom?.verbs ?? []).filter((v) => typeof v === 'string' && v.trim())
  if (!own.length) return SPINNER_VERBS
  return custom?.mode === 'replace' ? own : [...SPINNER_VERBS, ...own]
}

export const pickVerb = (list: string[]) => list[Math.floor(Math.random() * list.length)] ?? 'Working'

/** "12s", "1m 3s", "1h 2m": the CLI's duration format. */
export function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The thinking status, escalating as the CLI's does, with its " with high effort" suffix. */
export function thinkingStatus(secs: number, effort?: string) {
  const word = secs >= 45 ? 'deep in thought' : secs >= 30 ? 'thinking some more' : secs >= 20 ? 'thinking more' : secs >= 10 ? 'still thinking' : 'thinking'
  return effort ? `${word} with ${effort} effort` : word
}

/** The verb for a finished turn, stable for the same key (the turn's start time). */
export function doneVerb(key: number) {
  let h = 0
  for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) | 0
  return DONE_VERBS[Math.abs(h) % DONE_VERBS.length] ?? 'Worked'
}
