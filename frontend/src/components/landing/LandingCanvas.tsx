/**
 * The atmosphere the whole landing page sits on.
 *
 * Fixed rather than per-section: the content scrolls through the light instead
 * of dragging it along, which is what stops the page below the hero reading as
 * one long flat black. Four layers, cheapest first — a tinted base, a slow
 * grid, three drifting brand blooms, and grain over the top to keep the
 * gradients from banding.
 */
export function LandingCanvas() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-[#08070d]">
      {/* The grid fades out towards the edges so it never meets a corner. */}
      <div className="landing-canvas-grid absolute inset-0 [mask-image:radial-gradient(80%_70%_at_50%_40%,black_0%,transparent_100%)]" />

      <div
        className="landing-bloom absolute -left-[15%] top-[-10%] h-[70vh] w-[70vw] rounded-full bg-[radial-gradient(circle,hsl(var(--brand-from)/0.16)_0%,transparent_65%)]"
        style={{ animationDuration: '28s' }}
      />
      <div
        className="landing-bloom absolute -right-[20%] top-[35%] h-[80vh] w-[75vw] rounded-full bg-[radial-gradient(circle,hsl(var(--brand-to)/0.2)_0%,transparent_65%)]"
        style={{ animationDuration: '36s', animationDelay: '-8s' }}
      />
      <div
        className="landing-bloom absolute bottom-[-15%] left-[20%] h-[60vh] w-[60vw] rounded-full bg-[radial-gradient(circle,hsl(var(--accent)/0.14)_0%,transparent_65%)]"
        style={{ animationDuration: '32s', animationDelay: '-16s' }}
      />

      <div className="landing-grain absolute inset-0 opacity-[0.035] mix-blend-overlay" />
    </div>
  );
}

/** A hairline between sections, so the page has joints rather than one seam. */
export function LandingRule() {
  return (
    <div
      aria-hidden
      className="mx-auto h-px max-w-6xl bg-gradient-to-r from-transparent via-white/12 to-transparent"
    />
  );
}
