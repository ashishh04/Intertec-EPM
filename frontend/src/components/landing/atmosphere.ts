/**
 * Shared constants for the landing page's "atmosphere" treatment.
 *
 * The page carries no footage. Its imagery is the work itself — a schedule
 * resolving, a capacity grid filling, cards crossing a board — drawn in
 * `./plates` from divs and a little SVG. That keeps the public page free of
 * third-party hosting (which a corporate network may block anyway), adds
 * nothing to the bundle worth measuring, and shows delivery rather than stock
 * imagery of something else.
 */

/** The app's standard easing curve, reused here so the page feels of a piece. */
export const EASE_SWIFT = [0.32, 0.72, 0, 1] as const;

/** Every in-view reveal on the page fires once, a little before the edge. */
export const VIEWPORT_ONCE = { once: true, margin: '-100px' } as const;
