/**
 * The Launch page's banner art.
 *
 * Full-bleed, and sized as a FRACTION OF VIEWPORT WIDTH on purpose:
 * object-cover fits the width here, so the visible slice is a window into a
 * render height that grows with the window. A fixed pixel height therefore
 * crops more and more as the viewport widens -- which is what kept cutting
 * the eagle's head off. clamp(260px, 29vw, 520px) with objectPosition 20%
 * keeps the whole head (~12%-60% of the 1800x1028 frame) in view from phone
 * widths through ~1920px.
 *
 * Nothing is drawn ON the art: page content sits below it. A control floated
 * over the photograph landed on the bird's face and never lined up with the
 * form beneath.
 */
export function CreateHeroBanner() {
  return (
    <div aria-hidden="true" className="relative w-screen left-1/2 -translate-x-1/2 h-[clamp(260px,29vw,520px)] overflow-hidden pointer-events-none">
      <img
        src="/create-gate-hero.jpg"
        alt=""
        className="w-full h-full object-cover"
        style={{ objectPosition: "center 20%" }}
        onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
      />
      {/* Fade the bottom edge into the page ground so the banner ends without a seam. */}
      <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, hsl(var(--background) / 0) 55%, hsl(var(--background) / 0.35) 80%, hsl(var(--background)) 100%)" }} />
    </div>
  );
}
