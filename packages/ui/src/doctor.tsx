import { Text } from '@mantine/core';
import type { Api } from './api.ts';
import type { ReactNode } from 'react';
import { WithFindings } from './findings.tsx';
import { text } from './message.ts';
import { Listing } from './listing.tsx';
import { Load } from './load.tsx';

/** The doctor's checks, the plugin it found and its findings. */
export const Doctor = ({ client }: { client: Api }): ReactNode => (
  <Load request={() => client.GET('/api/doctor')}>
    {({ checks, plugin, findings }) => (
      <WithFindings findings={findings}>
        <Listing
          columns={['check', 'status']}
          rows={checks.map(({ id, status }) => [
            id,
            text('ui.doctor.check', { id }),
            text('ui.doctor.status', { status }),
          ])}
        />
        <Text>{plugin === null ? text('ui.doctor.no-plugin') : text('ui.doctor.plugin', plugin)}</Text>
      </WithFindings>
    )}
  </Load>
);
