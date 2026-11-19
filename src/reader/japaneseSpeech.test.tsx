import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Transformer } from 'markmap-lib';
import { MantineProvider } from '@mantine/core';
import { MapRecall, sanitizeMapNode } from './MapRecall';
import { WhiteboardMarkdown } from './WhiteboardMarkdown';
import { japaneseReading, japaneseVoice, useMapJapaneseSpeech } from './japaneseSpeech';

const voice = (name: string, lang: string) => ({ name, lang } as SpeechSynthesisVoice);
afterEach(() => vi.unstubAllGlobals());

describe('Japanese pronunciation', () => {
  it('parses only valid pronunciation fragments', () => {
    expect(japaneseReading('#ja')).toBeNull();
    expect(japaneseReading('#ja=%E3%81%8B%E3%81%AA')).toBe('かな');
    expect(japaneseReading('#ja=かな')).toBe('かな');
    expect(japaneseReading('#ja=')).toBeUndefined();
    expect(japaneseReading('#ja=%FF')).toBeUndefined();
    expect(japaneseReading('#japanese')).toBeUndefined();
  });
  it('prefers premium Japanese voices without using another language', () => {
    const voices = [voice('Kyoko', 'ja-JP'), voice('Google 日本語', 'ja-JP'), voice('Kyoko (Enhanced)', 'ja-JP'), voice('Premium', 'en-US')];
    expect(japaneseVoice(voices)?.name).toBe('Kyoko (Enhanced)');
    expect(japaneseVoice(voices.slice(0, 2))?.name).toBe('Google 日本語');
    expect(japaneseVoice([voice('Japanese', 'en-US')])).toBeUndefined();
  });
  it('preserves the marker through markmap sanitization and plays without bubbling', async () => {
    const speak = vi.fn();
    const synth = new EventTarget() as EventTarget & { getVoices: () => SpeechSynthesisVoice[]; speak: typeof speak; cancel: () => void };
    synth.getVoices = () => [voice('Kyoko', 'ja-JP')]; synth.speak = speak; synth.cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', synth);
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
    const content = sanitizeMapNode(new Transformer().transform('# [駅](#ja=えき)').root).content;
    expect(content).toContain('#ja=');
    const parentClick = vi.fn();
    function Map() { const host = document.createElement('div'); host.innerHTML = content; useMapJapaneseSpeech(host); return <div onClick={parentClick} ref={(el) => { if (el && host.parentNode !== el) el.append(host); }} />; }
    render(<Map />);
    const button = await screen.findByRole('button', { name: '播放日語發音' });
    expect(button.parentElement?.textContent).toBe('駅'); // Highlight offsets must not include the icon.
    fireEvent.click(button);
    expect(parentClick).not.toHaveBeenCalled();
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'えき', lang: 'ja-JP', rate: 1 }));
  });
  it('renders the same marker in whiteboard Markdown and hides the control without a Japanese voice', async () => {
    render(<WhiteboardMarkdown source="[駅](#ja=えき) と [こんにちは](#ja)" />);
    expect(screen.getByText('駅')).toHaveAttribute('lang', 'ja');
    expect(screen.getByText('こんにちは')).toHaveAttribute('lang', 'ja');
    await waitFor(() => expect(screen.queryByRole('button', { name: '播放日語發音' })).not.toBeInTheDocument());
  });
  it('plays annotated recall prompts and answers without revealing the answer', async () => {
    const speak = vi.fn();
    const synth = new EventTarget() as EventTarget & { getVoices: () => SpeechSynthesisVoice[]; speak: typeof speak; cancel: () => void };
    synth.getVoices = () => [voice('Kyoko', 'ja-JP')]; synth.speak = speak; synth.cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', synth);
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.startsWith('/api/map-recall/') ? { courseId: 'demo', drillId: 'recall', title: 'Recall', questions: [{ id: 'one', prompt: 'Say [駅](#ja=えき)', answer: '[こんにちは](#ja)' }] } : {} })));
    render(<MantineProvider><MapRecall courseId="demo" lessonId="recall" title="Recall" kind="recall" /></MantineProvider>);
    fireEvent.click(await screen.findByRole('button', { name: '播放日語發音' }));
    expect(speak).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'えき', lang: 'ja-JP' }));
    expect(screen.getByRole('button', { name: 'Show answer' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Show answer' }));
    fireEvent.click(screen.getAllByRole('button', { name: '播放日語發音' })[1]);
    expect(speak).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'こんにちは', lang: 'ja-JP' }));
  });
  it.each(['java', 'japanese', 'normal'])('keeps legacy #%s links literal in prompts and answers', async (fragment) => {
    const prompt = `Prompt [literal](#${fragment}) **unchanged**`;
    const answer = `Answer [literal](#${fragment}) **unchanged**`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.startsWith('/api/map-recall/') ? { courseId: 'demo', drillId: 'recall', title: 'Recall', questions: [{ id: 'one', prompt, answer }] } : {} })));
    render(<MantineProvider><MapRecall courseId="demo" lessonId="recall" title="Recall" kind="recall" /></MantineProvider>);
    expect(await screen.findByRole('heading', { name: prompt })).toHaveTextContent(prompt);
    fireEvent.click(screen.getByRole('button', { name: 'Show answer' }));
    expect(screen.getByText(answer)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
