import { Anchor, Button, Stack, Text, Title } from '@mantine/core';
import type { Api } from './api.ts';
import { type ReactNode, useState } from 'react';
import { text } from './message.ts';
import { Listing } from './listing.tsx';
import { Load } from './load.tsx';

const Run = ({ client, id, back }: { client: Api; id: string; back: () => void }): ReactNode => (
  <Stack align="flex-start">
    <Button variant="subtle" onClick={back}>
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
          />
        </>
      )}
    </Load>
  </Stack>
);

/** The project's runs, newest first as the server lists them; a run's id opens its operations. */
export const Runs = ({ client }: { client: Api }): ReactNode => {
  const [open, setOpen] = useState<string | null>(null);
  if (open !== null) return <Run key={open} client={client} id={open} back={() => setOpen(null)} />;
  return (
    <Load request={() => client.GET('/api/runs')}>
      {({ runs }) => (
        <Listing
          columns={['run', 'action', 'subject', 'status', 'started']}
          rows={runs.map(({ id, action, subject, status, startedAt }) => [
            id,
            <Anchor component="button" key={id} onClick={() => setOpen(id)}>
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
