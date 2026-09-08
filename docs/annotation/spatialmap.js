// Fallback for legacy scene payloads that lack the "position" field: derive
// a raw (x, z) in meters from azimuth/distance using the same convention
// (azimuth 0 = front, clockwise, top-down).
function rawPolarToXZ(azimuthDeg, distance) {
  const a = (azimuthDeg - 90) * Math.PI / 180;
  return [Math.cos(a) * distance, Math.sin(a) * distance];
}

// Raw (x, z) in meters for a source's static/reference position, preferring
// the receiver-relative `position` field ([x, y, z]) over azimuth/distance.
function rawXZ(s) {
  if (Array.isArray(s.position)) return [s.position[0], s.position[2]];
  return rawPolarToXZ(s.azimuth ?? 0, s.distance ?? 1);
}

function heightOf(s) {
  return Array.isArray(s.position) ? s.position[1] : null;
}

function interp(traj, t) {
  if (traj.length === 1) return [traj[0][1], traj[0][2]];
  for (let i = 1; i < traj.length; i++) {
    if (t <= traj[i][0]) {
      const [t0,x0,z0] = traj[i-1], [t1,x1,z1] = traj[i];
      const f = (t1===t0) ? 0 : (t - t0)/(t1 - t0);
      return [x0 + (x1-x0)*f, z0 + (z1-z0)*f];
    }
  }
  const last = traj[traj.length-1]; return [last[1], last[2]];
}

// Group static sources that share the same rounded (x, z) position: they are
// the same physical source (e.g. a speaker utterance and a Humming from the
// same person) even if their class differs, and should render as a single
// marker. Moving sources are never merged, since their position varies over
// time.
function groupKey(s) {
  const [x, z] = rawXZ(s);
  return `${Math.round(x * 100) / 100},${Math.round(z * 100) / 100}`;
}

function buildGroups(sources) {
  const byKey = new Map();
  const groups = [];
  for (const s of sources) {
    if (s.moving) { groups.push({ members: [s] }); continue; }
    const key = groupKey(s);
    let g = byKey.get(key);
    if (!g) { g = { members: [] }; byKey.set(key, g); groups.push(g); }
    g.members.push(s);
  }
  return groups;
}

// Extent (in meters) needed so every source/trajectory point fits on the
// map: the largest |x| or |z| across static positions and full trajectories.
function computeExtentMeters(scene) {
  let maxAbs = 1; // floor, so a scene with only near sources still shows a ring
  for (const s of scene.sources || []) {
    const [x, z] = rawXZ(s);
    maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(z));
  }
  for (const id in (scene.trajectories || {})) {
    for (const [, x, z] of scene.trajectories[id]) {
      maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(z));
    }
  }
  return maxAbs;
}

// Pick a "nice" ring spacing (in meters) that yields roughly 3-5 rings.
function niceStep(maxAbs) {
  const target = maxAbs / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(target || 1)));
  const norm = target / mag;
  let step;
  if (norm < 1.5) step = 1;
  else if (norm < 3.5) step = 2;
  else if (norm < 7.5) step = 5;
  else step = 10;
  return step * mag;
}

// Reserved margin (px) between the outermost drawn ring and each canvas
// edge, wide enough for the axis label text ("front"/"back"/"left"/"right")
// plus a small gap, so nothing is ever clipped at the panel boundary.
const LABEL_PAD = 36;
// Small inset (px) from the canvas edge for the axis labels themselves, so
// they sit just inside the boundary rather than flush against it.
const EDGE_INSET = 4;

// Longest a marker label may run before it wraps, as a fraction of the panel
// width. Class names like "Power windows, electric windows" are otherwise a
// single 185px run that crowds its neighbours and can leave the canvas.
const MAP_LABEL_MAX_FRAC = 0.3;
const MAP_LABEL_LINES = 2;
// Same rule as the scene graph: three or more words folds onto two lines even
// when one would have fit, because a long single run crowds the markers around
// it. Two-word labels stay on one line.
const MAP_WRAP_WORDS = 3;

