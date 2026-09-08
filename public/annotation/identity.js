// Who is who: recovers physical-source identity across a scene's sources.
//
// One person speaking twice is stored as two independent sources, so the graph
// used to show them as two unrelated nodes. That happens in 45% of the
// 10,085-scene label. Sources are grouped here, and the graph draws ONE node
// per group, so a node is a thing in the room rather than one of its events.
//
// The label has an explicit `Speech` field mapping speaker -> utterances, but
// only in test_label.json; the real label the packs are built from does not
// carry it. Position is the recoverable signal instead: the same person stays
// in one spot, so sources sharing a position are the same physical source.
// This is the same rule the spatial map has always used to merge its markers.
//
// Measured against the 30 scenes that DO have `Speech`, position grouping
// reproduces the ground-truth speaker grouping exactly, 30/30, and no group
// ever contains two different speakers. Across the full label the two things
// that could break it barely occur: only 8 of 23,955 speech sources move at
// all (0.03%), and the 456 positions shared between a speech source and
// another class are cases like "Humming + speaker" or "speaker + Hiccup" --
// the same person, correctly merged.

// Position match tolerance, in metres, matching the spatial map's own rounding
// (groupKey in spatialmap.js) so the map and the graph never disagree about
// who is who.
const POS_ROUND = 100; // 2 decimal places

function posKey(s) {
  const p = s.position;
  if (!Array.isArray(p)) return null;
  return p.map((v) => Math.round(v * POS_ROUND) / POS_ROUND).join(",");
}

function isSpeech(s) {
  return typeof s.cls === "string" && s.cls.toLowerCase().includes("speaker");
}

