import React from 'react'
import { Composition, registerRoot } from 'remotion'
import { DURATION, Promo } from './Promo'

const Root: React.FC = () => <Composition id="Promo" component={Promo} durationInFrames={DURATION} fps={30} width={1920} height={1080} />

registerRoot(Root)
