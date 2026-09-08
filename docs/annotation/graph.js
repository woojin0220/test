import { analyzeStem, cachedAudible } from "./waveform.js";


// Scene-graph validation panel: a node-link diagram (HiDPI canvas, circular
// layout) plus a causal-relation list, mounted in graph mode instead of the
// QA panel. Reuses the QA panel's `.verdict` button markup so the existing
// keyboard 1/2/3 handler in app.js (which does a plain DOM
// `.verdict button[data-v=...]` click) keeps working unchanged.
//
// The three pieces mount into three separate containers (see createGraphPanel's
// `mounts`), because graph mode spreads them across different grid columns:
// the diagram top-left, the causal list bottom-left, the verdict bottom-right.

const NODE_R = 18;
// A subject that sounds more than once is drawn as a touching cluster of
// smaller circles at ONE ring position, so only those shrink -- a source that
// sounds once is still a full-size circle.
const SPLIT_NODE_R = 11;
// Gap between two circles of the same subject. Small enough that the pair
// reads as one thing in one place, which is what the merged node used to say.
const SPLIT_GAP = 2;

function nodeR(n) {
  return n && n.split ? SPLIT_NODE_R : NODE_R;
}
const ARROW_LEN = 9;

// Every drawn edge is causal now (see causalPair() below -- "independent"
// relations are dropped entirely), so edge color no longer has to encode a
// category. One color for all arrows; direction carries the meaning.
const CAUSAL_COLOR = "#b91c1c";
// Relations the validator added or turned round. A different hue rather than a
// different line style, because line style is what used to encode the temporal
// label and reusing it would resurrect that confusion.
const EDIT_COLOR = "#0d9488";

// Every arrow is a plain solid line. Line style used to encode the temporal
// label (solid/dashed/dotted for after/overlap/before), but three line styles
// in one small diagram read as three kinds of relation when there is only one:
// a causal link. The temporal label is still available in the data and the
// list; the diagram no longer spends a visual channel on it.

// Direction convention for the label's causal relations. A relation is stored
// as (Anchor, Object, "Causal Relation") with the value "cause", "result", or
// "independent". "independent" (66.5% of all relations) carries no causal link
// and is dropped entirely -- that is what makes the diagram readable.
//
//   "object-role"  -- the value names the OBJECT's part: "result" points anchor
//                     -> object, "cause" points object -> anchor. What the
//                     review doc's marked-up screenshot asks for, and what we
//                     ship. Its red arrows run rightward on both "result" rows
//                     and leftward on the "cause" row.
//   "anchor-role"  -- the mirror image, i.e. the value names the ANCHOR's part.
//                     This is what the author described in chat, but it is not
//                     what the screenshot draws.
//   "anchor-first" -- always anchor -> object, ignoring the value.
//
// The spec, per the author: "cause" means the anchor is the cause and the
// object the result; "result" means the anchor is the result and the object
// the cause. Anchors are enumerated by onset, earliest source first, and the
// earliest source is usually the cause.
//
// BE AWARE THAT THE LABEL DOES NOT SATISFY THAT SPEC, so the arrows this draws
// are frequently backwards in time. Measured over the full 10,085-scene label
// (91,055 relations, 30,469 of them causal):
//   - the anchor is the earlier source in 95.6% of relations (spec confirmed);
//   - but among causal relations whose anchor is earlier, only 19.3% say
//     "cause" -- 23,607 say "result", i.e. they assert that the earlier sound
//     is the result of the later one;
//   - so reading the value as the anchor's role puts 80.2% of causal arrows
//     backwards in time, which is impossible.
// Scoring all four candidate readings by the arrow of time:
//     anchor is always the reason .................. 96.0% forward, 3.5% backwards
//     "Anchor is the <value> of Object" (the spec) . 19.4% forward, 80.2% backwards
//     "Object is the <value> of Anchor" ............ 80.2% forward, 19.4% backwards
//     object is always the reason ..................  3.5% forward, 96.0% backwards
//
// The worked examples agree with the measurement, not the spec. Scene 4 has
// `anchor 1:speaker "Excuse me, could you help me find the history section?"
// @0.50s -> object 2:speaker "Of course, it's just past the reading desk..."
// @4.50s, causal=result` -- the question plainly causes the answer, yet the
// spec would make the question the result of the answer.
//
// Drawing it the spec's way is deliberate even so: a "result" arrow running
// from a later sound back to an earlier one is exactly the defect a validator
// should flag, and hiding it would hide the bug. Switch to "anchor-first" if
// the backwards arrows start getting in the way of judging the rest of a
// graph, or make it the default once a regenerated label satisfies the spec.
const CAUSAL_DIRECTION = "object-role";

// Returns [reasonId, resultId] for a causal edge, or null when the relation
// carries no causal information ("independent", missing, or unrecognized).
function causalPair(e) {
  if (e.causal !== "cause" && e.causal !== "result") return null;
  if (CAUSAL_DIRECTION === "anchor-first") return [e.source, e.target];
  if (CAUSAL_DIRECTION === "anchor-role") {
    return e.causal === "cause" ? [e.source, e.target] : [e.target, e.source];
  }
  // "object-role": the value names the OBJECT's part in the relation.
  return e.causal === "cause" ? [e.target, e.source] : [e.source, e.target];
}

// "cause" and "result" name the OBJECT's part in the relation (see
// CAUSAL_DIRECTION), so turning an arrow round swaps which of the two applies.
function flipCausal(word) {
  if (word === "result") return "cause";
  if (word === "cause") return "result";
  return word;
}

function edgeKey(reason, result) {
  return `${reason}→${result}`; // canonical: always reason→result
}

// Normalizes a scene graph's raw edges into the causal-only, always-oriented
// reason->result form used by BOTH the diagram and the list, so the two can
// never disagree about what is drawn. Relations in the label are stored
// upper-triangular (each unordered pair appears at most once), but the `seen`
// guard keeps a single arrow per ordered pair even if that ever changes.
// Normalizes a scene graph's raw edges into the causal-only, always-oriented
// reason->result form used by BOTH the diagram and the list, mapped onto
// GROUPS rather than individual sources (see identity.js): a relation between
// two utterances of the same person collapses to a self-relation, and two
// relations that connect the same pair of things collapse to one row.
//
// 895 of the 30,469 causal relations (2.9%) are self-relations once grouped.
// They are kept, not dropped -- "this person's own earlier sound caused their
// later one" is a claim worth validating -- and drawn as a loop on the node.
function causalEdges(graph, gidOf, labelOf) {
  const out = [];
  const seen = new Set();
  for (const e of (graph && graph.edges) || []) {
    const pair = causalPair(e);
    if (!pair) continue;
    const [reason, result] = pair;
    const a = gidOf.get(reason), b = gidOf.get(result);
    if (a === undefined || b === undefined) continue;
    const anchorGid = gidOf.get(e.source), objectGid = gidOf.get(e.target);
    const key = edgeKey(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      reason: a, result: b, key,
      selfLoop: a === b,
      anchor: anchorGid, object: objectGid,
      anchorLabel: labelOf.get(anchorGid), objectLabel: labelOf.get(objectGid),
      // The raw label word. It does NOT orient the arrow (see causalPair
      // above) -- it is carried through so the list can show validators the
      // annotation they are actually judging.
      causal: e.causal,
      // Carried through unused by the diagram (every arrow is solid now):
      // temporal is simulator-derived, so it is context for reading the causal
      // claim rather than a claim to check. Kept on the edge so a future panel
      // can surface it without re-deriving the mapping.
      temporal: e.temporal,
    });
  }
  out.sort((a, b) => a.anchor - b.anchor || a.object - b.object);
  return out;
}