// Letters, then double letters, so a pathological scene never runs out.
function letterFor(i) {
  let s = "";
  i += 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

// Groups a scene's sources into physical sources.
//
// A moving source becomes its own group rather than joining one: its position
// is a function of time so it cannot be matched against anyone else's, but it
// is still a distinct thing in the room. This mirrors buildGroups() in
// spatialmap.js, which also keeps moving sources as singletons.
//
// Only scenes with at least two distinct speaking groups get person letters:
// in a one-speaker scene "speaker A" would be noise, since there is no B to
// tell it apart from.
export function assignGroups(sources) {
  const list = sources || [];
  const byKey = new Map();
  const groups = [];
  for (const s of list) {
    const key = s.moving ? `moving:${s.id}` : posKey(s);
    if (key === null) continue;
    let g = byKey.get(key);
    if (!g) {
      g = { key, members: [], hasSpeech: false, onset: Infinity, offset: -Infinity };
      byKey.set(key, g);
      groups.push(g);
    }
    g.members.push(s);
    g.hasSpeech = g.hasSpeech || isSpeech(s);
    if (typeof s.onset === "number") g.onset = Math.min(g.onset, s.onset);
    if (typeof s.offset === "number") g.offset = Math.max(g.offset, s.offset);
  }

  // Person letters, in order of first appearance, so "A" speaks first.
  //
  // A one-speaker scene normally gets no letter: "speaker A" would be noise
  // when there is no B to tell it apart from. The exception is a speaker who
  // sounds more than once, because the graph splits them into one circle per
  // utterance and names the pair by ordinal. Without a letter that reads
  // "speaker 1" / "speaker 2" -- which looks like two different people, the
  // exact confusion the grouping exists to remove. With one it reads
  // "speaker A1" / "speaker A2": one person, two sounds.
  const repeatsAClass = (g) => {
    const seen = new Set();
    for (const m of g.members) {
      if (seen.has(m.cls)) return true;
      seen.add(m.cls);
    }
    return false;
  };
  const speaking = groups.filter((g) => g.hasSpeech);
  if (speaking.length >= 2 || speaking.some(repeatsAClass)) {
    [...speaking].sort((a, b) => a.onset - b.onset)
      .forEach((g, i) => { g.person = letterFor(i); });
  }

  for (const g of groups) {
    // A group is identified by its lowest member id: stable, compact, and it
    // survives being written into a note (see the flag keys in graph.js).
    g.id = Math.min(...g.members.map((m) => m.id));
    g.ids = g.members.map((m) => m.id).sort((a, b) => a - b);
    // One name per group, not one per event: distinct classes, plus the person
    // letter when there is one. "speaker A", "Humming, speaker A", "Cough".
    const classes = [...new Set(g.members.map((m) => m.cls))].join(", ");
    g.label = g.person ? `${classes} ${g.person}` : classes;
    if (g.onset === Infinity) g.onset = 0;
    if (g.offset === -Infinity) g.offset = 0;
  }
  return groups;
}

// Stamps identity onto a scene payload, in place, so every panel reads the same
// annotation instead of recomputing it. Safe to call more than once.
//
//   source.person / node.person  -- letter, or null
//   source.gid    / node.gid     -- id of the group the source belongs to
//   scene.groups                 -- the groups themselves, for the graph
export function annotateScene(scene) {
  const groups = assignGroups(scene.sources);
  const gidOf = new Map();
  const personOf = new Map();
  for (const g of groups) {
    for (const id of g.ids) { gidOf.set(id, g.id); personOf.set(id, g.person || null); }
  }
  for (const s of scene.sources || []) {
    s.person = personOf.get(s.id) || null;
    s.gid = gidOf.has(s.id) ? gidOf.get(s.id) : s.id;
  }
  for (const n of (scene.graph && scene.graph.nodes) || []) {
    n.person = personOf.get(n.id) || null;
    n.gid = gidOf.has(n.id) ? gidOf.get(n.id) : n.id;
  }
  scene.groups = groups;
  scene.events = eventNodes(scene);
  return groups;
}

// One node per SOUND EVENT, for the scene graph.
//
// The graph draws these rather than the position groups above. A subject that
// sounds twice gets two circles, so a causal arrow can start and end on the
// exact event the relation names -- with one merged circle per subject, an
// arrow between two of a person's own utterances had nowhere to point and was
// drawn as a loop that said nothing about which utterance was which.
//
// The shape matches assignGroups' output (id/ids/members/label/onset/offset)
// so everything downstream is indifferent to which of the two it was handed;
// here each "group" simply holds a single source.
//
// Position grouping is still what assigns the person letters, so both of A's
// circles read "speaker A" and the pair is still legible as one person.
function eventNodes(scene) {
  const list = scene.sources || [];
  const nodes = list.map((s) => ({
    key: `event:${s.id}`,
    id: s.id,
    ids: [s.id],
    members: [s],
    person: s.person || null,
    hasSpeech: isSpeech(s),
    onset: typeof s.onset === "number" ? s.onset : 0,
    offset: typeof s.offset === "number" ? s.offset : 0,
    // Non-breaking space before the person letter: the wrap picks the most
    // even split, which would otherwise leave "speaker" on one line and the
    // letter on the next. The letter belongs to the name.
    label: s.person ? `${s.cls}\u00A0${s.person}` : s.cls,
  }));
  // Source numbers are gone from the UI, so the two circles of a
  // twice-sounding subject would otherwise carry the same name -- and telling
  // them apart is the entire point of having split them. Colliding names are
  // numbered in onset order: "speaker A1", "speaker A2", so the digit reads as
  // "A's first / second sound" and matches the order the transcript lists them
  // in. A name that is already unique is left alone.
  //
  // The digit sits flush against the person letter ("A1") because the letter
  // is who and the digit is which -- they name one thing together. Without a
  // letter there is nothing to attach to, so it takes a space ("Dog 1").
  const seen = new Map();
  for (const n of nodes) seen.set(n.label, (seen.get(n.label) || 0) + 1);
  const nth = new Map();
  for (const n of [...nodes].sort((a, b) => a.onset - b.onset)) {
    if (seen.get(n.label) < 2) continue;
    const base = n.label;
    const i = (nth.get(base) || 0) + 1;
    nth.set(base, i);
    n.label = n.person ? `${base}${i}` : `${base} ${i}`;
  }

  // Ring order. The diagram lays nodes out evenly around an ellipse in array
  // order, and the array used to be source-id order -- which put A1 and A2 on
  // opposite sides of the circle with other sources between them, so one
  // person read as two unrelated things and the split undid the very grouping
  // it was built on top of.
  //
  // Events of one subject are kept adjacent, and the subjects run in the order
  // they first sound, so the ring also reads roughly as a timeline. Ties fall
  // back to id so the layout is stable rather than dependent on sort order.
  // How many circles this subject gets. The diagram draws a multi-event
  // subject as a touching cluster of smaller circles at one ring position,
  // so it needs to know which nodes are part of one.
  const perGid = new Map();
  for (const n of nodes) perGid.set(n.members[0].gid, (perGid.get(n.members[0].gid) || 0) + 1);
  for (const n of nodes) n.split = perGid.get(n.members[0].gid) > 1;

  const firstOnset = new Map();
  const gidOf = (n) => n.members[0].gid;
  for (const n of nodes) {
    const g = gidOf(n);
    if (!firstOnset.has(g) || n.onset < firstOnset.get(g)) firstOnset.set(g, n.onset);
  }
  nodes.sort((a, b) => {
    const ga = gidOf(a), gb = gidOf(b);
    if (ga !== gb) return firstOnset.get(ga) - firstOnset.get(gb) || ga - gb;
    return a.onset - b.onset || a.id - b.id;
  });
  return nodes;
}

// Kept for the spatial map, which labels a merged marker by its members.
// Numbers were dropped from the map on the author's instruction: after
// merging, one marker can cover several ids and the compound prefix
// ("2,4:Humming, speaker") read as noise. Checked across the pack: with the
// person letter in place, no two markers in any scene share a name.
export function nodeLabel(id, cls, person) {
  return person ? `${cls} ${person}` : cls;
}
