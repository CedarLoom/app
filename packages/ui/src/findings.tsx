import type { Finding } from '@cedarloom/core';
import { List, Stack, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { text } from './message.ts';

/** An answer's content, then its findings as their messages when there are any. */
export const WithFindings = ({
  findings,
  children,
}: {
  findings: readonly Finding[];
  children: ReactNode;
}): ReactNode => (
  <Stack>
    {children}
    {findings.length > 0 && (
      <>
        <Title order={2} size="h4">
          {text('ui.findings')}
        </Title>
        <List>
          {findings.map((finding, index) => (
            // Findings carry no id, and an answer may hold the same finding twice.
            <List.Item key={index}>{text(finding.code, finding.params)}</List.Item>
          ))}
        </List>
      </>
    )}
  </Stack>
);