// The validator's corrections, laid over the label's own causal edges.
//
// Stored as deltas rather than a rewritten edge list, because the point of the
// exercise is to find out where the label is wrong: "this arrow points the
// wrong way" is the finding, and a flat corrected graph would throw it away.
// An edit therefore says what CHANGED, and the original stays readable
// underneath it.
function applyEdits(base, edits, labelOf) {
  const out = base.map((e) => Object.assign({}, e));
  const byKey = new Map(out.map((e) => [e.key, e]));
  for (const [key, op] of edits) {
    const parts = key.split("\u2192").map(Number);
    const a = parts[0], b = parts[1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (op === "removed") {
      // Kept in the list, marked, rather than deleted outright: the table
      // shows it struck through with a way back, so a mis-click is one click
      // to undo instead of a reload. The diagram skips these.
      const gone = byKey.get(key);
      if (gone) gone.edited = "removed";
      continue;
    }
    if (op === "flipped") {
      const orig = byKey.get(edgeKey(b, a));
      if (orig) {
        byKey.delete(orig.key);
        orig.reason = a; orig.result = b; orig.key = key; orig.edited = "flipped";
        byKey.set(key, orig);
        continue;
      }
      // The label no longer holds the edge this flip referred to -- the data
      // was revised under an answer recorded earlier. Keep the validator's
      // intent by treating it as an addition rather than dropping it.
    }
    if (!byKey.has(key)) {
      const e = {
        reason: a, result: b, key, selfLoop: a === b,
        anchor: a, object: b,
        anchorLabel: labelOf.get(a), objectLabel: labelOf.get(b),
        causal: null, temporal: null, edited: "added",
      };
      out.push(e);
      byKey.set(key, e);
    }
  }
  return out;
}

// Turns the stored, label-shaped edits back into the internal reason->result
// deltas the panel works in.
//
// The record is a list of label rows -- same shape, same field names, same
// vocabulary -- saying only what each relation SHOULD be. Whether that amounts
// to adding, flipping or removing depends on what the label currently says
// about that pair, so it is re-derived here instead of being stored. That is
// deliberate: an edit recorded against one revision of the label still reads
// correctly against the next one.
function resolveEdits(stored, parsed, base) {
  const out = new Map(parsed.edits); // superseded spelling, if any
  const byKey = new Map(base.map((e) => [e.key, e]));
  for (const group of stored || []) {
    for (const row of (group && group.Relations) || []) {
    // Names are "<id>_<class>", and the id is what identifies the source: a
    // class rename between label revisions must not orphan an answer.
    const spec = {
      anchor: parseInt(group.Anchor, 10),
      object: parseInt(row.Object, 10),
      value: row["Causal Relation"],
    };
    if (!Number.isFinite(spec.anchor) || !Number.isFinite(spec.object)) continue;
    const fwd = edgeKey(spec.anchor, spec.object);
    const rev = edgeKey(spec.object, spec.anchor);
    if (spec.value === "independent") {
      // Either orientation may be the one the label drew, since `result` and
      // `cause` point opposite ways. If neither is there the label already
      // agrees the pair is independent, so there is nothing to mark.
      out.delete(fwd);
      out.delete(rev);
      const key = byKey.has(fwd) ? fwd : byKey.has(rev) ? rev : null;
      if (key) out.set(key, "removed");
      continue;
    }
    const key = spec.value === "cause" ? rev : fwd;
    // One edit per pair, so a record that names the same pair twice -- which
    // an earlier build could write -- resolves to its last word rather than to
    // both at once.
    out.delete(fwd);
    out.delete(rev);
    if (byKey.has(key)) continue; // already what the label says
    out.set(key, byKey.has(key === fwd ? rev : fwd) ? "flipped" : "added");
    }
  }
  return out;
}

function fontStr(px) {
  return `${px}px ` + (getComputedStyle(document.body).fontFamily || "sans-serif");
}

// Places SUBJECTS evenly around a circle -- not events. A person who sounds
// twice holds one place in the room, so their two circles sit as a touching
// pair at a single vertex; giving each event its own vertex spread them across
// the polygon and read as two unrelated people.
//
// Real spatial positions are not used for layout: sources frequently share (or
// nearly share) a position, which would collapse a positional layout into
// overlapping nodes.
function layoutNodes(nodes, cx, cy, rx, ry) {
  const pos = new Map();
  const subjects = [];
  const byGid = new Map();
  for (const node of nodes) {
    // `members` is how event nodes carry their source; a raw graph node
    // carries gid directly. Fall back to the id so a node can never be
    // dropped from the layout for lack of a group.
    const m = node.members && node.members[0];
    const g = (m && m.gid) ?? node.gid ?? node.id;
    let sub = byGid.get(g);
    if (!sub) { sub = []; byGid.set(g, sub); subjects.push(sub); }
    sub.push(node);
  }
  const n = subjects.length;
  subjects.forEach((members, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n);
    const x = cx + Math.cos(angle) * rx;
    const y = cy + Math.sin(angle) * ry;
    if (members.length === 1) { pos.set(members[0].id, { x, y }); return; }
    // Spread along the ring's tangent, not outward from it, so the cluster
    // keeps the same distance from the centre as every other subject and does
    // not eat into the gutter the labels need. The tangent of the ellipse at
    // this angle is d/dtheta (rx cos, ry sin).
    let tx = -rx * Math.sin(angle), ty = ry * Math.cos(angle);
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    const step = SPLIT_NODE_R * 2 + SPLIT_GAP;
    const span = step * (members.length - 1);
    members.forEach((m, j) => {
      const d = j * step - span / 2;
      pos.set(m.id, { x: x + tx * d, y: y + ty * d });
    });
  });
  return pos;
}

