export function createTranscript(el, scene) {
  el.classList.add("transcript");
  const lines = scene.sources
    .filter(s => s.transcription)
    .sort((a,b) => a.onset - b.onset)
    .map(s => {
      const div = document.createElement("div");
      // Person letter only, no source number: the transcript reads like a
      // script, and repeated lines from one speaker are obvious from the
      // letter alone (see identity.js).
      div.textContent = `${s.person ? s.person + ": " : ""}${s.transcription}`;
      div.dataset.onset = s.onset; div.dataset.offset = s.offset;
      el.appendChild(div);
      return div;
    });
  // The panel shows two or three lines at a time, so a longer conversation
  // scrolls out of sight exactly when it is being spoken. Follow the highlight.
  //
  // Only when the active line CHANGES: update() runs every animation frame, and
  // re-issuing a smooth scroll on each one would fight itself and never settle.
  // The container is scrolled directly rather than via scrollIntoView, which
  // walks up the ancestors and can shift the rest of the layout.
  let lastActive = null;

  function follow(div) {
    // Measured from rects rather than offsetTop: offsetTop is relative to the
    // nearest positioned ancestor, which is not necessarily this panel, so the
    // arithmetic silently drifts if the surrounding layout ever changes.
    const delta = div.getBoundingClientRect().top - el.getBoundingClientRect().top;
    const room = el.clientHeight - div.offsetHeight;
    const top = Math.max(0, el.scrollTop + delta - room / 2); // centre where there is room
    if (Math.abs(el.scrollTop - top) < 2) return;
    el.scrollTo({ top, behavior: "smooth" });
  }

  return { update(t) {
    let active = null;
    for (const d of lines) {
      const on = t >= +d.dataset.onset && t <= +d.dataset.offset;
      d.classList.toggle("active", on);
      if (on && !active) active = d;
    }
    if (active !== lastActive) {
      lastActive = active;
      if (active) follow(active);
    }
  }};
}
