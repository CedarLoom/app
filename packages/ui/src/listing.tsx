import { Table, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { text } from './message.ts';

type Column =
  | 'check'
  | 'status'
  | 'run'
  | 'action'
  | 'subject'
  | 'started'
  | 'name'
  | 'source'
  | 'description'
  | 'operation'
  | 'path';

/** A table: a header of the named columns, then a row per entry (its key, then its cells); `empty`, if given, for none. */
export const Listing = ({
  columns,
  rows,
  empty,
}: {
  columns: readonly Column[];
  rows: readonly (readonly [string, ...ReactNode[]])[];
  empty?: string;
}): ReactNode =>
  rows.length === 0 && empty !== undefined ? (
    <Text>{empty}</Text>
  ) : (
    <Table>
      <Table.Thead>
        <Table.Tr>
          {columns.map((column) => (
            <Table.Th key={column}>{text('ui.column', { column })}</Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map(([key, ...cells]) => (
          <Table.Tr key={key}>
            {cells.map((cell, index) => (
              <Table.Td key={columns[index]}>{cell}</Table.Td>
            ))}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