// Greedy word wrap into at most `maxLines`; returns the lines it managed, so a
// single unbreakable word simply comes back as one over-long line (the caller
// still clamps it into the canvas). Mirrors wrapLabel() in graph.js -- kept
// local because the offline app inlines both files independently.
// Break opportunities: after a space, and after an underscore -- class names
// come in both styles ("Dishes, pots, and pans" / "dishes_pots_and_pans") and
// the underscore form is one unbreakable word to a space-only splitter.
function mapBreakPieces(text) {
  return text.split(/(?<=[_ ])/);
}

// Two lines split at the most even break point (see wrapLabel in graph.js for
// why balanced beats greedy). Falls back to the whole string on one line when
// no split fits -- the caller clamps that into the canvas.
function wrapText(ctx, text, maxW) {
  const pieces = mapBreakPieces(text);
  if (pieces.length < 2) return [text];
  let best = null;
  for (let k = 1; k < pieces.length; k++) {
    const a = pieces.slice(0, k).join("").trimEnd();
    const b = pieces.slice(k).join("").trimEnd();
    const w = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
    if (w <= maxW && (!best || w < best.w)) best = { lines: [a, b], w };
  }
  return best ? best.lines : [text];
}

// Zoom range (multiplier applied on top of the base meter->px scale).
const MIN_VIEW_SCALE = 0.5;
const MAX_VIEW_SCALE = 8;

// Formats a source's height as an ABSOLUTE height above the floor ("1.2m"),
// the same reference the listener's own readout uses, so every number on the
// map is directly comparable.
//
// `position[1]` in the label is NOT absolute -- it is the source's vertical
// offset from the listener's ears. (Verified against the label: for all 133
// sources with a Position, `Elevation == asin(position[1] / Distance)`, and
// `Ear Height + position[1]` lands in 0.00-2.85 m with nothing below the
// floor.) Adding the listener's ear height is what makes it absolute.
//
// A scene payload with no "Ear Height" is the only case that cannot be made
// absolute; it falls back to the signed relative offset, which stays
// unambiguous because absolute heights are never printed with a sign.
function fmtHeight(relH, earHeight) {
  if (earHeight === null) {
    const sign = relH >= 0 ? "+" : "-";
    return `H=${sign}${Math.abs(relH).toFixed(2)} m`;
  }
  return `H=${(earHeight + relH).toFixed(2)} m`;
}

