import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, expect, it, vi } from 'vitest';
import { ReadingMarkdown } from './ReadingMarkdown';

afterEach(() => vi.unstubAllGlobals());

it('renders Markdown and only safe course images with descriptive alt text', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ markdown: '# Reading body\n\n![Good](/images/good.png) ![Bad](https://example.com/a.png) ![](/images/no-alt.png)\n\n<script>alert(1)</script>' }) }));
  const { container } = render(<MantineProvider><ReadingMarkdown courseId="course" drillId="lesson" /></MantineProvider>);
  expect(await screen.findByRole('heading', { name: 'Reading body' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Good' })).toHaveAttribute('src', '/images/good.png');
  expect(container.querySelectorAll('img')).toHaveLength(1);
  expect(container.querySelector('script')).toBeNull();
});
