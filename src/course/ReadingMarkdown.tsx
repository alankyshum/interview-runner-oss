import { useEffect, useState } from 'react';
import { Alert, Loader, Text } from '@mantine/core';
import { Panel } from '../ui';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { validCourseImage } from '../reader/imagePath';

export function ReadingMarkdown({ courseId, drillId }: { courseId: string; drillId: string }) {
  const [state, setState] = useState<{ markdown?: string; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    void fetch(`/api/reading/${encodeURIComponent(courseId)}/${encodeURIComponent(drillId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Unable to load reading (${response.status})`);
        const data = await response.json() as { markdown?: unknown };
        if (typeof data.markdown !== 'string') throw new Error('Invalid reading content');
        setState({ markdown: data.markdown });
      }).catch((error: unknown) => { if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : 'Unable to load reading' }); });
    return () => controller.abort();
  }, [courseId, drillId]);
  if (state.error) return <Alert color="red" role="alert" title="Reading unavailable">{state.error}</Alert>;
  if (state.markdown === undefined) return <Text><Loader size="xs" aria-hidden="true" /> Loading reading…</Text>;
  return <Panel component="article" role="article" label="Reading content" padding="md" className="instruction-pane" style={{ minWidth: 0, overflowWrap: 'anywhere' }}><Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ src, alt }) => {
    if (!validCourseImage(src, alt)) return null;
    return <img src={src} alt={alt} style={{ maxWidth: '100%', height: 'auto' }} />;
  } }}>{state.markdown}</Markdown></Panel>;
}
