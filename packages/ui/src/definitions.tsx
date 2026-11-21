import type { Api } from './api.ts';
import type { ReactNode } from 'react';
import { WithFindings } from './findings.tsx';
import { text } from './message.ts';
import { Listing } from './listing.tsx';
import { Load } from './load.tsx';

/** The workflow definitions of the plugin and the project, with the findings of reading them. */
export const Definitions = ({ client }: { client: Api }): ReactNode => (
  <Load request={() => client.GET('/api/workflows')}>
    {({ workflows, findings }) => (
      <WithFindings findings={findings}>
        <Listing
          columns={['name', 'source', 'description']}
          rows={workflows.map(({ name, source, description }) => [`${source}/${name}`, name, source, description])}
          empty={text('ui.definitions.empty')}
        />
      </WithFindings>
    )}
  </Load>
);
