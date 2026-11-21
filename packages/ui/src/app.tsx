import { AppShell, Tabs, Title } from '@mantine/core';
import { History, Stethoscope, Workflow } from 'lucide-react';
import { api } from './api.ts';
import type { ReactNode } from 'react';
import { Definitions } from './definitions.tsx';
import { Doctor } from './doctor.tsx';
import { text } from './message.ts';
import { Refused } from './load.tsx';
import { Runs } from './runs.tsx';
import type { Opened } from './session.ts';

/** The shell: the title and one tab per view once the session is open, the session's refusal otherwise. */
export const App = ({ opened }: { opened: Opened }): ReactNode => {
  const content = (): ReactNode => {
    if ('refusal' in opened) return <Refused refusal={opened.refusal} />;
    const client = api({ 'x-cedarloom-csrf': opened.csrf });
    return (
      <Tabs defaultValue="doctor" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="doctor" leftSection={<Stethoscope size={16} />}>
            {text('ui.view', { view: 'doctor' })}
          </Tabs.Tab>
          <Tabs.Tab value="runs" leftSection={<History size={16} />}>
            {text('ui.view', { view: 'runs' })}
          </Tabs.Tab>
          <Tabs.Tab value="definitions" leftSection={<Workflow size={16} />}>
            {text('ui.view', { view: 'definitions' })}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="doctor" pt="md">
          <Doctor client={client} />
        </Tabs.Panel>
        <Tabs.Panel value="runs" pt="md">
          <Runs client={client} />
        </Tabs.Panel>
        <Tabs.Panel value="definitions" pt="md">
          <Definitions client={client} />
        </Tabs.Panel>
      </Tabs>
    );
  };
  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header px="md" display="flex" style={{ alignItems: 'center' }}>
        <Title order={1} size="h3">
          {text('ui.title')}
        </Title>
      </AppShell.Header>
      <AppShell.Main>{content()}</AppShell.Main>
    </AppShell>
  );
};
