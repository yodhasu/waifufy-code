# MMD motion lab

A test page for driving an MMD character waist up with real motion: Reine (an official hololive MMD model) moved by
poses through springs, and by motion clips retargeted live onto her skeleton.

```bash
cd ui-draft/mmd-lab && npm install    # once
npm run dev                           # then open http://127.0.0.1:47130/
```

- **babylon-mmd** (`src/main.js`) draws her with MMD's own shading, outlines and self-shadows, and runs her IK,
  inherited (付与) rotations and Bullet physics (WebAssembly, single-threaded build).
- **The engine** (`src/engine.js`) decides her pose on a stand-in skeleton (three.js bones in three's axes, never
  drawn): springs, poses, motions, the idle layer, blinking and the face. Each frame, before her physics step, its
  rotations go into her bones' local rotations (three's (x, y, z, w) → MMD's (-x, -y, z, w)), which babylon-mmd reads
  as animation input. three.js is only there for its loaders (FBX, BVH, VRMA, VPD, VMD) and the math.
- `three-legacy.html` is the first version, all in three.js (its MMD shading and ammo physics were not good enough).

Everything third-party lives in `assets/`, which git ignores: the model (`assets/reine/`), poses (`assets/poses/`) and
motions (`assets/motions/`). Get the motion libraries with:

```bash
node ui-draft/mmd-lab/download-motions.mjs bandai                 # gestures, 3 takes each (~30 MB)
node ui-draft/mmd-lab/download-motions.mjs bandai --all           # or the whole repository (~310 MB zip)
node ui-draft/mmd-lab/download-motions.mjs cmu --from <zip>       # after downloading Anims_Only_FBX_V1.zip by hand
node ui-draft/mmd-lab/download-motions.mjs vrma --from <zip>      # the VRoid VRMA motion pack
```

The CMU pack (441 MB) only downloads through its page: https://rancidmilk.itch.io/free-character-animations, then
"No thanks, just take me to the downloads". Credits and terms for each library are in `assets/motions/CREDITS.md`.

## What works now

- **Rem's set**: one clip per body action Rem has in Live2D (greeting, happy, delighted, think, worried, serious,
  surprised, pout, sad, sigh), from VRoid VRMA, Bandai BVH and a VPD pose. Still missing: a real nod, and shy.
- **Poses (VPD)**, through springs: Reggie's five, two of them one-arm poses that layer over the rest.
- **Motions**, blended over the pose: a butler bow (VMD), Mixamo FBX retargeted live (Greeting, two Idles, a Teasing
  pose). Retargeting copies each source bone's change in direction since its bind pose, with the hips' movement taken
  out (her legs stay still), a turn so every source faces her way, and an alignment for the different rest poses
  (Mixamo's arms out, hers ~29° down). Bandai BVH rests lying down, so its reference is the clip's first frame.
- Not usable waist up: full-body acting clips (Mixamo Exhausted bends the spine ~77°, Rejected leans ~45°).

## Plan

1. **More sources.** Add a BVH path (Bandai Namco: `Hips Spine Chest Neck Head Shoulder_* UpperArm_* LowerArm_*
   Hand_*`, no fingers) and a VRMA path (VRM humanoid bone names, via the glTF extension), both through the same
   retargeting as Mixamo. CMU's FBX comes through the existing FBX path with its own bone names.
2. **Sort the libraries.** Score every clip on how much it moves below the chest and how far the spine leans, and keep
   only the waist-up ones. Tag the keepers by action (bow, wave, call, respond…) and style (happy, shy, tired…), so
   one tag like `[wave:happy]` picks a clip. Bandai's style labels give that for free.
3. **Fill the gaps.** Bandai has no fingers, so hands get a default relaxed curl (or VRoid's hands) on top.
4. **Keep hands out of her body.** Check each clip's hands against the model's own collision shapes and skin, and
   nudge the arms out where a clip made for a slimmer actor would go through her chest.
5. **Layering.** An idle clip always running, gestures blended on top, then look-at, blinking, lip sync and physics.
6. **Into Waifufy.** A third character kind beside Live2D (`app/src/character/director.ts`'s `Actor`), driven by her
   existing emotion tags plus gesture tags. Licenses decide what can ship: Bandai is non-commercial, CMU is free but
   not for resale, VRoid's pack can't be redistributed in an extractable form without pixiv's permission, and the
   Reine model stays private (Cover Corp's terms).
