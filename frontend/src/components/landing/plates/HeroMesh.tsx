import { useEffect, useRef } from 'react';
import { useReducedMotion } from 'framer-motion';

/**
 * The hero's centrepiece: a particle mesh rippling under the headline.
 *
 * The clip is greyscale on pure black and starts and ends on the same pose, so
 * two things fall out for free — it loops natively without a crossfade, and it
 * composites with `screen`, where black contributes nothing. That means no
 * letterbox, no visible frame edge, and the mesh simply appears to be made of
 * light over the page's own atmosphere.
 *
 * Colour comes from the brand rather than the footage: a crimson-to-violet
 * sweep blended in `color` mode takes its hue from the gradient and its
 * luminance from the mesh — a duotone, so the same file would re-tint if the
 * brand ever moved.
 */
const SOURCE = '/hero-mesh.mp4';

export function HeroMesh() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    // Reduced motion keeps the first frame: the composition still reads, it
    // just stops moving.
    if (reduceMotion) videoRef.current?.pause();
  }, [reduceMotion]);

  return (
    // `isolate` keeps the colour blend inside this layer. Without it the tint
    // would reach the canvas and the lattice underneath as well.
    <div aria-hidden className="absolute inset-0 isolate overflow-hidden">
      <video
        ref={videoRef}
        src={SOURCE}
        muted
        autoPlay
        loop
        playsInline
        preload="auto"
        // Sat low and slightly oversized, so the mesh reads as the ground the
        // headline stands on rather than as a shape behind the words.
        className="absolute inset-x-0 top-[22%] h-[104%] w-full scale-110 object-cover opacity-80 mix-blend-screen"
      />

      {/* Duotone */}
      <div className="absolute inset-0 bg-brand mix-blend-color" />

      {/* Cools the mesh at the edges so it fades into the page instead of
          ending on a hard crop. */}
      <div className="absolute inset-0 bg-[radial-gradient(75%_65%_at_50%_72%,transparent_20%,#08070d_100%)]" />

      {/* A scrim only where the type is. The mesh peaks at roughly the height
          of the standfirst, and 14px grey over lit particles is the one place
          on this page where the copy stops being comfortable to read. */}
      <div className="absolute inset-0 bg-[radial-gradient(52%_38%_at_50%_40%,rgba(8,7,13,0.85)_0%,transparent_72%)]" />
    </div>
  );
}
