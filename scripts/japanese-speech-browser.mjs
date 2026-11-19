// Run against the local staging server linked to scripts/fixtures/japanese-speech.
// The session must be an owned, pinned agent-browser tab on the verified CDP service.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const [session, origin = 'http://127.0.0.1:5199'] = process.argv.slice(2);
if (!session || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Expected an owned browser session and a local staging origin');
const browser = (...args) => {
  const result = JSON.parse(execFileSync('agent-browser', ['--session', session, '--cdp', '9333', '--pin-tab', ...args, '--json'], { encoding: 'utf8' }));
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return result.data;
};
const evaluate = (source) => browser('eval', source).result;
const wait = (condition) => browser('wait', '--fn', condition);

for (const width of [1280, 390]) {
  browser('set', 'viewport', String(width), '844');
  browser('open', `${origin}/?course=jp-audio-demo&chapter=travel&drill=map`);
  wait('Boolean(document.querySelector(".map-recall-surface"))');
  evaluate(`localStorage.setItem('map-recall-view','map'); localStorage.removeItem('map-viewport:jp-audio-demo:map'); 'ok'`);
  browser('open', `${origin}/?course=jp-audio-demo&chapter=travel&drill=map`);
  wait('Boolean(document.querySelector(".map-recall-svg svg g.markmap-node"))');
  evaluate(`Object.defineProperty(speechSynthesis,'getVoices',{configurable:true,value:()=>[{name:'Kyoko (Enhanced)',lang:'ja-JP'}]}); window.__spoken=[]; window.SpeechSynthesisUtterance=class {constructor(text){this.text=text}}; speechSynthesis.speak=u=>window.__spoken.push({text:u.text,lang:u.lang}); speechSynthesis.cancel=()=>{}; speechSynthesis.dispatchEvent(new Event('voiceschanged')); 'ok'`);
  wait('document.querySelectorAll(".map-recall-svg button.japanese-speech").length > 0');
  browser('find', 'role', 'button', 'click', '--name', 'More map actions');
  wait('Boolean([...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent==="Expand all"))');
  browser('find', 'role', 'menuitem', 'click', '--name', 'Expand all');
  wait('document.querySelectorAll(".map-recall-svg button.japanese-speech").length===2');
  browser('wait', '700'); // Let responsive panes settle before fitting.
  browser('find', 'role', 'button', 'click', '--name', 'Fit visible');
  browser('wait', '700'); // Wait for the map's fit transition before hit-testing.
  const structure = evaluate(`(()=>{const svg=document.querySelector('.map-recall-svg svg');return [...svg.querySelectorAll('span[lang="ja"]')].map(span=>({text:span.textContent,buttons:span.parentElement.querySelectorAll('button.japanese-speech').length,before:getComputedStyle(span.nextElementSibling,'::before').content,after:getComputedStyle(span.nextElementSibling,'::after').content}))})()`);
  assert.equal(structure.length, 2);
  assert.deepEqual(Object.fromEntries(structure.map(({ text, buttons }) => [text, buttons])), { '駅はどこですか': 1, 'こんにちは': 1 });
  assert(structure.every(({ before, after }) => before.includes('🔊') && after === 'none'), 'Each phrase must have one speaker icon');
  for (const phrase of ['駅はどこですか', 'こんにちは']) {
    for (const [horizontal, vertical] of [['left', 'top'], ['right', 'top'], ['left', 'bottom'], ['right', 'bottom']]) {
      const state = evaluate(`(()=>{const b=[...document.querySelectorAll('.map-recall-svg button.japanese-speech')].find(x=>x.previousElementSibling.textContent===${JSON.stringify(phrase)});const r=b.getBoundingClientRect();const x=${horizontal === 'left' ? 'r.left+4' : 'r.right-4'},y=${vertical === 'top' ? 'r.top+4' : 'r.bottom-4'};return {x,y,target:document.elementFromPoint(x,y)===b,folds:[...document.querySelectorAll('.map-recall-svg .map-toggle-hit')].map(e=>e.getAttribute('aria-expanded')),spoken:window.__spoken.length}})()`);
      assert(state.target, `${width}px: ${phrase} ${horizontal}-${vertical} did not hit the button`);
      browser('mouse', 'move', String(Math.round(state.x)), String(Math.round(state.y))); browser('mouse', 'down'); browser('mouse', 'up');
      const after = evaluate(`({folds:[...document.querySelectorAll('.map-recall-svg .map-toggle-hit')].map(e=>e.getAttribute('aria-expanded')),spoken:window.__spoken})`);
      assert.deepEqual(after.folds, state.folds, 'Audio activation must not toggle the map');
      assert.equal(after.spoken.length, state.spoken + 1);
      assert.deepEqual(after.spoken.at(-1), { text: phrase === '駅はどこですか' ? 'えきはどこですか' : phrase, lang: 'ja-JP' });
    }
  }
  for (const expanded of ['true', 'false']) {
    const circle = evaluate(`(()=>{const h=[...document.querySelectorAll('.map-recall-svg .map-toggle-hit')].find(x=>x.getAttribute('aria-label').includes('駅はどこですか'));const r=h.parentElement.querySelector('circle').getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,target:document.elementFromPoint(x,y)===h,expanded:h.getAttribute('aria-expanded')}})()`);
    assert.equal(circle.expanded, expanded);
    assert(circle.target, `${width}px: branch toggle center is obscured`);
    browser('mouse', 'move', String(Math.round(circle.x)), String(Math.round(circle.y))); browser('mouse', 'down'); browser('mouse', 'up');
    wait(`Boolean([...document.querySelectorAll('.map-recall-svg .map-toggle-hit')].find(x=>x.getAttribute('aria-label').includes('駅はどこですか') && x.getAttribute('aria-expanded')==='${expanded === 'true' ? 'false' : 'true'}'))`);
  }
  wait('document.querySelectorAll(".map-recall-svg button.japanese-speech").length===2');
  console.log(`${width}px: two phrases, one icon each; all eight corner clicks speak without toggling; branch toggle works`);
}

// Compare the initial phone fit with an otherwise identical unannotated map.
const fontSize = () => evaluate(`(()=>{const svg=document.querySelector('.map-recall-svg svg');return parseFloat(getComputedStyle(svg.querySelector('g.markmap-node')).fontSize)*svg.__zoom.k})()`);
const freshMap = (drill) => {
  browser('open', `${origin}/?course=jp-audio-demo&chapter=travel&drill=${drill === 'map' ? 'plain' : 'map'}`);
  wait('Boolean(document.querySelector(".map-recall-surface"))');
  evaluate(`localStorage.removeItem('map-viewport:jp-audio-demo:${drill}'); 'ok'`);
  browser('open', `${origin}/?course=jp-audio-demo&chapter=travel&drill=${drill}`);
  wait('document.querySelectorAll(".map-recall-svg svg g.markmap-node").length===4');
  if (drill === 'map') {
    evaluate(`Object.defineProperty(speechSynthesis,'getVoices',{configurable:true,value:()=>[{name:'Kyoko (Enhanced)',lang:'ja-JP'}]}); speechSynthesis.dispatchEvent(new Event('voiceschanged')); 'ok'`);
    wait('document.querySelectorAll(".map-recall-svg button.japanese-speech:not([hidden])").length===2');
  }
  browser('wait', '1200');
  return fontSize();
};
const annotatedFont = freshMap('map');
const plainFont = freshMap('plain');
assert(annotatedFont >= plainFont * 0.99, `Phone fit reduced text from ${plainFont}px to ${annotatedFont}px`);
console.log(`390px initial fit: annotated ${annotatedFont.toFixed(2)}px; plain ${plainFont.toFixed(2)}px`);
