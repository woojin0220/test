import { createSpatialMap } from './spatialmap.js';
import { createTranscript } from './transcript.js';
import { createGraphPanel } from './graph.js';
import { createQAPanel } from './qa.js';
import { annotateScene } from './identity.js';

const scenes = [
  {
    kind: 'Single-node perception',
    scene_id: 0,
    caption: 'On a rainy balcony, two friends chat and a violinist plays and moves across the space, punctuated by a nearby cough and jingling bells.',
    mix_url: '/audio/rainy-balcony.flac', n_questions: 1,
    sources: [
      {id:1,cls:'speaker',transcription:"Listen, someone's playing violin out here in the rain.",onset:.5,offset:4.6,position:[-.6,0,-.5],moving:false},
      {id:2,cls:'speaker',transcription:"Yeah, it's beautiful. He's been walking toward the right side of the balcony.",onset:5.6,offset:10.2,position:[.7,0,-.6],moving:false},
      {id:3,cls:'Violin, fiddle',onset:1,offset:26,position:[-1.8,-.2,-1.5],moving:true},
      {id:4,cls:'Jingle bell',onset:12,offset:18.5,position:[1.2,-.1,-1],moving:true},
      {id:5,cls:'Cough',onset:19.5,offset:21.2,position:[.5,0,.8],moving:false},
      {id:6,cls:'speaker',transcription:'Bless you! Are you cold out here? We can move inside if the rain gets worse.',onset:21.8,offset:28.4,position:[-.6,0,-.5],moving:false}
    ],
    graph:{nodes:[],edges:[{source:1,target:2,causal:'result'},{source:5,target:6,causal:'cause'}]},
    qa:[{question:'Which sound event occurs behind the listener?',options:{A:'Violin',B:'Jingle bell',C:'Cough',D:'Rain'},answer:'C'}]
  },
  {
    kind: 'Single-relation reasoning', scene_id: 1,
    caption:'In a spacious garage, two people chat and a vacuum cleaner rolls across the floor and a dog barks, with faint traffic noise from outside.',
    mix_url:'/audio/garage-vacuum.flac',n_questions:1,
    sources:[{id:1,cls:'speaker',transcription:'Can you hear that from outside?',onset:.5,offset:4.7,position:[.7,0,-.6],moving:false},{id:2,cls:'speaker',transcription:"It sounds like someone's cleaning the garage.",onset:4,offset:8.9,position:[.8,0,.7],moving:false},{id:3,cls:'Vacuum cleaner',onset:4.5,offset:11.5,position:[.6,-.2,.9],moving:true},{id:4,cls:'Dog',onset:9.2,offset:12.4,position:[-1.1,-.2,-.7],moving:false}],
    graph:{nodes:[],edges:[{source:1,target:2,causal:'result'},{source:2,target:3,causal:'cause'},{source:3,target:4,causal:'cause'}]},
    qa:[{question:'Which event directly causes the dog to bark?',options:{A:'Speaker A',B:'Speaker B',C:'Vacuum cleaner',D:'Traffic'},answer:'C'}]
  },
  {
    kind:'Multi-relation reasoning',scene_id:2,
    caption:'In a TV room, one person comments on a housefly buzzing past and a telephone rings and a kettle whistles in the background.',
    mix_url:'/audio/tv-room.flac',n_questions:1,
    sources:[{id:1,cls:'telephone',onset:.5,offset:3.2,position:[.8,-.2,-.6],moving:false},{id:2,cls:'speaker',transcription:'Did you see that fly go by?',onset:3.4,offset:10,position:[-.7,0,-.6],moving:false},{id:3,cls:'Fly, housefly',onset:3.6,offset:7.5,position:[-.5,0,-.5],moving:false},{id:4,cls:'Kettle whistle',onset:10.3,offset:12.5,position:[.8,-.2,.8],moving:false}],
    graph:{nodes:[],edges:[{source:1,target:2,causal:'result'},{source:2,target:3,causal:'result'}]},
    qa:[{question:'What sequence best explains the speaker’s comment about the fly?',options:{A:'Fly → telephone → speaker',B:'Telephone → speaker → fly',C:'Kettle → fly → speaker',D:'Speaker → telephone → kettle'},answer:'B'}]
  }
];

const sid = Number(new URLSearchParams(location.search).get('scene') || 0);
const scene = scenes[sid] || scenes[0];
scene.existing = {};
window.__app = { api: async () => ({ completed:false }) };
annotateScene(scene);
document.getElementById('sceneType').textContent = scene.kind;
const mix = document.getElementById('mix'); mix.src = scene.mix_url;
const panels = [];
panels.push(createSpatialMap(document.getElementById('map'), scene));
panels.push(createTranscript(document.getElementById('transcriptBody'), scene));
createGraphPanel(scene, 'showcase', {diagramEl:document.getElementById('qaBody'),causalEl:document.getElementById('causalBody'),verdictEl:document.createElement('div')});
createQAPanel(document.getElementById('graphRelBody'), scene, 'showcase', {readOnly:true});
function tick(){ for(const panel of panels) panel.update(mix.currentTime); requestAnimationFrame(tick); }
tick();
