import { createTheme } from '@mantine/core';
import { MONOSPACE_FONT_FAMILY, UI_FONT_FAMILY } from './typography';

export const theme = createTheme({
  fontFamily: UI_FONT_FAMILY,
  fontFamilyMonospace: MONOSPACE_FONT_FAMILY,
  headings: {
    fontFamily: UI_FONT_FAMILY,
    sizes: {
      h1: { fontSize: '1.75rem', lineHeight: '2.25rem', fontWeight: '700' },
      h2: { fontSize: '1.25rem', lineHeight: '1.75rem', fontWeight: '600' },
      h3: { fontSize: '1rem', lineHeight: '1.5rem', fontWeight: '600' },
      h4: { fontSize: '.875rem', lineHeight: '1.25rem', fontWeight: '600' },
    },
  },
  fontSizes: {
    xs: '.75rem',
    sm: '.875rem',
    md: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
  },
  lineHeights: {
    xs: '16px',
    sm: '20px',
    md: '24px',
    lg: '28px',
    xl: '32px',
  },
  spacing: {
    xs: '.25rem',
    sm: '.5rem',
    md: '1rem',
    lg: '1.5rem',
    xl: '2rem',
  },
  radius: {
    xs: '.25rem',
    sm: '.5rem',
    md: '.75rem',
    lg: '1rem',
    xl: '1.5rem',
  },
  defaultRadius: 'sm',
  cursorType: 'pointer',
  primaryColor: 'blue',
  components: {
    Progress: {
      defaultProps: {
        radius: 'xl',
        size: 'sm',
      },
    },
    Badge: {
      defaultProps: {
        radius: 'sm',
      },
    },
    Paper: {
      defaultProps: {
        radius: 'sm',
      },
    },
  },
});
