import { Tooltip } from '@mantine/core';
import { IconBook2, IconChalkboard, IconCode, IconFileText, IconMap, IconQuestionMark } from '@tabler/icons-react';
import type { ContentType } from '../../shared/courseSchema';

export function ContentTypeIcon({ type, whiteboard = false }: { type: ContentType; whiteboard?: boolean }) {
  const isWhiteboard = type === 'whiteboard' || (type === 'recall' && whiteboard);
  const label = isWhiteboard ? 'Whiteboard' : { reading: 'Reading', coding: 'Coding', 'ai-coding': 'AI-assisted coding', cheatsheet: 'Cheatsheet', map: 'Reference', recall: 'Recall', whiteboard: 'Whiteboard' }[type];
  const Icon = isWhiteboard ? IconChalkboard : { reading: IconBook2, coding: IconCode, 'ai-coding': IconCode, cheatsheet: IconFileText, map: IconMap, recall: IconQuestionMark, whiteboard: IconChalkboard }[type];
  return <Tooltip label={label}><span role="img" aria-label={label} style={{ display: 'inline-flex', flexShrink: 0 }}><Icon size={16} aria-hidden="true" /></span></Tooltip>;
}