// A relation between two events of the SAME physical source (2.9% of causal
// relations once grouped -- see causalEdges) has no second node to point at.
// Draw it as a small loop sitting just outside the marker, on the side facing
// away from the diagram centre so it never lands under the node's own label.
function drawSelfLoop(ctx, x, y, awayX, awayY, color, lineWidth) {
  const r = NODE_R * 0.62;
  const cx = x + awayX * (NODE_R + r * 0.75);
  const cy = y + awayY * (NODE_R + r * 0.75);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth || 1.6;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  // Arrowhead on the loop, tangential, so the direction still reads.
  const a = Math.atan2(awayY, awayX) + Math.PI / 2;
  const hx = cx + Math.cos(a) * r, hy = cy + Math.sin(a) * r;
  const ta = a + Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - ARROW_LEN * Math.cos(ta - Math.PI / 7), hy - ARROW_LEN * Math.sin(ta - Math.PI / 7));
  ctx.lineTo(hx - ARROW_LEN * Math.cos(ta + Math.PI / 7), hy - ARROW_LEN * Math.sin(ta + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

function drawArrow(ctx, x1, y1, x2, y2, color, lineWidth) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth || 1.6;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - ARROW_LEN * Math.cos(angle - Math.PI / 7), y2 - ARROW_LEN * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x2 - ARROW_LEN * Math.cos(angle + Math.PI / 7), y2 - ARROW_LEN * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

// Whether `node` is time-active at `t` (mirrors the spatial map's `onAny`
// check): active while the master mix's currentTime falls within the
// node's [onset, offset]. `t === null` (no clock yet) means nothing is
// active, matching the spatial map's pre-playback dimmed state.
function isNodeActive(node, t) {
  return typeof t === "number" && node && t >= node.onset && t <= node.offset;
}

const LABEL_PX = 11;        // node label font size
const LABEL_LINE = 13;      // min vertical gap between two labels
const LABEL_GAP = 9;        // gap between a node marker and its label
const EDGE_PAD = 8;         // min gap between anything drawn and the canvas edge

// Labels are placed OUTWARD, radially away from the diagram centre. Inward
// labels (the previous approach) let the circle grow bigger, but every label
// then pointed at the same crowded middle and they piled up on each other as
// soon as a scene had more than about four sources. Outward, the space a label
// gets grows with the circle instead of shrinking, and what remains is handled
// by layoutLabels() below.
//
// The layout is an ELLIPSE, not a circle, because only the horizontal budget
// has to pay for label text. A circle is sized by whichever axis is tighter, so
// reserving room for labels on the x-axis was dragging the whole diagram down
// to its floor: in the ~296x390 panel graph mode gives it, a circle came out at
// 53px radius while the vertical budget alone allowed 144px. At six sources
// that left neighbouring nodes 53px apart with 36px node diameters -- the
// cramped look this fixes. Spreading over the height instead recovers it.
//
// The reserved width is a wrapped label, not a full-width one: layoutLabels
// folds long names onto two lines, so budgeting for one long line would give
// away horizontal room that is never needed.
const ASPECT_MAX = 2.2; // cap so the ellipse never degenerates into a line
const MIN_R = 34;

function computeLayout(cssW, cssH, labelAllowance) {
  const maxNodeR = NODE_R + 4;
  const glowR = maxNodeR + 8;
  let rx = cssW / 2 - (glowR + LABEL_GAP + labelAllowance + EDGE_PAD);
  let ry = cssH / 2 - (glowR + LABEL_LINE + EDGE_PAD);
  rx = Math.max(MIN_R, rx);
  ry = Math.max(MIN_R, ry);
  // Keep the two axes within a factor of each other, so the node ring still
  // reads as a ring and edges keep sensible angles.
  ry = Math.min(ry, rx * ASPECT_MAX);
  rx = Math.min(rx, ry * ASPECT_MAX);
  return { rx, ry };
}

// Last-resort trim, used only when a label fits in neither direction. Keeps the
// leading id, which is also drawn inside the node marker and is what ties a
// label back to its node.
function fitLabel(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 1, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

// Splits a label into at most `maxLines` lines, breaking on spaces, and
// returns null if it still will not fit. Used before falling back to an
// ellipsis: a class like "Power windows, electric windows" is ~185px on one
// line, which fits nowhere in a 296px panel, but wraps comfortably in two.
// Greedy packing rather than balanced -- the id must stay at the start of line
// one, and a slightly ragged right edge reads fine at this size.
// Break opportunities: after a space, and after an underscore. Class names in
// the label come in both styles -- "Dishes, pots, and pans" and
// "dishes_pots_and_pans" name the same thing -- and the underscore form is one
// unbreakable word to a space-only splitter, so those labels could not wrap at
// all and ran the full width of the panel. The separator stays attached to the
// piece before it, so joining the pieces reproduces the original text.
function breakPieces(text) {
  return text.split(/(?<=[_ ])/);
}

// Splits into two lines at the point that leaves them most even, rather than
// filling the first line greedily. Greedy gave lopsided results whenever a
// break landed just past the limit -- "3:dishes_ / pots_and_pans" instead of
// "3:dishes_pots_ / and_pans" -- and the ragged version reads worse and is
// wider than it needs to be. There are only a handful of break points, so
// trying them all costs nothing. Returns null when no split fits `maxW`.
function wrapLabel(ctx, text, maxW) {
  const pieces = breakPieces(text);
  if (pieces.length < 2) return null;
  let best = null;
  for (let k = 1; k < pieces.length; k++) {
    const a = pieces.slice(0, k).join("").trimEnd();
    const b = pieces.slice(k).join("").trimEnd();
    const w = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
    if (w <= maxW && (!best || w < best.w)) best = { lines: [a, b], w };
  }
  return best ? best.lines : null;
}

function labelWidth(ctx, lines) {
  return Math.max(...lines.map((l) => ctx.measureText(l).width));
}

// A label of three or more words is folded onto two lines even when one line
// would have fit. A long single run crowds its neighbours and drags the eye
// along the diagram; two shorter lines sit in a tidier block beside the node.
// Two-word labels ("1:speaker A", "3:Violin, fiddle", "2:Coin (dropping)")
// stay on one line, where a break would only add noise.
const WRAP_WORDS = 3;

// Best rendering of a label for a given amount of room: the preferred two-line
// form when it is wordy enough, a single line when it fits, a forced wrap when
// it does not. Returns null when nothing fits, so the caller can try the other
// side.
//
// `person` is kept out of the word count and glued to the last line. It is a
// single letter, so treating it as a word both made two-word class names look
// wordy and, worse, pushed labels like "3:Coin (dropping) A" to a third line
// and so out of wrapping entirely -- which is why some three-word labels used
// to wrap and others did not.
function linesFor(ctx, base, person, room) {
  const suffix = person ? " " + person : "";
  const join = (lines) => lines.slice(0, -1).concat(lines[lines.length - 1] + suffix);
  const full = base + suffix;
  const w = ctx.measureText(full).width;

  // Three or more pieces wraps by choice; wrapLabel already returns the most
  // even split that fits, so there is no target width to tune.
  const wrapped = wrapLabel(ctx, base, room);
  if (breakPieces(base).length >= WRAP_WORDS && wrapped
      && labelWidth(ctx, join(wrapped)) <= room) {
    return join(wrapped);
  }
  if (w <= room) return [full];
  return wrapped && labelWidth(ctx, join(wrapped)) <= room ? join(wrapped) : null;
}

function labelBox(it) {
  const x0 = it.right ? it.x : it.x - it.w;
  const h = (it.lines.length * LABEL_LINE) / 2;
  return { x0, x1: x0 + it.w, y0: it.y - h, y1: it.y + h };
}

function boxesOverlap(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// Places each label beside its node, choosing a side per node rather than
// always growing outward, then resolves whatever still overlaps.
//
// Outward is preferred: it keeps text off the busy middle of the diagram. But
// outward-only means a long class name near the canvas edge has nowhere to go,
// so each node falls back through
//   1. outward, one line
//   2. inward, one line       (text crosses the interior, but stays readable)
//   3. outward, wrapped to two lines
//   4. inward, wrapped to two lines
//   5. whichever side has more room, trimmed with an ellipsis
// Wrapping is what keeps the longest real class names intact: "Power windows,
// electric windows" is ~185px on one line, which fits nowhere in a ~300px
// panel, but halves comfortably. Step 5 then only fires for a single
// unbreakable word wider than the panel allows.
//
// Because a node can now grow either way, labels from opposite halves can end
// up in the same region, so overlap is resolved globally rather than per side:
// sort by y and push each label below any earlier one it still touches. n is
// the number of sources in a scene (single digits), so the quadratic scan is
// free. If the stack runs past the bottom edge, the whole set shifts up by the
// excess, preserving the spacing already established.
//
// A label can end up slightly off its node's radial line, which is why the id
// stays in the text: the number inside the marker always identifies it.
function layoutLabels(ctx, nodes, pos, cx, cy, cssW, cssH) {
  const items = [];
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const reach = nodeR(n) + LABEL_GAP;
    const full = n.label;

    const outRight = p.x >= cx;                       // which way is "outward"
    const xOut = outRight ? p.x + reach : p.x - reach;
    const xIn = outRight ? p.x - reach : p.x + reach;
    const roomOut = outRight ? cssW - EDGE_PAD - xOut : xOut - EDGE_PAD;
    const roomIn = outRight ? xIn - EDGE_PAD : cssW - EDGE_PAD - xIn;

    let right, x, lines;
    const baseText = n.label;
    const outLines = linesFor(ctx, baseText, null, roomOut);
    const inLines = outLines ? null : linesFor(ctx, baseText, null, roomIn);
    if (outLines) {
      right = outRight; x = xOut; lines = outLines;
    } else if (inLines) {
      right = !outRight; x = xIn; lines = inLines;
    } else {
      const useOut = roomOut >= roomIn;
      right = useOut ? outRight : !outRight;
      x = useOut ? xOut : xIn;
      lines = [fitLabel(ctx, full, Math.max(20, useOut ? roomOut : roomIn))];
    }

    const angle = Math.atan2(p.y - cy, p.x - cx);
    items.push({ lines, full, w: labelWidth(ctx, lines), right, x, y: p.y + Math.sin(angle) * reach });
  }

  const halfH = (it) => (it.lines.length * LABEL_LINE) / 2;
  const top = (it) => EDGE_PAD + halfH(it);
  const bottom = (it) => cssH - EDGE_PAD - halfH(it);

  items.sort((a, b) => a.y - b.y);
  for (let i = 0; i < items.length; i++) {
    items[i].y = Math.max(items[i].y, top(items[i]));
    // Guard the loop rather than trusting convergence: each pass strictly
    // increases y, so it terminates, but the bound keeps a pathological scene
    // from stalling a frame.
    for (let guard = 0; guard < 20; guard++) {
      let moved = false;
      for (let j = 0; j < i; j++) {
        if (boxesOverlap(labelBox(items[i]), labelBox(items[j]))) {
          // Clear the other label's box, not a fixed step, so a two-line
          // neighbour is stepped over in one move.
          items[i].y = labelBox(items[j]).y1 + halfH(items[i]);
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  // If the stack overran the bottom, slide everything up together so the
  // spacing just established survives.
  const last = items[items.length - 1];
  const overflow = last ? last.y - bottom(last) : 0;
  if (overflow > 0) for (const it of items) it.y = Math.max(top(it), it.y - overflow);

  // Final horizontal clamp, so nothing can hang off the canvas.
  for (const it of items) {
    if (it.right) it.x = Math.min(Math.max(it.x, EDGE_PAD), cssW - EDGE_PAD - it.w);
    else it.x = Math.max(Math.min(it.x, cssW - EDGE_PAD), EDGE_PAD + it.w);
  }
  return items;
}

// Draws the node-link diagram at native pixel density (HiDPI-crisp, same
// approach as the spatial map's resize()): CSS size tracks the panel, only
// the drawing-buffer resolution changes with devicePixelRatio. `t` (mix
// currentTime, or null before the clock starts) drives active-node
// highlighting -- see isNodeActive(). `playingId`, if set, marks the node
// whose individual sample is currently playing (see createGraphPanel's
// click handling) with a distinct ring, independent of the onset/offset
// glow. Records each node's drawn screen position/radius onto
// `canvas.__nodeHits` for click hit-testing.
//
// `edges` is the pre-normalized causal-only list from causalEdges(); every
// arrow is drawn reason -> result. Nodes are ALL drawn, including ones with no
// causal relation -- they are still sources you can click to hear, and hiding
// them would misrepresent the scene's inventory.
function drawDiagram(canvas, groups, edges, t, playingId, drag) {
  const ctx = canvas.getContext("2d");
  const host = canvas.parentElement || canvas;
  const cssW = Math.max(1, host.clientWidth || canvas.clientWidth || 360);
  const cssH = Math.max(1, host.clientHeight || canvas.clientHeight || 220);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const nodes = groups;
  const cx = cssW / 2, cy = cssH / 2;
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  if (nodes.length === 0) {
    canvas.__nodeHits = [];
    ctx.fillStyle = "#94a3b8";
    ctx.font = fontStr(12);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("No sources in this scene", cx, cy);
    ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
    return;
  }

  // Labels are measured BEFORE the layout is sized, because the radius has to
  // reserve room for them (see computeLayout). The per-label width cap keeps
  // one long class name from collapsing the circle.
  ctx.font = fontStr(LABEL_PX);
  // Reserve room for a typical label, not the longest one: layoutLabels can
  // place an outlier inward instead, so sizing the whole circle around the
  // worst case would shrink the diagram for every scene to serve a few.
  const widths = nodes.map((n) => ctx.measureText(n.label).width).sort((a, b) => a - b);
  const typicalW = widths[Math.floor(widths.length * 0.6)] || 0;
  // Budget for the label folded onto two lines, since that is what
  // layoutLabels will do with a long one anyway.
  const allowance = Math.min(cssW * 0.22, typicalW * 0.6);
  const { rx, ry } = computeLayout(cssW, cssH, allowance);
  const pos = layoutNodes(nodes, cx, cy, rx, ry);
  const labels = layoutLabels(ctx, nodes, pos, cx, cy, cssW, cssH);

  // Edges under nodes, directed reason -> result, all solid. Per-edge text
  // labels used to be drawn at each edge's midpoint, but they piled up
  // illegibly wherever edges crossed. An edge touching a time-active node is
  // drawn at full opacity/weight; other edges are dimmed, so an active node's
  // relations read clearly against the rest.
  for (const e of edges) {
    if (e.edited === "removed") continue;
    const p1 = pos.get(e.reason), p2 = pos.get(e.result);
    if (!p1 || !p2) continue; // defensive: malformed/dangling edge reference
    const edgeActive = isNodeActive(nodesById.get(e.reason), t) || isNodeActive(nodesById.get(e.result), t);
    if (e.selfLoop) {
      const ang = Math.atan2(p1.y - cy, p1.x - cx);
      ctx.globalAlpha = edgeActive ? 1.0 : 0.4;
      drawSelfLoop(ctx, p1.x, p1.y, Math.cos(ang), Math.sin(ang),
                   CAUSAL_COLOR, edgeActive ? 2.4 : 1.6);
      ctx.globalAlpha = 1.0;
      continue;
    }
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    // Each end stops at its own circle: a cluster's circles are smaller, so a
    // shared NODE_R would leave the arrowhead floating short of them.
    const r1 = nodeR(nodesById.get(e.reason)), r2 = nodeR(nodesById.get(e.result));
    const x1 = p1.x + ux * r1, y1 = p1.y + uy * r1;
    const x2 = p2.x - ux * r2, y2 = p2.y - uy * r2;
    ctx.globalAlpha = edgeActive ? 1.0 : 0.4;
    // A corrected relation is drawn in the edit colour, so the diagram shows at
    // a glance which arrows are the label's and which are the validator's.
    drawArrow(ctx, x1, y1, x2, y2, e.edited ? EDIT_COLOR : CAUSAL_COLOR,
              edgeActive ? 2.4 : 1.6);
    ctx.globalAlpha = 1.0;
  }

  // The relation being dragged, under the nodes so it never covers one. Dashed
  // and grey to read as provisional -- every committed arrow is a solid red
  // line, so an in-flight edit cannot be mistaken for one already recorded.
  if (drag && drag.fromId != null) {
    const from = pos.get(drag.fromId);
    if (from) {
      const to = drag.overId != null ? pos.get(drag.overId) : null;
      const tx = to ? to.x : drag.x, ty = to ? to.y : drag.y;
      ctx.save();
      ctx.strokeStyle = to ? CAUSAL_COLOR : "#94a3b8";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.setLineDash(to ? [] : [5, 4]);
      ctx.globalAlpha = 0.85;
      const ang = Math.atan2(ty - from.y, tx - from.x);
      const r0 = nodeR(nodesById.get(drag.fromId)) + 2;
      const x0 = from.x + Math.cos(ang) * r0, y0 = from.y + Math.sin(ang) * r0;
      const shrink = to ? nodeR(nodesById.get(drag.overId)) + 2 : 0;
      const x1 = tx - Math.cos(ang) * shrink, y1 = ty - Math.sin(ang) * shrink;
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - ARROW_LEN * Math.cos(ang - Math.PI / 7), y1 - ARROW_LEN * Math.sin(ang - Math.PI / 7));
      ctx.lineTo(x1 - ARROW_LEN * Math.cos(ang + Math.PI / 7), y1 - ARROW_LEN * Math.sin(ang + Math.PI / 7));
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  // Nodes on top: filled circle with the numeric id, plus an "id:cls" label
  // placed just outside the circle, oriented INWARD -- toward the diagram
  // center -- rather than outward, so the layout radius (computeLayout()
  // above) can grow to nearly fill the panel without needing extra room for
  // outward-growing labels. A time-active node (see isNodeActive()) renders
  // brighter, larger, and with a soft glow halo, like the spatial map's
  // "onAny" highlight; inactive nodes dim so the active one reads clearly at
  // a glance. Also records each node's screen position/radius into `hits` for
  // click hit-testing, and draws a distinct ring around `playingId` (the node
  // whose individual sample is currently playing) -- independent of, and
  // stacked on top of, the onset/offset active-glow above.
  const hits = [];
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const active = isNodeActive(n, t);
    const base = nodeR(n);
    const r = active ? base + 4 : base;
    hits.push({ id: n.id, x: p.x, y: p.y, r: r + 4 });
    ctx.globalAlpha = active ? 1.0 : 0.45;

    if (active) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(79,70,229,0.25)";
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = active ? "#c7d2fe" : "#eef2ff";
    ctx.fill();
    ctx.lineWidth = active ? 2.2 : 1.5;
    ctx.strokeStyle = "#4f46e5";
    ctx.stroke();

    if (playingId != null && n.id === playingId) {
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = 1.0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#16a34a";
      ctx.stroke();
      ctx.globalAlpha = prevAlpha;
    }

    ctx.globalAlpha = 1.0;
  }

  // Labels last, at their de-collided positions (see layoutLabels). Drawn in
  // one pass after every marker so a label can never be painted over by a node
  // that happens to come later in the list.
  ctx.font = fontStr(LABEL_PX);
  ctx.fillStyle = "#334155";
  ctx.textBaseline = "middle";
  for (const it of labels) {
    ctx.textAlign = it.right ? "left" : "right";
    const first = it.y - ((it.lines.length - 1) * LABEL_LINE) / 2;
    it.lines.forEach((line, i) => ctx.fillText(line, it.x, first + i * LABEL_LINE));
  }
  ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";

  canvas.__nodeHits = hits;
}

// Parses a persisted note string of the form
// "flagged: [1→2, 3→4] | free text" (either half optional) back into a set
// of flagged edge keys ("reason→result") and the free-text remainder, so a
// resumed scene restores checkbox + textarea state.
function parseNote(raw) {
  // `edits` is only ever filled from a note written before relation edits got
  // their own field on the response. Current notes carry flags and prose.
  const out = { flaggedKeys: new Set(), edits: new Map(), text: "" };
  if (!raw) return out;
  // Leading "key: [...]" segments in any order, then whatever is left is the
  // validator's own prose. Notes written before relation editing existed carry
  // only `flagged:` and still parse, which matters because answers recorded in
  // the current round have to survive this change.
  let rest = String(raw);
  const seg = /^\s*(flagged|edits|independent): \[(.*?)\]\s*(?:\|\s*)?/;
  let m;
  while ((m = rest.match(seg))) {
    const items = m[2].split(",").map((x) => x.trim()).filter(Boolean);
    if (m[1] === "flagged") {
      items.forEach((k) => out.flaggedKeys.add(k));
    } else if (m[1] === "independent") {
      // Superseded spelling: removals in their own segment, keyed the internal
      // reason->result way. Read, never written.
      items.forEach((k) => out.edits.set(k, "removed"));
    } else {
      for (const it of items) {
        // Superseded spelling: sigil + internal key. Read, never written.
        const op = it[0], key = it.slice(1);
        if (op === "+") out.edits.set(key, "added");
        else if (op === "~") out.edits.set(key, "flipped");
        else if (op === "-") out.edits.set(key, "removed");
      }
    }
    rest = rest.slice(m[0].length);
  }
  out.text = rest.trim();
  return out;
}

// The two judgements a graph scene records, and the wording the validators
// see. Kept verbatim from the review doc so the instruction on screen is the
// one that was agreed.
const DIM_SCENE = {
  title: "Scene Plausibility",
  help: "Check if the entire scene is close to the real world. Is the order and location of each sound event reasonable? If there are any logical errors, please mark as \u201cunreasonable\u201d.",
};
const DIM_SOURCE = {
  title: "Audio Source Plausibility",
  help: "Check if each sound source matches its label. If not, click the corresponding button. If all sound sources are reasonable, click \u201call reasonable\u201d.",
};

// Audio Source Plausibility is stored in the same shape as every other
// response -- a verdict plus a note -- so no schema change was needed:
// "reasonable" means the validator pressed "all reasonable", "unreasonable"
// means they named at least one source, and the names ride along in the note.
// JSON, not a comma-joined list: class names contain commas of their own
// ("Violin, fiddle", "Dishes, pots, and pans"), so splitting on "," tore them
// apart on the way back in.
function formatSourceNote(bad) {
  return bad.length ? `sources: ${JSON.stringify(bad)}` : null;
}

function parseSourceNote(raw) {
  const m = (raw || "").match(/^sources: (\[.*\])$/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[1]);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch (e) {
    return [];
  }
}

// `mounts` names the three containers the panel renders into:
//   diagramEl  - the canvas             (top-left column in graph mode)
//   causalEl   - causal relation list   (bottom-left column)
//   verdictEl  - verdict buttons + note (bottom-right column)
// causalEl/verdictEl default to diagramEl, so a caller that hasn't split its
// DOM still gets everything rendered into one container.
export function createGraphPanel(scene, vid, mounts) {
  const api = window.__app.api;
  const diagramEl = mounts.diagramEl;
  const causalEl = mounts.causalEl || diagramEl;
  const verdictEl = mounts.verdictEl || diagramEl;

  const graph = scene.graph || { nodes: [], edges: [] };
  // One node per sound EVENT (see eventNodes in identity.js): a person who
  // speaks twice gets two circles, so an arrow lands on the utterance the
  // relation actually names. annotateScene() has already stamped the person
  // letters and left the nodes on the scene.
  const groups = scene.events || scene.groups || [];
  const nodesById = new Map(groups.map((g) => [g.id, g]));
  const gidOf = new Map();
  for (const g of groups) for (const id of g.ids) gidOf.set(id, g.id);
  const labelOf = new Map(groups.map((g) => [g.id, g.label]));
  // Causal-only, reason->result oriented, collapsed onto groups. Computed once
  // and shared by the diagram and the list so they can never disagree.
  const baseEdges = causalEdges(graph, gidOf, labelOf);
  // The label's own row for each pair, reachable from either direction --
  // taken from the raw edges, so it covers the pairs marked `independent` too.
  // Those never reach the diagram, but an edit that turns one causal has to be
  // written back against the row that already exists, and this is what finds
  // it: its Anchor/Object order, and the three fields the validator does not
  // touch, which are carried through so the record is a drop-in replacement
  // for the label row rather than a fragment to be merged field by field.
  const labelRow = new Map();
  for (const e of (graph && graph.edges) || []) {
    if (!Number.isFinite(e.source) || !Number.isFinite(e.target)) continue;
    if (!labelRow.has(`${e.source}|${e.target}`)) labelRow.set(`${e.source}|${e.target}`, e);
    if (!labelRow.has(`${e.target}|${e.source}`)) labelRow.set(`${e.target}|${e.source}`, e);
  }
  // "<id>_<class>", which is verbatim how the label names a source in Anchor
  // and Object (checked against the label for every source in the pack).
  const srcName = new Map((scene.sources || []).map((x) => [x.id, `${x.id}_${x.cls}`]));
  const nameOf = (id) => srcName.get(id) || String(id);
  // Filled in by rebuildEdges() once the stored edits have been parsed, a few
  // lines below. Declared here so everything downstream reads one binding.
  let edges = baseEdges;

  function rebuildEdges() {
    edges = applyEdits(baseEdges, edits, labelOf);
  }

  // Records one drag as an edit. Dragging a -> b means "a causes b".
  //
  //   nothing between them        -> add a -> b
  //   the label already says b->a -> flip it
  //   a -> b already drawn        -> nothing to do
  //
  // A flip that lands back on the label's own direction clears the edit rather
  // than storing a no-op, so dragging a mistake back leaves no trace.
  function applyDrag(a, b) {
    if (a === b) return false;
    const fwd = edgeKey(a, b), rev = edgeKey(b, a);
    const inBase = new Map(baseEdges.map((e) => [e.key, e]));

    if (edits.get(fwd) && edits.get(fwd) !== "removed") return false;  // already this way
    const drawn = new Set(edges.filter((e) => e.edited !== "removed").map((e) => e.key));
    if (drawn.has(fwd)) return false;

    // A pair carries at most ONE edit, so whatever it held is dropped first.
    // Without this, deleting a relation and then drawing it the other way left
    // the removal in place beside the new direction, and the pair went into the
    // record twice -- one row saying `independent` and one saying the opposite
    // -- for a single row of the label.
    edits.delete(fwd);
    edits.delete(rev);
    if (inBase.has(fwd)) {
      // Back to what the label already says: no edit to record.
    } else if (inBase.has(rev)) {
      edits.set(fwd, "flipped");
    } else {
      edits.set(fwd, "added");
    }
    rebuildEdges();
    return true;
  }

  function undoEdit(key) {
    if (!edits.delete(key)) return false;
    rebuildEdges();
    return true;
  }

  // Removing a relation the validator believes should not be there at all.
  // Undoing an addition is the same gesture as deleting it, so those collapse
  // into one control; deleting a relation the validator had reversed records
  // the removal against the LABEL's own key, since that is the edge that
  // actually exists underneath.
  function deleteRelation(key) {
    const op = edits.get(key);
    if (op === "added") {
      edits.delete(key);
    } else if (op === "flipped") {
      const parts = key.split("\u2192").map(Number);
      edits.delete(key);
      edits.set(edgeKey(parts[1], parts[0]), "removed");
    } else if (op === "removed") {
      return false;
    } else {
      edits.set(key, "removed");
    }
    rebuildEdges();
    return true;
  }

  const existing = (scene.existing && scene.existing["0"]) || {};
  const parsed = parseNote(existing.note);
  let verdict = existing.verdict || null;
  const flagged = parsed.flaggedKeys;
  // key -> "added" | "flipped" | "removed", relative to the label. `edges` is
  // rebuilt from this every time it changes so the diagram and the list can
  // never drift. Written back out in the label's own terms by currentNote().
  const edits = resolveEdits(existing.relations, parsed, baseEdges);
  rebuildEdges();

  // Flags used to be stored with the RAW label direction (anchor→object).
  // Now the canonical key is reason→result, which differs for every relation
  // labeled "result". Accept either orientation when restoring an older note,
  // and normalize to the canonical key on the next write.
  function isFlagged(key, reason, result) {
    return flagged.has(key) || flagged.has(edgeKey(result, reason));
  }

  function setFlagged(key, reason, result, on) {
    flagged.delete(edgeKey(result, reason)); // drop any legacy reversed key
    if (on) flagged.add(key);
    else flagged.delete(key);
  }

  diagramEl.innerHTML = `
    <div class="graph-diagram-wrap">
      <canvas id="graphCanvas"></canvas>
    </div>`;

  causalEl.innerHTML = `<div id="graphRelations" class="graph-relations"></div>`;

  // Every thing a validator can judge as a source: one button per merged node,
  // plus the ambient beds, which are real audio but never graph nodes.
  const sourceNames = groups.map((g) => g.label)
    .concat((scene.diffuse_noise || []).filter(Boolean));

  // The two dimensions are PAGES, not a stack: one on screen at a time, moved
  // between with the arrows. Stacked, the second instruction block pushed the
  // source buttons past the bottom of what is the shortest column in the
  // layout, so reaching "all reasonable" meant scrolling a ~200px box.
  verdictEl.innerHTML = `
    <div class="dims">
      <div class="dims-bar">
        <button type="button" class="dim-nav" id="dimPrev" aria-label="previous dimension">&#9664;</button>
        <span class="dim-step" id="dimStep"></span>
        <button type="button" class="dim-nav" id="dimNext" aria-label="next dimension">&#9654;</button>
      </div>
      <div class="dims-view">
        <div class="dims-track" id="dimsTrack">
          <div class="dim">
            <h4 class="dim-title">${DIM_SCENE.title}</h4>
            <p class="dim-help">${DIM_SCENE.help}</p>
            <div class="verdict" id="sceneVerdict">
              ${["reasonable", "unreasonable"].map((v) => `<button data-v="${v}">${v}</button>`).join("")}
            </div>
            <textarea id="note" placeholder="note (optional)"></textarea>
          </div>
          <div class="dim dim--source" id="sourceDim">
            <h4 class="dim-title">${DIM_SOURCE.title}</h4>
            <p class="dim-help">${DIM_SOURCE.help}</p>
            <div class="src-buttons" id="srcButtons">
              ${sourceNames.map((n) => `<button type="button" class="src-btn" data-src="${n}">${n}</button>`).join("")}
              <button type="button" class="src-btn src-btn--all" data-all="1">all reasonable</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const canvas = diagramEl.querySelector("#graphCanvas");
  const relBox = causalEl.querySelector("#graphRelations");
  const noteEl = verdictEl.querySelector("#note");
  const verdictBox = verdictEl.querySelector("#sceneVerdict");
  const srcBox = verdictEl.querySelector("#srcButtons");

  // Second dimension, restored from its own slot (q_idx 1).
  const existingSrc = (scene.existing && scene.existing["1"]) || {};
  let srcVerdict = existingSrc.verdict || null;
  const badSources = new Set(parseSourceNote(existingSrc.note));

  noteEl.value = parsed.text;

  const track = verdictEl.querySelector("#dimsTrack");
  const dimPages = [...track.querySelectorAll(".dim")];
  const stepEl = verdictEl.querySelector("#dimStep");
  const prevBtn = verdictEl.querySelector("#dimPrev");
  const nextBtn = verdictEl.querySelector("#dimNext");
  let page = 0;

  // Audio Source Plausibility stays locked until the scene has been judged:
  // the scene judgement is the one that frames the other. Page 1 is never
  // locked, so that answer can always be revisited and changed.
  function showPage(i) {
    page = Math.max(0, Math.min(dimPages.length - 1, i));
    track.style.transform = `translateX(-${page * 100}%)`;
    stepEl.textContent = `${page + 1} / ${dimPages.length}`;
    prevBtn.disabled = page === 0;
    nextBtn.disabled = page >= dimPages.length - 1 || !verdict;
    // An off-screen page must not be reachable by Tab: focus would move to a
    // control the validator cannot see, and typing would land in a note that
    // is not on screen.
    dimPages.forEach((p, n) => { p.inert = n !== page; });
  }

  function renderVerdict() {
    verdictBox.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("sel", b.dataset.v === verdict);
    });
    showPage(page); // the next-arrow unlocks with `verdict`
  }

  function renderSources() {
    srcBox.querySelectorAll(".src-btn").forEach((b) => {
      if (b.dataset.all) b.classList.toggle("sel", srcVerdict === "reasonable");
      else b.classList.toggle("sel", badSources.has(b.dataset.src));
    });
  }

  // One row per causal relation. THE ANCHOR IS ALWAYS PRINTED FIRST, matching
  // the label's own structure (relations are stored grouped under an anchor),
  // and the arrow glyph carries the causal direction instead of the operand
  // order:
  //
  //     1:speaker  ->  2:speaker   [cause]     anchor 1 causes object 2
  //     1:speaker  <-  2:speaker   [result]    anchor 1 results from object 2
  //
  // Ordering by reason instead would put the anchor on the right for every
  // "result" row, which makes the label word unverifiable -- there is no way to
  // tell from "2:speaker -> 1:speaker [result]" which end "result" describes.
  // Color stays tied to role, not position: red is always the cause, blue
  // always the effect, so the two signals never collide.
  //
  // Relations labeled "independent" never appear here at all (causalEdges()
  // drops them), so a scene whose every relation is independent shows the
  // empty state rather than a wall of rows with nothing to judge.
  function renderRelations() {
    const showFlags = verdict === "unreasonable";
    relBox.classList.toggle("show-flags", showFlags);

    if (edges.length === 0) {
      relBox.innerHTML = `<p class="rel-empty">No causal relations in this scene.</p>`;
      return;
    }

    const byAnchor = [...edges].sort((a, b) => a.anchor - b.anchor || a.object - b.object);
    let lastAnchor = null;
    const rows = [];
    for (const e of byAnchor) {
      if (e.anchor !== lastAnchor) {
        rows.push(`<div class="rel-group-header">anchor ${e.anchorLabel || e.anchor}</div>`);
        lastAnchor = e.anchor;
      }
      // The anchor is the cause exactly when the label says "cause".
      const anchorIsCause = e.reason === e.anchor;
      const anchorCls = anchorIsCause ? "rel-reason" : "rel-result";
      const objectCls = anchorIsCause ? "rel-result" : "rel-reason";
      const arrow = anchorIsCause ? "&rarr;" : "&larr;";
      // An edited row swaps the "is this wrong?" checkbox for an undo: the
      // validator drew this one, so the way to disown it is to take it back,
      // not to tick it as suspect.
      // Reversing a relation does not annotate the old word, it changes which
      // word applies. The value names the OBJECT's part, so an object that was
      // the result becomes the cause. Printing "result - reversed" would leave
      // the reader translating on every row; printing "cause" states what the
      // corrected relation now says. That it was edited is carried by the row's
      // tint and its undo button, and the label's original word stays in the
      // tooltip.
      const tag = e.edited === "added" ? "added"
                : e.edited === "flipped" ? flipCausal(e.causal)
                : e.edited === "removed" ? `${e.causal} &middot; removed`
                : e.causal;
      const tagTitle = e.edited === "flipped"
        ? `you reversed this; the label said &quot;${e.causal}&quot;`
        : e.edited === "added"
        ? "you added this relation; the label has none between these two"
        : "raw &quot;Causal Relation&quot; value from the label, describing the ANCHOR's role";
      // One control per meaning. A removed relation offers only its way back;
      // a reversed one can be un-reversed or dropped entirely, which are
      // different intentions and so different buttons; an addition's undo and
      // its delete are the same act, so it gets one.
      const lead = "";
      const cls = e.edited === "removed" ? " rel-row--removed"
                : e.edited ? " rel-row--edited" : "";
      rows.push(`
        <div class="rel-row${cls}">
          ${lead}
          <span class="rel-text">
            <span class="rel-nodes"><span class="${anchorCls}">${e.anchorLabel || e.anchor}</span> ${arrow} <span class="${objectCls}">${e.objectLabel || e.object}</span></span>
            <span class="rel-label" title="${tagTitle}">${tag}</span>
          </span>
        </div>`);
    }
    relBox.innerHTML = rows.join("");
  }

  function currentNote() {
    const parts = [];
    if (flagged.size) parts.push(`flagged: [${[...flagged].join(", ")}]`);
    const text = (noteEl.value || "").trim();
    if (text) parts.push(text);
    return parts.length ? parts.join(" | ") : null;
  }

  // The validator's corrections, written in the label's own schema: same field
  // names, same vocabulary, same Anchor-grouped nesting, same ordering. Each
  // entry is a complete replacement for the label row it names -- the three
  // fields nobody edited are copied across -- so merging is "find the row with
  // this Anchor and Object, swap it", with nothing to translate. In particular
  // a deleted relation reads `independent`, which is how the label already
  // spells "no relation", and a reversed one reads the opposite word rather
  // than any kind of flip marker.
  //
  // Only edited rows appear. An untouched scene records nothing.
  function currentRelations() {
    if (!edits.size) return null;
    const byAnchor = new Map();
    for (const [key, op] of edits) {
      const gid = key.split("\u2192").map(Number);
      const row = labelRow.get(`${gid[0]}|${gid[1]}`);
      // A pair the label has no row for at all (0.17% of pairs) can only be an
      // addition, and there is nothing to copy: the drawn direction is the
      // whole claim, and `result` puts the object at the arrow's head.
      const anchor = row ? row.source : gid[0];
      const object = row ? row.target : gid[1];
      // `cause`/`result` name the OBJECT's part (CAUSAL_DIRECTION), so the word
      // follows from which end of the drawn arrow the object sits at.
      const causal = op === "removed" ? "independent"
                   : object === gid[1] ? "result" : "cause";
      // Field order is the label's, and object-before-causal is load-bearing
      // only in the sense that a diff against the original should show one
      // changed value and nothing else.
      const out = { Object: nameOf(object) };
      if (row) out["Temporal Relation"] = row.temporal;
      out["Causal Relation"] = causal;
      if (row) {
        out["Spatial Relation"] = row.spatial;
        out["Spatial Distance"] = row.spatial_distance;
      }
      if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
      byAnchor.get(anchor).push(out);
    }
    return [...byAnchor.keys()].sort((a, b) => a - b).map((anchor) => ({
      Anchor: nameOf(anchor),
      Relations: byAnchor.get(anchor)
        .sort((a, b) => parseInt(a.Object, 10) - parseInt(b.Object, 10)),
    }));
  }

  async function save(v) {
    // Advance to the source dimension the FIRST time the scene is judged, not
    // on every later edit: sliding the panel out from under someone who is
    // changing their mind would fight them.
    const first = !verdict;
    verdict = v;
    const note = currentNote();
    const relations = currentRelations();
    const res = await api("/api/response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ validator_id: vid, scene_id: scene.scene_id, q_idx: 0,
                             verdict, note, relations }),
    });
    renderVerdict();
    renderRelations();
    if (first) showPage(1);
    if (res.completed) document.getElementById("nextScene").hidden = false;
  }

  // Naming a source implies the source dimension is not "all reasonable", and
  // pressing "all reasonable" clears whatever was named -- the two states are
  // mutually exclusive, so the UI never shows a contradictory pair.
  async function saveSources() {
    const bad = [...badSources];
    srcVerdict = bad.length ? "unreasonable" : "reasonable";
    const res = await api("/api/response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ validator_id: vid, scene_id: scene.scene_id, q_idx: 1,
                             verdict: srcVerdict, note: formatSourceNote(bad) }),
    });
    renderSources();
    if (res.completed) document.getElementById("nextScene").hidden = false;
  }

  verdictBox.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => save(b.dataset.v)));
  srcBox.querySelectorAll(".src-btn").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.all) badSources.clear();
    else if (badSources.has(b.dataset.src)) badSources.delete(b.dataset.src);
    else badSources.add(b.dataset.src);
    saveSources();
  }));
  noteEl.addEventListener("blur", () => {
    if (verdict) save(verdict);
  });
  prevBtn.addEventListener("click", () => showPage(page - 1));
  nextBtn.addEventListener("click", () => showPage(page + 1));

  renderVerdict();
  renderSources();
  renderRelations();
  // Both dimensions must be in before the scene counts as done.
  if (verdict && srcVerdict) document.getElementById("nextScene").hidden = false;

  // `lastT` is the most recent mix currentTime the diagram was drawn at
  // (null until the first update() call from the shared rAF sync loop in
  // app.js). resize()/the ResizeObserver redraw at this same time so a
  // panel resize never resets/loses the active-node highlighting.
  let lastT = null;

  // Click-to-play a node's individual separated sample: independent of the
  // master `#mix` audio (never touched here). Only one node sample plays
  // at a time -- clicking a different node stops/replaces the current one,
  // clicking the same node again stops it. `playingNodeId` drives the
  // green ring drawn in drawDiagram() so the redraw() below keeps the
  // indicator in sync with playback state.
  //
  // Background (diffuse) noise is NOT handled here anymore: graph mode now
  // shows the full stems panel, and the diffuse stem is one of its players.
  let playingNodeId = null;
  let playingAudio = null;

  function stopNodeAudio() {
    if (playingAudio) playingAudio.pause();
    playingAudio = null;
    playingNodeId = null;
    if (window.__app && window.__app.setClock) window.__app.setClock(null);
  }

  // A merged node owns every stem of its members. Prefer the member that is
  // sounding at the current playhead, so clicking a two-utterance speaker
  // while their second line plays gives you that line, not the first.
  function findStemForNode(gid, t) {
    const g = nodesById.get(gid);
    const ids = g ? g.ids : [gid];
    const stemFor = (id) => (scene.stems || []).find((s) => parseInt(String(s.name).split("_")[0], 10) === id);
    const members = (g ? g.members : []).filter((m) => stemFor(m.id));
    const active = typeof t === "number" && members.find((m) => t >= m.onset && t <= m.offset);
    return stemFor(active ? active.id : (members[0] ? members[0].id : ids[0]));
  }

  // Whether `node` has a usable [onset, offset] window to confine playback
  // to. Guards against onset/offset being null/undefined/non-numeric or a
  // degenerate offset<=onset -- in any of those cases playNode() falls back
  // to playing the whole clip (no seek, no early stop on timeupdate).
  function hasPlayWindow(node) {
    return !!node
      && typeof node.onset === "number" && !Number.isNaN(node.onset)
      && typeof node.offset === "number" && !Number.isNaN(node.offset)
      && node.offset > node.onset;
  }

  // Where to actually start and stop a node's sample.
  //
  // A separated stem spans the whole scene and is silent outside its source's
  // active part, so playing from 0 is mostly silence. The label's
  // [onset, offset] is a good first approximation, but it is annotation, not
  // measurement -- it routinely sits a beat before the sound really starts, so
  // seeking there still leaves audible dead air. The measured audible range
  // (see analyzeStem/cachedAudible in waveform.js) is exact, so it wins when
  // available.
  //
  // It is only consulted synchronously, never awaited: this runs inside a click
  // handler, and awaiting a decode first would both delay playback and risk
  // losing the user-gesture context that lets play() start. The stems panel
  // analyses every stem as soon as the scene loads and shares the same cache,
  // so by the time a node is clicked the measurement is normally already there.
  // If it isn't, fall back to the label window and kick off the analysis so the
  // next click is exact.
  function playRange(stem, node) {
    const measured = cachedAudible(stem.url);
    if (measured) return measured;
    analyzeStem(stem.url, () => fetch(stem.url).then((r) => r.arrayBuffer())).catch(() => {});
    return hasPlayWindow(node)
      ? { audibleStart: node.onset, audibleEnd: node.offset }
      : { audibleStart: 0, audibleEnd: Infinity };
  }

  function playNode(nodeId) {
    if (playingNodeId === nodeId) {
      // Same node clicked again: toggle off.
      stopNodeAudio();
      redraw(lastT);
      return;
    }
    const stem = findStemForNode(nodeId, lastT);
    if (!stem) return; // no separated sample for this source -- do nothing
    stopNodeAudio();
    const g = nodesById.get(nodeId);
    const memberId = parseInt(String(stem.name).split("_")[0], 10);
    const node = (g && g.members.find((m) => m.id === memberId)) || g;
    const { audibleStart, audibleEnd } = playRange(stem, node);
    const audio = new Audio(stem.url);

    if (audibleStart > 0) audio.currentTime = audibleStart;
    if (audibleEnd !== Infinity) {
      audio.addEventListener("timeupdate", () => {
        if (playingAudio === audio && audio.currentTime >= audibleEnd) {
          stopNodeAudio();
          redraw(lastT);
        }
      });
    }
    audio.addEventListener("ended", () => {
      if (playingAudio === audio) {
        playingAudio = null;
        playingNodeId = null;
        redraw(lastT);
      }
    });
    audio.play();
    playingAudio = audio;
    playingNodeId = nodeId;
    // This source is what you hear now, so the map should animate to it rather
    // than to wherever the master transport was left. The stem spans the whole
    // scene, so its currentTime is scene time.
    if (window.__app && window.__app.setClock) window.__app.setClock(() => audio.currentTime);
    redraw(lastT);
  }

  function nodeHitAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const hits = canvas.__nodeHits || [];
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (Math.hypot(x - h.x, y - h.y) <= h.r) return h;
    }
    return null;
  }

  // --- click to listen, drag to correct -----------------------------------
  //
  // The canvas already meant "click a node to hear it", and that has to keep
  // working, so a press only becomes a relation edit once the pointer has
  // travelled far enough that it cannot be a click. Below the threshold the
  // press falls through to playback exactly as before.
  const DRAG_MIN_PX = 6;
  let dragState = null;
  let dragMoved = false;

  function canvasXY(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function endDrag(commit, ev) {
    const st = dragState;
    dragState = null;
    if (!st) return;
    if (commit && dragMoved && ev) {
      const over = nodeHitAt(ev.clientX, ev.clientY);
      if (over && over.id !== st.fromId && applyDrag(st.fromId, over.id)) {
        renderRelations();
        if (verdict) save(verdict);
      }
    }
    canvas.style.cursor = "default";
    redraw(lastT);
  }

  canvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    const hit = nodeHitAt(ev.clientX, ev.clientY);
    if (!hit) return;
    const p = canvasXY(ev);
    dragState = { fromId: hit.id, x0: ev.clientX, y0: ev.clientY, x: p.x, y: p.y, overId: null };
    dragMoved = false;
    ev.preventDefault();
  });

  function onMove(ev) {
    if (dragState) {
      if (!dragMoved && Math.hypot(ev.clientX - dragState.x0, ev.clientY - dragState.y0) >= DRAG_MIN_PX) {
        dragMoved = true;
      }
      const p = canvasXY(ev);
      dragState.x = p.x; dragState.y = p.y;
      const over = nodeHitAt(ev.clientX, ev.clientY);
      dragState.overId = over && over.id !== dragState.fromId ? over.id : null;
      canvas.style.cursor = dragState.overId != null ? "alias" : "crosshair";
      redraw(lastT);
      return;
    }
    const hit = nodeHitAt(ev.clientX, ev.clientY);
    canvas.style.cursor = hit ? "pointer" : "default";
    // Safety net for the rare label that still had to be trimmed: hovering a
    // node always reveals its full name.
    const n = hit ? nodesById.get(hit.id) : null;
    canvas.title = n ? n.label : "";
  }

  function onUp(ev) {
    if (!dragState) return;
    const from = dragState.fromId;
    const moved = dragMoved;
    endDrag(true, ev);
    // A press that never became a drag is still a click, and a click still
    // plays the source.
    if (!moved) {
      const hit = nodeHitAt(ev.clientX, ev.clientY);
      if (hit && hit.id === from) playNode(from);
    }
  }

  function onKey(ev) {
    if (ev.key === "Escape" && dragState) endDrag(false, null);
  }

  // Move and release are watched on the window so a drag that leaves the canvas
  // still resolves; a release outside any node simply cancels. The panel is
  // rebuilt for every scene, so the previous scene's listeners are removed
  // first or they would pile up and act on a stale canvas.
  if (canvas.__asgDragOff) canvas.__asgDragOff();
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("keydown", onKey);
  canvas.__asgDragOff = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey);
  };

  canvas.addEventListener("mouseleave", () => {
    if (!dragState) canvas.style.cursor = "default";
  });

  function redraw(t) {
    lastT = t;
    drawDiagram(canvas, groups, edges, t, playingNodeId, dragState);
  }

  function resize() {
    redraw(lastT);
  }
  if (canvas.__asgResize) window.removeEventListener("resize", canvas.__asgResize);
  canvas.__asgResize = resize;
  window.addEventListener("resize", resize);

  // The diagram's container can also change size without a window resize --
  // e.g. graph-mode layout gives it a much larger panel, or the relation
  // list's height shifts the flex split. A ResizeObserver on the canvas's
  // parent catches those and redraws at the new size, so enlarging the
  // panel yields a bigger, crisp diagram rather than a small fixed canvas.
  const wrap = canvas.parentElement;
  if (wrap && window.ResizeObserver) {
    if (canvas.__asgRO) canvas.__asgRO.disconnect();
    const ro = new ResizeObserver(() => resize());
    ro.observe(wrap);
    canvas.__asgRO = ro;
  }

  resize();

  // Control object for parity with the QA panel's return value (used by the
  // global keyboard-shortcut handler / future callers). `update(t)` lets
  // app.js drive the diagram's active-node highlighting from the same
  // requestAnimationFrame master clock used for the spatial map/transcript
  // (see window.__renderPanels / the `panels` sync loop).
  return {
    update(t) {
      redraw(t);
    },
    // Stops any currently-playing node sample and clears its playing
    // indicator, without touching the master `#mix` audio. Called by app.js
    // on the previous scene's graph control before a new scene's panel is
    // built, so switching scenes never leaves a node sample playing.
    stop() {
      stopNodeAudio();
    },
  };
}
