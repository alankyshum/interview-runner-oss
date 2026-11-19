import { Skeleton, Stack, Group } from '@mantine/core';
import { Panel } from '../ui';
import classes from './reader.module.css';

export function ReaderSkeleton() {
  return (
    <Stack gap="sm" className={classes.readerContainer} data-testid="reader-skeleton" aria-hidden="true">
      <Panel label="Outline loading" padding="md" className={classes.stickyHeader}>
        <Group justify="space-between" mb="xs">
          <Skeleton height={28} width="40%" radius="sm" />
          <Skeleton height={20} width={48} radius="xl" />
        </Group>
        <Skeleton height={8} radius="xl" mt="xs" />
      </Panel>
      <Stack gap={0}>
        {[
          { depth: 0, width: '75%' },
          { depth: 1, width: '60%' },
          { depth: 2, width: '80%' },
          { depth: 3, width: '50%' },
          { depth: 0, width: '70%' },
          { depth: 1, width: '65%' },
        ].map((item, index) => (
          <div
            key={index}
            className={classes.nodeRow}
            style={{
              paddingInlineStart: `calc(var(--reader-indent) * ${item.depth} + var(--mantine-spacing-sm))`,
            }}
          >
            <div className={classes.chevronWrapper}>
              <Skeleton height={14} width={14} radius="sm" />
            </div>
            <div className={classes.checkboxSpacer} />
            <Skeleton height={18} width={item.width} radius="sm" />
            <Skeleton height={18} width={44} radius="sm" ml="auto" />
          </div>
        ))}
      </Stack>
    </Stack>
  );
}
