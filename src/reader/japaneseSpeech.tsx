import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import './japaneseSpeech.css';

/** A fragment link is used so both Markdown renderers preserve the authoring syntax. */
export function japaneseReading(href: string | undefined): string | null | undefined {
  if (href === '#ja') return null;
  if (!href?.startsWith('#ja=')) return undefined;
  try { const reading = decodeURIComponent(href.slice(4)); return reading.trim() ? reading : undefined; }
  catch { return undefined; }
}

export function hasJapanesePronunciation(source: string): boolean {
  return [...source.matchAll(/\]\((#ja(?:=[^\s)]*)?)\)/g)].some((match) => japaneseReading(match[1]) !== undefined);
}

export function japaneseVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const score = (voice: SpeechSynthesisVoice) => /enhanced|premium/i.test(voice.name) ? 3 : /google.*日本語|google.*japanese/i.test(voice.name) ? 2 : 1;
  return voices.filter((voice) => /^ja[-_]jp$/i.test(voice.lang)).sort((a, b) => score(b) - score(a))[0];
}

function useJapaneseVoice() {
  const [voice, setVoice] = useState<SpeechSynthesisVoice>();
  useEffect(() => {
    if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') return;
    const synth = window.speechSynthesis;
    const update = () => setVoice(japaneseVoice(synth.getVoices()));
    update(); synth.addEventListener('voiceschanged', update);
    return () => synth.removeEventListener('voiceschanged', update);
  }, []);
  return voice;
}

function speak(text: string, voice: SpeechSynthesisVoice) {
  if (!text.trim()) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP'; utterance.voice = voice; utterance.rate = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export function JapaneseLink({ href, children, title }: ComponentPropsWithoutRef<'a'>) {
  const reading = japaneseReading(href);
  const voice = useJapaneseVoice();
  const text = useRef<HTMLSpanElement>(null);
  if (reading === undefined) return <a href={href} title={title}>{children}</a>;
  return <><span lang="ja" ref={text}>{children}</span>{voice && <button className="japanese-speech" type="button" aria-label="播放日語發音" onClick={(event) => { event.stopPropagation(); speak(reading ?? text.current?.textContent ?? '', voice); }} onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()} />}</>;
}

/** Markmap owns its DOM and redraws nodes, so decorate only its sanitized links. */
export function useMapJapaneseSpeech(container: Element | null) {
  const voice = useJapaneseVoice();
  useEffect(() => {
    if (!container) return;
    const sync = () => {
      for (const link of container.querySelectorAll<HTMLAnchorElement>('a[href^="#ja"]')) {
        const reading = japaneseReading(link.getAttribute('href') ?? undefined);
        if (reading === undefined) continue;
        const span = document.createElement('span'); span.lang = 'ja';
        while (link.firstChild) span.append(link.firstChild);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'japanese-speech'; button.setAttribute('aria-label', '播放日語發音');
        if (reading !== null) button.dataset.say = reading;
        button.hidden = !voice;
        link.replaceWith(span, button);
      }
      for (const button of container.querySelectorAll<HTMLButtonElement>('button.japanese-speech')) if (button.hidden !== !voice) button.hidden = !voice;
    };
    const click = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>('button.japanese-speech');
      if (!button || !container.contains(button)) return;
      event.stopPropagation(); event.preventDefault();
      if (voice) speak(button.dataset.say ?? button.previousElementSibling?.textContent ?? '', voice);
    };
    const key = (event: Event) => { if (event.target instanceof Element && event.target.closest('button.japanese-speech')) event.stopPropagation(); };
    container.addEventListener('click', click, true); container.addEventListener('keydown', key, true); container.addEventListener('keyup', key, true);
    const observer = new MutationObserver(sync); observer.observe(container, { childList: true, subtree: true }); sync();
    return () => { observer.disconnect(); container.removeEventListener('click', click, true); container.removeEventListener('keydown', key, true); container.removeEventListener('keyup', key, true); };
  }, [container, voice]);
}
