import { AppShell, Tabs, Title } from '@mantine/core';
import { History, Stethoscope, Workflow } from 'lucide-react';
import { api } from './api.ts';
import type { ReactNode } from 'react';
import { Definitions } from './definitions.tsx';
import { Doctor } from './doctor.tsx';
import { text } from './message.ts';
import { type Answer, Load } from './load.tsx';
import { Runs } from './runs.tsx';

/** The shell: the title, then one tab per view once `session` opens the session, or why it did not. */
export const App = ({ session }: { session: () => Promise<Answer<{ csrf: string }>> }): ReactNode => (
  <AppShell header={{ height: 56 }} padding="md">
    <AppShell.Header px="md" display="flex" style={{ alignItems: 'center' }}>
      <Title order={1} size="h3">
        {text('ui.title')}
      </Title>
    </AppShell.Header>
    <AppShell.Main>
      <Load request={session}>
        {({ csrf }) => {
          const client = api({ 'x-cedarloom-csrf': csrf });
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
        }}
      </Load>
    </AppShell.Main>
  </AppShell>
);
