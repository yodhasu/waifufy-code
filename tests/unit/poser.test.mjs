// Unit check of app/src/character/poser.ts on a small made-up skeleton: an arm reaching for a point, her body keeping
// it out, joint limits, hand shapes and mirroring.
// Run: node tests/unit/poser.test.mjs   (no app, no Claude).
import { Vector3 } from '../../app/node_modules/three/build/three.module.js'

const P = await import('../../app/src/character/poser.ts')
const { standIn } = await import('../../app/src/character/mmd-engine.ts')

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (e) {
    failures++
    console.log(`FAIL  ${name}\n      ${e.message}`)
  }
}
const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
}
const ok = (c, msg) => {
  if (!c) throw new Error(msg)
}

// MMD units, three's axes (she faces +z here: MMD's -z): an upper body, a neck and both arms in an A-pose.
const BONES = [
  ['上半身', -1, [0, 11, 0]],
  ['上半身2', 0, [0, 1.5, 0]],
  ['首', 1, [0, 3.5, 0]],
  ['頭', 2, [0, 0.8, 0]],
  ['左肩', 1, [0.3, 3.1, 0]],
  ['左腕', 4, [1.4, -0.2, 0]],
  ['左ひじ', 5, [2.4, -2.4, 0]],
  ['左手首', 6, [2.2, -2.2, 0]],
  ['右肩', 1, [-0.3, 3.1, 0]],
  ['右腕', 8, [-1.4, -0.2, 0]],
  ['右ひじ', 9, [-2.4, -2.4, 0]],
  ['右手首', 10, [-2.2, -2.2, 0]],
]
const rig = () => standIn(BONES.map(([name, parent, rest]) => ({ name, parent, rest })))
const wrist = (bone, pose) => {
  P.apply(bone, pose)
  return new Vector3().setFromMatrixPosition(bone['左手首'].matrixWorld)
}
const elbow = (bone) => new Vector3().setFromMatrixPosition(bone['左ひじ'].matrixWorld)

await test('an arm reaches a point it can reach, and only its arm joints change', () => {
  const { bone } = rig()
  const target = new Vector3(2.5, 13, 2.5)
  const arm = P.reach(bone, [], {}, '左', target)
  eq(Object.keys(arm).sort(), ['左ひじ', '左腕'], 'the arm\'s joints')
  const d = wrist(bone, arm).distanceTo(target)
  ok(d < 0.05, `the wrist is on the target: ${d.toFixed(3)} away`)
})

await test('out of reach, the arm points straight at it, the elbow barely bent', () => {
  const { bone } = rig()
  P.apply(bone, {})
  const shoulder = new Vector3().setFromMatrixPosition(bone['左腕'].matrixWorld)
  const target = shoulder.clone().add(new Vector3(0, 0, 40))
  const w = wrist(bone, P.reach(bone, [], {}, '左', target))
  const dir = w.clone().sub(shoulder).normalize()
  ok(dir.z > 0.99, `toward the target: ${dir.toArray().map((v) => v.toFixed(2))}`)
})

await test('the elbow keeps bending the way it bends, never backwards', () => {
  const { bone } = rig()
  const bendAxis = (pose) => {
    P.apply(bone, pose)
    const q = bone['左ひじ'].quaternion
    return new Vector3(q.x, q.y, q.z).normalize()
  }
  const relaxed = bendAxis({})
  for (const target of [new Vector3(3.5, 10.5, 1), new Vector3(1, 14, 3), new Vector3(4, 16, -1), new Vector3(0.5, 11, 2.5)]) {
    const axis = bendAxis(P.reach(bone, [], {}, '左', target))
    ok(axis.dot(relaxed) > 0.5, `bends the same way for ${target.toArray()}: ${axis.dot(relaxed).toFixed(2)}`)
  }
})

await test('dragging the elbow toward a point swings it there, the wrist staying put', () => {
  const { bone } = rig()
  const target = new Vector3(2.5, 12, 2.5)
  const first = P.reach(bone, [], {}, '左', target)
  const pole = new Vector3(6, 14, -2)
  const swung = P.reach(bone, [], first, '左', target, pole)
  ok(wrist(bone, swung).distanceTo(target) < 0.05, 'the wrist stays on the target')
  const e = elbow(bone)
  P.apply(bone, first)
  ok(e.distanceTo(pole) < elbow(bone).distanceTo(pole) - 0.5, 'the elbow moved toward the pole')
})

await test('her chest keeps the hand out: a point inside it is met at its surface', () => {
  const { bone } = rig()
  // A ball for her chest, in front of 上半身2 (MMD axes: in front is -z).
  const chest = { bone: '上半身2', shapeType: 0, size: [1.6, 0, 0], position: [0, 13.6, -1], rotation: [0, 0, 0] }
  const colliders = P.bodyOf(bone, [chest, { bone: '左ひじ', shapeType: 0, size: [9, 0, 0], position: [0, 0, 0], rotation: [0, 0, 0] }])
  eq(colliders.length, 1, 'only her body collides, not her own arm')
  const center = new Vector3(0, 13.6, 1)
  const w = wrist(bone, P.reach(bone, colliders, {}, '左', center.clone()))
  const d = w.distanceTo(center)
  ok(d >= 1.6 + 0.4, `the wrist is outside her chest: ${d.toFixed(2)} from its center`)
  ok(d < 1.6 + 1.2, `and close to it, where it was reaching: ${d.toFixed(2)}`)
})

await test('limits keep a joint within its range; arms are free', () => {
  eq(P.limit('頭', [100, -90, 10]), [70, -80, 10], 'head')
  eq(P.limit('左腕', [170, -170, 90]), [170, -170, 90], 'arm')
})

await test('hand shapes turn only that hand\'s fingers; mirroring copies one side to the other', () => {
  const fist = P.HANDS.fist('右')
  ok(Object.keys(fist).length >= 12 && Object.keys(fist).every((n) => n.startsWith('右') && /指/.test(n)), 'right fingers only')
  const peace = P.HANDS.peace('左')
  eq([peace['左人指２'], peace['左中指２']], [[0, 0, 0], [0, 0, 0]], 'two fingers up')
  ok(peace['左薬指２'][2] < -45, 'the others curled')
  const m = P.mirror({ 頭: [5, 10, 0], 左腕: [1, 2, 3], 右腕: [9, 9, 9], 右ひじ: [4, 4, 4] }, '左')
  eq(m, { 頭: [5, 10, 0], 左腕: [1, 2, 3], 右腕: [1, 2, 3] }, 'left onto right')
})

console.log(failures ? `\n${failures} failed` : '\nAll passed')
process.exit(failures ? 1 : 0)
