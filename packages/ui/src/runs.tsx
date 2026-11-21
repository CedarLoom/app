import { Anchor, Button, Stack, Text, Title } from '@mantine/core';
import type { Api } from './api.ts';
import { type ReactNode, useState } from 'react';
import { text } from './message.ts';
import { Listing } from './listing.tsx';
import { Load } from './load.tsx';

const Run = ({ client, id, back }: { client: Api; id: string; back: () => void }): ReactNode => (
  <Stack align="flex-start">
    {/* The link that opened the run is gone: focus moves into the run. */}
    <Button variant="subtle" onClick={back} autoFocus>
      {text('ui.runs.back')}
    </Button>
    <Load request={() => client.GET('/api/runs/{id}', { params: { path: { id } } })}>
      {(run) => (
        <>
          <Title order={2}>{run.id}</Title>
          <Text>{text('ui.run.status', { status: run.status })}</Text>
          <Listing
            columns={['operation', 'path', 'status']}
            rows={run.operations.map(({ kind, path, status }, index) => [
              // A run may hold more than one operation on a path.
              String(index),
              text('ui.operation.kind', { kind }),
              path,
              text('ui.operation.status', { status }),
            ])}
            empty={text('ui.run.empty')}
          />
        </>
      )}
    </Load>
  </Stack>
);

/** The project's runs, newest first as the server lists them; a run's id opens its operations. */
export const Runs = ({ client }: { client: Api }): ReactNode => {
  // The run last opened: its link takes the focus back when the list returns.
  const [run, setRun] = useState<{ id: string; open: boolean } | null>(null);
  if (run?.open === true) {
    return <Run key={run.id} client={client} id={run.id} back={() => setRun({ id: run.id, open: false })} />;
  }
  return (
    <Load request={() => client.GET('/api/runs')}>
      {({ runs }) => (
        <Listing
          columns={['run', 'action', 'subject', 'status', 'started']}
          rows={runs.map(({ id, action, subject, status, startedAt }) => [
            id,
            <Anchor component="button" key={id} onClick={() => setRun({ id, open: true })} autoFocus={id === run?.id}>
              {id}
            </Anchor>,
            action,
            subject,
            text('ui.run.status', { status }),
            startedAt,
          ])}
          empty={text('ui.runs.empty')}
        />
      )}
    </Load>
  );
};
