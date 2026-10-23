import './style.css'
import { createChat } from './chat'
import { connect } from './link'
import { createMenu } from './menu'
import { createRem } from './rem'
import { loadStage } from './stage'
import { $ } from './ui'

const STAGE_W = 1600
const STAGE_H = 900
/** Rem's canvas, matching `#chara` in style.css. */
const CHARA_W = 864
const CHARA_H = 900
const PETALS = 16

// The 1600×900 stage is scaled to fit the window around its center.
function fit() {
  const s = Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H)
  $('stage').style.transform = `translate(-50%, -50%) scale(${s})`
}
addEventListener('resize', fit)
fit()

for (let k = 0; k < PETALS; k++) {
  const p = document.createElement('i')
  p.className = 'petal'
  p.style.left = `${200 + Math.random() * 1500}px`
  p.style.animationDuration = `${9 + Math.random() * 9}s`
  p.style.animationDelay = `${-Math.random() * 18}s`
  $('petals').appendChild(p)
}

const link = await connect()
$('menuFoot').textContent = 'Summoning Rem…'
const stage = await loadStage($('chara'), link.base, CHARA_W, CHARA_H).catch((e) => {
  console.error('[waifufy-code] Live2D failed to load; continuing without Rem’s model', e)
  return undefined
})
const rem = createRem(stage, document.querySelector<HTMLElement>('#chara .glow')!)
rem.start()

// She turns toward the cursor.
$('stage').addEventListener('pointermove', (e) => {
  const r = $('chara').getBoundingClientRect()
  const scale = r.width / CHARA_W
  rem.lookAt((e.clientX - r.left) / scale, (e.clientY - r.top) / scale)
})

const menu = createMenu(link, rem, { onStart: (cwd, resume, title) => chat.start(cwd, resume, title) })
const chat = createChat(link, rem, { onMenu: () => menu.show() })
menu.show()
