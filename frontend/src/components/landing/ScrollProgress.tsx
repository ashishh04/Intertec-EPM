import { motion, useReducedMotion, useScroll, useSpring } from 'framer-motion';

/**
 * A hairline at the very top of the viewport showing how far through the page
 * you are.
 *
 * The landing page is long and has no chrome of its own below the nav pill, so
 * there is nothing to tell you whether the next scroll is the last section or
 * the fifth. The rail is the cheapest answer: one element, driven by
 * `scrollYProgress` on the compositor, no layout read per frame.
 *
 * It sits above the header rather than inside it — the pill floats clear of
 * the top edge, and threading a progress bar through glass would read as a
 * seam in the glass.
 */
export function ScrollProgress() {
  const reduceMotion = useReducedMotion();
  const { scrollYProgress } = useScroll();

  // The spring is only smoothing: a trackpad fling moves `scrollYProgress` in
  // steps large enough to make the raw bar stutter. For anyone who asked for
  // less motion the bar still tracks the scroll — it is an indicator, not
  // decoration — but it tracks it exactly, with nothing easing behind it.
  const smoothed = useSpring(scrollYProgress, { stiffness: 220, damping: 40, restDelta: 0.001 });

  return (
    <motion.div
      aria-hidden
      // z above the header: the nav pill is z-50 and the rail has to stay
      // visible when the glass fills in on scroll.
      className="fixed inset-x-0 top-0 z-[60] h-[2px] origin-left bg-brand"
      style={{ scaleX: reduceMotion ? scrollYProgress : smoothed }}
    />
  );
}