export function createSpatialMap(canvas, scene) {
  const ctx = canvas.getContext("2d");
  let cx, cy, scale, maxR;

  // The listener's own height above the floor ("Ear Height" in the label,
  // surfaced as `ear_height` by data_loader.scene_payload). It is already
  // absolute, and it is also what fmtHeight() adds to each source's
  // receiver-relative offset to make every height on the map absolute.
  const earHeight = typeof scene.ear_height === "number" ? scene.ear_height : null;

  const groups = buildGroups(scene.sources || []);
  const extentM = computeExtentMeters(scene);
  const ringStep = niceStep(extentM);

  // Interactive view transform (zoom + pan). A fresh `view` object is
  // created every time createSpatialMap runs, so loading a new scene (which
  // calls createSpatialMap again, see app.js/graph.js) always starts back
  // at the default 1x/untranslated view.
  const view = { scale: 1, offsetX: 0, offsetY: 0 };
  let lastT = 0; // last time passed to draw(), so interaction handlers can
                 // trigger an immediate redraw without waiting for the next
                 // master-clock tick.
  let dragging = false;
  let dragStart = null; // { x, y, offsetX, offsetY } captured on mousedown

  // Frozen label placement for moving sources, keyed by source id:
  // { right, roomCss }. Decided on the first frame the source is drawn and
  // reused for the whole scene -- see the label block in draw(). Scene-scoped,
  // like `view`, because createSpatialMap runs again for each scene.
  const movingLabelChoice = new Map();

  // Size the canvas's backing store to the panel it lives in, at native
  // pixel density, so the map stays crisp on HiDPI/Retina displays. The
  // CSS size tracks the panel; only the drawing-buffer resolution changes.
  function resize() {
    const host = canvas.parentElement || canvas;
    const cssW = Math.max(1, host.clientWidth || canvas.clientWidth || 360);
    const cssH = Math.max(1, host.clientHeight || canvas.clientHeight || 360);
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    cx = cssW / 2; cy = cssH / 2;
    const base = Math.min(cssW, cssH);
    // Reserve LABEL_PAD between the outermost ring and the canvas edge so
    // the "front"/"back"/"left"/"right" axis labels always render fully
    // inside the panel, at any panel size.
    maxR = Math.max(10, base / 2 - LABEL_PAD);
    // Fit the farthest source/trajectory point inside maxR with margin, so
    // labels and glow halos around it stay on-canvas.
    scale = maxR / (extentM * 1.25);
  }

  if (canvas.__asgResize) window.removeEventListener("resize", canvas.__asgResize);
  canvas.__asgResize = resize;
  window.addEventListener("resize", resize);
  resize();

  function clampViewScale(s) {
    return Math.min(MAX_VIEW_SCALE, Math.max(MIN_VIEW_SCALE, s));
  }

  // Zoom so the point at (mx, my) in canvas CSS-pixel coordinates stays
  // visually fixed under the cursor.
  function zoomAt(mx, my, factor) {
    const newScale = clampViewScale(view.scale * factor);
    const applied = newScale / view.scale;
    view.offsetX = mx - (mx - view.offsetX) * applied;
    view.offsetY = my - (my - view.offsetY) * applied;
    view.scale = newScale;
  }

  function resetView() {
    view.scale = 1; view.offsetX = 0; view.offsetY = 0;
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    // exp() gives smooth, symmetric zoom in/out regardless of the wheel's
    // deltaY magnitude/sign convention across browsers/devices.
    const factor = Math.exp(-e.deltaY * 0.001);
    zoomAt(mx, my, factor);
    draw(lastT);
  }

  function onMouseDown(e) {
    if (e.button !== 0) return; // left-button drag only
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY, offsetX: view.offsetX, offsetY: view.offsetY };
    canvas.style.cursor = "grabbing";
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!dragging) return;
    view.offsetX = dragStart.offsetX + (e.clientX - dragStart.x);
    view.offsetY = dragStart.offsetY + (e.clientY - dragStart.y);
    draw(lastT);
  }

  function onMouseUp() {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = "grab";
  }

  function onDblClick(e) {
    e.preventDefault();
    resetView();
    draw(lastT);
  }

  // Dedupe the same way `resize` is deduped above: createSpatialMap is
  // called again on this same <canvas> element whenever a new scene loads
  // (see window.__renderPanels in app.js / graph.js), so remove any
  // listeners from a previous instance first -- otherwise they'd pile up,
  // each still closing over the previous scene's `groups`/`view`.
  if (canvas.__asgWheel) canvas.removeEventListener("wheel", canvas.__asgWheel);
  canvas.__asgWheel = onWheel;
  canvas.addEventListener("wheel", onWheel, { passive: false });

  if (canvas.__asgMouseDown) canvas.removeEventListener("mousedown", canvas.__asgMouseDown);
  canvas.__asgMouseDown = onMouseDown;
  canvas.addEventListener("mousedown", onMouseDown);

  if (canvas.__asgMouseMove) window.removeEventListener("mousemove", canvas.__asgMouseMove);
  canvas.__asgMouseMove = onMouseMove;
  window.addEventListener("mousemove", onMouseMove);

  if (canvas.__asgMouseUp) window.removeEventListener("mouseup", canvas.__asgMouseUp);
  canvas.__asgMouseUp = onMouseUp;
  window.addEventListener("mouseup", onMouseUp);

  if (canvas.__asgDblClick) canvas.removeEventListener("dblclick", canvas.__asgDblClick);
  canvas.__asgDblClick = onDblClick;
  canvas.addEventListener("dblclick", onDblClick);

  canvas.style.cursor = "grab";

  // `obstacles` collects the boxes of text this function draws that source
  // labels must not land on -- the per-ring distance readouts, which sit along
  // the upper-right diagonal exactly where markers often are. They keep being
  // drawn here (their own smaller, lighter font); the boxes are only handed to
  // the de-collision pass in draw() so marker labels give way to them.
  function drawRingsAndAxes(obstacles) {
    // Line widths / dash sizes / font sizes are divided by view.scale so
    // they stay a constant, readable on-screen size as the map zooms --
    // only the layout (positions/rings) visibly enlarges.
    const inv = 1 / view.scale;
    ctx.strokeStyle = "#ddd";
    ctx.fillStyle = "#999";
    ctx.lineWidth = inv;
    ctx.font = (10 * inv) + "px " + (getComputedStyle(document.body).fontFamily || "sans-serif");
    for (let r = ringStep; r <= extentM * 1.15; r += ringStep) {
      const px = r * scale;
      if (px > maxR) break;
      ctx.beginPath(); ctx.arc(cx, cy, px, 0, Math.PI * 2); ctx.stroke();
      // distance label along the upper-right diagonal, out of the way of
      // the axis guides and most markers.
      const lx = cx + px * Math.SQRT1_2, ly = cy - px * Math.SQRT1_2;
      const ringText = `${r % 1 === 0 ? r : r.toFixed(1)} m`;
      ctx.fillText(ringText, lx + 2, ly);
      obstacles.push({
        lines: [ringText], x: lx + 2, y: ly,
        w: ctx.measureText(ringText).width,
        fixed: true, ghost: true,
      });
    }

    // Faint axis guides through the receiver, with orientation labels so the
    // map reads correctly without drawing (unreliable) room walls.
    ctx.save();
    ctx.strokeStyle = "#eee";
    ctx.lineWidth = inv;
    ctx.setLineDash([3 * inv, 4 * inv]);
    ctx.beginPath();
    ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy);
    ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR);
    ctx.stroke();
    ctx.restore();

    // Axis labels are pinned just inside the canvas bounds (not relative to
    // maxR) so they never clip regardless of panel size or text width: each
    // one is aligned so it grows *inward*, away from the edge it sits near.
    const cssW = cx * 2, cssH = cy * 2;
    ctx.fillStyle = "#aaa";
    ctx.font = (11 * inv) + "px " + (getComputedStyle(document.body).fontFamily || "sans-serif");
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("front", cx, EDGE_INSET);
    ctx.textBaseline = "bottom";
    ctx.fillText("back", cx, cssH - EDGE_INSET);
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("left", EDGE_INSET, cy);
    ctx.textAlign = "right";
    ctx.fillText("right", cssW - EDGE_INSET, cy);
    ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";

    // Receiver marker. Radius, font, and label offset are all divided by
    // view.scale (like everything else in this function) so the dot and its
    // label stay a constant on-screen size regardless of zoom. The listener's
    // ear height is drawn on a second line, in the same place/style that each
    // source draws its own height (see draw()), so the map reads as one
    // consistent set of heights rather than "sources have a height, the
    // listener doesn't".
    ctx.fillStyle = "#333"; ctx.beginPath(); ctx.arc(cx, cy, 6 * inv, 0, Math.PI * 2); ctx.fill();
    // The listener's own text is handed to the same de-collision pass as the
    // source labels (see draw()), marked immovable: sources give way to it, so
    // the fixed centre of the map is never written over.
  }

  function draw(t) {
    lastT = t;
    const cssW = cx * 2, cssH = cy * 2;
    ctx.clearRect(0, 0, cssW, cssH);

    // Apply the current zoom/pan to everything: rings, axis guides, the
    // receiver, source markers/trajectories, and their labels. At the
    // default view ({scale:1, offsetX:0, offsetY:0}) this is a no-op, so
    // rendering is pixel-identical to before zoom/pan existed.
    ctx.save();
    ctx.translate(view.offsetX, view.offsetY);
    ctx.scale(view.scale, view.scale);

    const inv0 = 1 / view.scale;
    ctx.font = (12 * inv0) + "px " + (getComputedStyle(document.body).fontFamily || "sans-serif");
    const listenerLines = ["listener"];
    if (earHeight !== null) listenerLines.push(`H=${earHeight.toFixed(2)} m`);
    const labels = [{
      lines: listenerLines,
      x: cx + 8 * inv0,
      y: cy + 4 * inv0,
      w: Math.max(...listenerLines.map(l => ctx.measureText(l).width)),
      alpha: 1.0,
      fixed: true,
    }];

    drawRingsAndAxes(labels);

    // Source markers (position spreads with the layout, size does not): the
    // marker's screen position is x*scale/z*scale transformed by the view
    // (translate + scale) same as the rings, so it spreads/contracts with
    // zoom just like the layout. But every *size* that belongs to the
    // marker -- circle radius, glow halo radius, label font, label offset --
    // is pre-divided by view.scale so it renders at a constant on-screen
    // pixel size after the canvas applies ctx.scale(view.scale).
    const inv = 1 / view.scale;
    for (const g of groups) {
      const primary = g.members[0];
      const onAny = g.members.some(m => t >= m.onset && t <= m.offset);
      let x, z;
      if (primary.moving) {
        // A moving source holds placeholder positions outside its active
        // window, so it is only drawn while it is actually sounding.
        if (!onAny) continue;
        const traj = scene.trajectories && scene.trajectories[primary.id];
        // The 0730 render records where a moving source starts but not the
        // waypoints it travels through. With no path, draw it at that start
        // rather than dropping it off the map: a source you can hear with no
        // marker is worse than one that does not move.
        [x, z] = traj ? interp(traj, t) : rawXZ(primary);
      } else {
        [x, z] = rawXZ(primary);
      }
      const dx = x * scale, dz = z * scale;
      const px = cx + dx, py = cy + dz;

      ctx.globalAlpha = onAny ? 1.0 : 0.3;
      ctx.fillStyle = primary.cls.toLowerCase().includes("speaker") ? "#2a72d4" : "#d4722a";
      const rad = (onAny ? 11 : 7) * inv;
      ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill();
      if (onAny) {
        ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.arc(px, py, rad + 8 * inv, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1.0; ctx.fillStyle = "#000";

      // Labels are collected, not drawn, so they can be pulled apart once
      // every marker position is known (see below).
      ctx.font = (12 * inv) + "px " + (getComputedStyle(document.body).fontFamily || "sans-serif");
      // No id prefix: numbers were dropped from the map on the author's
      // instruction. A merged marker used to read "2,4:Humming, speaker",
      // where the compound number described nothing a validator could act on.
      const classes = [...new Set(g.members.map(m => m.cls))].join(", ");
      // The map already merges same-position sources into one marker; naming
      // the person here is what ties that marker to the graph's nodes.
      const person = g.members.map(m => m.person).find(Boolean);
      const nameBase = classes;
      const nameSuffix = person ? " " + person : "";
      const name = nameBase + nameSuffix;
      const h = heightOf(primary);

      // Visible canvas edges expressed in the view-transformed space the
      // labels live in, so the choice below survives zoom and pan.
      const viewL = -view.offsetX * inv;
      const viewR = (cssW - view.offsetX) * inv;
      const maxW = cssW * MAP_LABEL_MAX_FRAC * inv;
      const gap = 12 * inv;
      // Put the label on whichever side of the marker has more room, so a
      // marker near the right edge writes leftward instead of off-canvas.
      //
      // For a MOVING source that choice is made once, on the first frame it is
      // drawn, and then frozen for the rest of the scene: recomputing it from
      // the room at the marker's CURRENT position made the label hop across the
      // dot mid-travel and re-wrap its lines as the available width changed.
      // The stored width is in CSS pixels, so a frozen choice still scales with
      // zoom.
      let right, room;
      const frozen = primary.moving ? movingLabelChoice.get(primary.id) : null;
      if (frozen) {
        right = frozen.right;
        room = frozen.roomCss * inv;
      } else {
        // A moving source is judged on the room along its WHOLE path, not the
        // spot it happens to occupy on the first frame: a side frozen from a
        // mid-canvas start would run off the edge by the end of the
        // trajectory. lo/hi collapse to px for a static source, leaving its
        // placement exactly as before.
        let lo = px, hi = px;
        if (primary.moving) {
          for (const [tt, tx] of (scene.trajectories && scene.trajectories[primary.id]) || []) {
            // Entries outside [onset, offset] are placeholders, not positions.
            if (tt < primary.onset || tt > primary.offset) continue;
            const sx = cx + tx * scale;
            if (sx < lo) lo = sx;
            if (sx > hi) hi = sx;
          }
        }
        const roomR = viewR - (hi + gap);
        const roomL = lo - gap - viewL;
        right = roomR >= maxW || roomR >= roomL;
        room = Math.max(20 * inv, Math.min(maxW, right ? roomR : roomL));
        if (primary.moving) movingLabelChoice.set(primary.id, { right, roomCss: room / inv });
      }

      // Three or more pieces wraps by choice, at the most even break point. The
      // person letter is excluded from that count and glued to the last line --
      // one letter should not make a two-word name look wordy, nor claim a line
      // of its own.
      const natural = ctx.measureText(name).width;
      const pieces = mapBreakPieces(nameBase);
      const wrapped = (pieces.length >= MAP_WRAP_WORDS || natural > room)
        ? wrapText(ctx, nameBase, room)
        : [nameBase];
      const lines = wrapped.slice(0, -1).concat(wrapped[wrapped.length - 1] + nameSuffix);
      if (h !== null && h !== undefined) lines.push(fmtHeight(h, earHeight));
      const w = Math.max(...lines.map(l => ctx.measureText(l).width));
      const lx = right ? px + gap : px - gap - w;
      const ly = py + 3 * inv;
      labels.push({
        lines,
        right,
        x: lx,
        y: ly,
        // Where the label WANTED to sit, and the marker it belongs to. Both are
        // kept so the leader-line pass below can tell whether de-collision has
        // pulled the label far enough from its dot to need one.
        x0: lx,
        y0: ly,
        mx: px,
        my: py,
        mr: rad,
        w,
        alpha: onAny ? 1.0 : 0.3,
        // A moving source's marker travels every frame, so letting the
        // de-collision pass shift its label made the text jitter around the
        // dot as it went. Pinned labels keep a fixed offset from their marker:
        // they are neither moved nor treated as an obstacle, since pushing
        // other labels out of a moving one's way would just move the jitter
        // onto them. They may overlap in passing, which is the lesser problem.
        pinned: !!primary.moving,
      });
    }

    // Markers sitting close together used to write their labels straight on
    // top of each other. Nudge them apart vertically: sort by y and push any
    // label whose box still touches an earlier one below it. Only the offset
    // from the marker changes, never the marker itself, so positions stay
    // truthful -- and the id prefix keeps each label attributable even after a
    // nudge. Group counts here are single digits, so the quadratic scan is
    // free. All arithmetic is in the view-transformed space the labels are
    // drawn in, hence the `inv` factors.
    const lineH = 13 * inv;
    const boxOf = (l) => ({ x0: l.x, x1: l.x + l.w, y0: l.y - lineH * 0.8, y1: l.y + lineH * (l.lines.length - 0.2) });
    // Immovable labels first, so they act as obstacles for everything after.
    labels.sort((a, b) => (b.fixed ? 1 : 0) - (a.fixed ? 1 : 0) || a.y - b.y);
    for (let i = 0; i < labels.length; i++) {
      if (labels[i].fixed || labels[i].pinned) continue;
      for (let guard = 0; guard < 20; guard++) {
        let moved = false;
        for (let j = 0; j < i; j++) {
          if (labels[j].pinned) continue; // a moving label never pushes anyone
          const a = boxOf(labels[i]), b = boxOf(labels[j]);
          if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
            labels[i].y = b.y1 + lineH * 0.8;
            moved = true;
          }
        }
        if (!moved) break;
      }
    }

    // Final horizontal clamp: nothing may sit outside the visible canvas.
    const viewL = -view.offsetX * inv, viewR = (cssW - view.offsetX) * inv;
    for (const l of labels) {
      // Clamping a pinned label would break the fixed offset it exists to keep.
      if (l.fixed || l.pinned) continue;
      l.x = Math.min(Math.max(l.x, viewL + 2 * inv), viewR - 2 * inv - l.w);
    }

    // Leader lines. Once several markers share a corner of the map, the pass
    // above pushes their labels down a column and the id prefix becomes the
    // only thing tying a name back to its dot -- which is a lot to ask of a
    // reader mid-playback. A hairline from the marker to the label it belongs
    // to says it directly.
    //
    // Only for labels that actually moved: an undisplaced label already sits
    // 12px from its own marker with nothing in between, and drawing a stub
    // there would add clutter to exactly the case that reads fine. Leaders go
    // before the text so a line never crosses a glyph.
    const LEADER_MIN = 5 * inv; // displacement worth drawing a leader for
    ctx.save();
    ctx.lineWidth = 0.7 * inv;
    ctx.strokeStyle = "#888";
    for (const l of labels) {
      if (l.ghost || l.fixed || l.mx === undefined) continue;
      if (Math.hypot(l.x - l.x0, l.y - l.y0) < LEADER_MIN) continue;
      // Meet the label on the side facing its marker, at the middle of the
      // text block, and leave the marker at its own edge so the hairline
      // neither crosses the dot nor touches the glyphs.
      const ax = l.right ? l.x - 2 * inv : l.x + l.w + 2 * inv;
      const ay = l.y + lineH * (l.lines.length - 1) / 2 - lineH * 0.25;
      const ang = Math.atan2(ay - l.my, ax - l.mx);
      ctx.globalAlpha = l.alpha * 0.55;
      ctx.beginPath();
      ctx.moveTo(l.mx + Math.cos(ang) * (l.mr + 1.5 * inv),
                 l.my + Math.sin(ang) * (l.mr + 1.5 * inv));
      ctx.lineTo(ax, ay);
      ctx.stroke();
    }
    ctx.restore();

    for (const l of labels) {
      if (l.ghost) continue; // already drawn by drawRingsAndAxes
      ctx.globalAlpha = l.alpha;
      l.lines.forEach((line, i) => {
        ctx.fillStyle = i === 0 ? (l.fixed ? "#333" : "#000") : "#666";
        ctx.fillText(line, l.x, l.y + i * lineH);
      });
    }
    ctx.globalAlpha = 1.0;
    ctx.restore();

    // Tiny, unobtrusive interaction hint pinned to the panel corner --
    // deliberately drawn outside the view transform so it never moves/scales
    // with zoom/pan.
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "#888";
    ctx.font = "10px " + (getComputedStyle(document.body).fontFamily || "sans-serif");
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText("scroll to zoom · drag to pan · double-click to reset", EDGE_INSET, cssH - EDGE_INSET);
    ctx.restore();
  }
  return { update: draw };
}
