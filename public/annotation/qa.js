export function createQAPanel(el, scene, vid, { readOnly = false } = {}) {
  const api = window.__app && window.__app.api;
  const answers = {};  // q_idx -> {verdict, note}
  for (const [k,v] of Object.entries(scene.existing || {})) answers[+k] = {...v};
  let cur = 0;
  const N = scene.n_questions;

  el.innerHTML = `
    <div id="qnav"><button id="prevQ">◀</button>
      <span id="qpos"></span><button id="nextQ">▶</button></div>
    <div id="qbody"></div>`;
  const qpos = el.querySelector("#qpos"), qbody = el.querySelector("#qbody");

  function render() {
    const q = scene.qa[cur];
    qpos.textContent = `Q ${cur+1} / ${N}`;
    const a = answers[cur] || {};
    const opts = Object.entries(q.options).map(([k,v]) =>
      `<div class="qopt ${k===q.answer?"correct":""}">${k}. ${v}</div>`).join("");
    qbody.innerHTML = `
      <p class="question">${q.question}</p>
      <div class="options">${opts}</div>
      <p class="recorded-answer"><b>Recorded answer:</b> ${q.answer}</p>
      ${readOnly ? "" : `<div class="verdict">${["reasonable","unreasonable","unsure"].map(v => `<button data-v="${v}" class="${a.verdict===v?"sel":""}">${v}</button>`).join("")}</div><textarea id="note" placeholder="note (optional)">${a.note||""}</textarea>`}`;
    if (!readOnly) {
      qbody.querySelectorAll(".verdict button").forEach(b => b.addEventListener("click", () => save(b.dataset.v)));
      qbody.querySelector("#note").addEventListener("blur", (e) => { if (answers[cur]) save(answers[cur].verdict, e.target.value); });
    }
  }

  async function save(verdict, note) {
    note = (note !== undefined) ? note : (qbody.querySelector("#note")?.value || null);
    const res = await api("/api/response", { method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({validator_id: vid, scene_id: scene.scene_id,
        q_idx: cur, verdict, note: note || null}) });
    answers[cur] = {verdict, note};
    render();
    if (res.completed) document.getElementById("nextScene").hidden = false;
  }

  function prevQuestion() { if (cur>0){cur--; render();} }
  function nextQuestion() { if (cur<N-1){cur++; render();} }

  el.querySelector("#prevQ").addEventListener("click", prevQuestion);
  el.querySelector("#nextQ").addEventListener("click", nextQuestion);
  render();
  // if already complete on load (resume), expose next button
  if (!readOnly && Object.keys(answers).length >= N) document.getElementById("nextScene").hidden = false;

  // Control object for the global keyboard-shortcut handler in app.js: lets
  // it drive question navigation and verdict recording for whichever QA
  // panel is currently loaded, without duplicating the save/render logic.
  return {
    prevQuestion,
    nextQuestion,
    record(verdict) { save(verdict); },
  };
}
