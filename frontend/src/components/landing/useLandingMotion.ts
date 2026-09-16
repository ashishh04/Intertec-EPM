import { useReducedMotion } from 'framer-motion';
import { EASE_SWIFT, VIEWPORT_ONCE } from './atmosphere';

type Axis = { y?: number; x?: number };

/**
 * Reveal props for the landing sections.
 *
 * framer-motion animates with JS transforms, so the global
 * `prefers-reduced-motion` rule in index.css never reaches it. Each builder
 * collapses to an empty object when motion is reduced, which leaves the
 * element rendered in its final state rather than animating a shorter version
 * of the same movement.
 */
export function useLandingMotion() {
  const reduceMotion = useReducedMotion();

  /** Plays on mount. For the hero, which is above the fold. */
  const rise = (delay = 0, duration = 0.6, from: Axis = { y: 20 }) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, ...from },
          animate: { opacity: 1, y: 0, x: 0 },
          transition: { duration, delay, ease: EASE_SWIFT },
        };

  /** Plays when the element scrolls into view, once. */
  const reveal = (delay = 0, duration = 0.8, from: Axis = { y: 40 }) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, ...from },
          whileInView: { opacity: 1, y: 0, x: 0 },
          viewport: VIEWPORT_ONCE,
          transition: { duration, delay, ease: EASE_SWIFT },
        };

  /** Draws a hairline in from its left edge as the section arrives. */
  const drawRule = (delay = 0, duration = 0.8) =>
    reduceMotion
      ? {}
      : {
          initial: { scaleX: 0 },
          whileInView: { scaleX: 1 },
          viewport: VIEWPORT_ONCE,
          transition: { duration, delay, ease: EASE_SWIFT },
        };

  /** Pointer feedback on the page's two floating buttons. */
  const press = reduceMotion ? {} : { whileHover: { scale: 1.04 }, whileTap: { scale: 0.96 } };

  return { reduceMotion, rise, reveal, drawRule, press };
}
