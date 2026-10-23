import { Ticker } from 'pixi.js'
import { MotionPriority } from 'untitled-pixi-live2d-engine/cubism'
import type { Emotion } from '../../link/src/protocol.ts'
import type { Kind, Pose, Stage } from './stage'

const M = (name: string) => `AC_rem01_${name}`
const BLUSH = M('face_cheek_on')

/** Each emotion tag Rem writes, as a held (looping) pose. The `_w` motions are the model's hold variants. */
const EMOTIONS: Record<Emotion, Pose> = {
  normal: { act: M('act_normal_w'), face: M('face_normal_w') },
  smile: { act: M('act_hohoemu_w'), face: M('face_hohoemu_w') },
  happy: { act: M('act_egao_w'), face: M('face_egao_w') },
  delighted: { act: M('act_egao02_w'), face: M('face_egao02_w') },
  nod: { act: M('act_unazuku'), face: M('face_egao04_w') },
  think: { act: M('act_kangaeru_w'), face: M('face_kangaeru_w') },
  worried: { act: M('act_nayamu_w'), face: M('face_komaru_w') },
  serious: { act: M('act_shinken_w'), face: M('face_shinken_w') },
  surprised: { act: M('act_odoroku_w'), face: M('face_odoroku_w') },
  shy: { act: M('act_hohoemu_w'), face: M('face_tere_w'), extra: [BLUSH] },
  pout: { act: M('act_punpun_w'), face: M('face_punpun_w'), extra: [BLUSH] },
  sad: { act: M('act_kurushimu_w'), face: M('face_kanashimu_w') },
  angry: { act: M('act_ikaru_w'), face: M('face_ikaru_w') },
  sigh: { act: M('act_tameiki'), face: M('face_normal02_w') },
  teary: { act: M('act_uru_w'), face: M('face_uru_w') },
}

const GLOW: Partial<Record<Emotion, string>> = {
  happy: '#ffd1e3', delighted: '#ffc4dc', shy: '#ffbfd6', think: '#e0dbff', worried: '#e4e6f5',
  serious: '#d3e2ff', surprised: '#ffd6d6', sad: '#d9dcef', angry: '#ffcfcf', pout: '#ffd0dc',
}

/** A reaction holds the stage at least this long, even without a voice line. */
const MIN_REACTION_MS = 3000

export type Rem = ReturnType<typeof createRem>

/** Rem's expressions and voiced reactions. Without a stage (Live2D failed to load) every call is a no-op. */
export function createRem(stage: Stage | undefined, glow: HTMLElement) {
  let current: Emotion = 'normal'
  let reacting = false
  let finishTimer: number | undefined
  let muted = false

  function hold(e: Emotion) {
    if (!stage) return
    Ticker.shared.maxFPS = stage.config.idleFps
    void stage.pose(EMOTIONS[e], MotionPriority.FORCE, true)
  }

  return {
    /** Switches to an emotion, unless a reaction is playing; it then takes over when the reaction ends. */
    emote(e: Emotion) {
      if (e === current && !reacting) return
      current = e
      glow.style.background = GLOW[e] ?? '#ffe2ec'
      if (!reacting) hold(e)
    },

    /** Plays one of waifufy.config.json's reactions with its voice line, then returns to the current emotion. */
    react(kind: Kind) {
      const reaction = stage?.config.reactions[kind]
      if (!stage || !reaction) return
      reacting = true
      clearTimeout(finishTimer)
      stage.model.stopSpeaking()
      Ticker.shared.maxFPS = stage.config.reactionFps
      void stage.pose(reaction, MotionPriority.FORCE, false)
      let isVoiceDone = muted || !reaction.voice
      let isTimeDone = false
      const finish = () => {
        if (!isVoiceDone || !isTimeDone) return
        reacting = false
        hold(current)
      }
      finishTimer = window.setTimeout(() => ((isTimeDone = true), finish()), MIN_REACTION_MS)
      if (!isVoiceDone) {
        const voiceDone = () => ((isVoiceDone = true), finish())
        void stage.model.speak(stage.asset(reaction.voice!), {
          volume: stage.config.volume,
          resetExpression: false,
          onFinish: voiceDone,
          onError: (e: unknown) => (console.warn('[waifufy-code] voice failed', e), voiceDone()),
        })
      }
    },

    lookAt(x: number, y: number) {
      stage?.lookAt(x, y)
    },

    setMuted(on: boolean) {
      muted = on
      if (on) stage?.model.stopSpeaking()
    },

    start() {
      hold(current)
    },
  }
}
