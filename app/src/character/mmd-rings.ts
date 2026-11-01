// The pose studio's rotation rings on one of her joints (Babylon's RotationGizmo), loaded the first time a joint is
// picked: the rest of the 3D view never needs the gizmo, its utility layer or picking, and a phone build leaves them
// out (no studio there).

// Picking the rings: Babylon's pick needs its ray, and the rings' invisible hit shapes the default material (without
// it a pick finds no point on them, and they never take a drag).
import '@babylonjs/core/Culling/ray'
import '@babylonjs/core/Materials/standardMaterial'
import { RotationGizmo } from '@babylonjs/core/Gizmos/rotationGizmo'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { UtilityLayerRenderer } from '@babylonjs/core/Rendering/utilityLayerRenderer'
import type { Scene } from '@babylonjs/core/scene'

/** A bone the rings sit on: babylon-mmd's runtime bone, as much of it as they use. */
type Bone = { getWorldMatrixToRef(m: Matrix): Matrix; parentBone: Bone | null }

export type Rings = {
  /** True while a ring is dragged: the rings stay where the drag put them, not on the bone. */
  readonly dragging: boolean
  /** Puts the rings back on the bone (each frame, while not dragged). */
  follow(): void
  dispose(): void
}

/**
 * Rings on `bone`, about `scale` of the screen. `onTurn` hears the joint's new local turn (Babylon's axes) as a ring is
 * dragged, `onEnd` when the drag ends.
 */
export function attachRings(scene: Scene, bone: Bone, scale: number, onTurn: (local: Quaternion) => void, onEnd: () => void): Rings {
  const mq = new Matrix(), ms = new Vector3(), mp = new Vector3(), mr = new Quaternion()
  const layer = new UtilityLayerRenderer(scene)
  const node = new TransformNode('studio-rings', scene)
  const gizmo = new RotationGizmo(layer)
  gizmo.updateGizmoRotationToMatchAttachedMesh = true
  gizmo.scaleRatio = scale
  let dragging = false
  const follow = () => {
    bone.getWorldMatrixToRef(mq).decompose(ms, mr, mp)
    node.position.copyFrom(mp)
    ;(node.rotationQuaternion ??= new Quaternion()).copyFrom(mr)
  }
  follow()
  gizmo.attachedNode = node
  gizmo.onDragStartObservable.add(() => void (dragging = true))
  gizmo.onDragObservable.add(() => {
    // The node's world turn into the bone's local one: its parent's world turn taken off.
    const parent = new Quaternion()
    bone.parentBone?.getWorldMatrixToRef(mq).decompose(ms, parent, mp)
    onTurn(Quaternion.Inverse(parent).multiply(node.rotationQuaternion!))
  })
  gizmo.onDragEndObservable.add(() => {
    dragging = false
    onEnd()
  })
  return {
    get dragging() {
      return dragging
    },
    follow,
    dispose() {
      gizmo.dispose()
      layer.dispose()
      node.dispose()
    },
  }
}
