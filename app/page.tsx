const demos = [
  ['01', 'Single-node perception', 'Identify a single sound event in 3D space.', '0'],
  ['02', 'Single-relation reasoning', 'Follow one causal relationship across a scene.', '1'],
  ['03', 'Multi-relation reasoning', 'Trace connected events and their dependencies.', '2'],
];

export default function Home() {
  return <main className="researchPage">
    <header className="researchNav"><a href="#top" className="wordmark">BinauralLALM</a><nav><a href="#demos">Demos</a><a href="#paper">Paper</a></nav></header>
    <section className="researchHero" id="top"><p>Spatially grounded audio-language dataset</p><h1>Reason about<br/>sound in space.</h1><span>Binaural audio, scene graphs, and language evidence in one dataset.</span><a href="#demos">Explore the demos ↓</a></section>
    <section className="researchIntro"><div className="abstractSlot"><span>Abstract</span></div><div className="figureSlot" aria-label="Method figure placeholder"><span>Figure</span></div></section>
    <section id="demos" className="demoSequence">{demos.map(([number,title,description,scene])=><article className="demoSection" key={number}><div className="demoText"><span>{number}</span><h2>{title}</h2><p>{description}</p></div><iframe title={title} src={`/annotation/index.html?scene=${scene}`} loading="lazy" /></article>)}</section>
    <footer>BinauralLALM · Private research preview</footer>
  </main>;
}
