import { Refusal } from '@cedarloom/core';
import { Alert, Loader } from '@mantine/core';
import { type ReactNode, useEffect, useState } from 'react';
import { text } from './message.ts';

export type Answer<T> = { response: Response } & ({ data: T; error?: never } | { data?: never; error: Refusal });

/**
 * The answer of `request`, sent once when it mounts: a loader until it arrives, then its data or its refusal, or an
 * alert when the server cannot be reached or answers with neither.
 */
export const Load = <T,>({
  request,
  children,
}: {
  request: () => Promise<Answer<T>>;
  children: (data: T) => ReactNode;
}): ReactNode => {
  const [answer, setAnswer] = useState<Answer<T> | 'unreachable' | null>(null);
  // Sent once: a parent remounts it with a key to ask again.
  useEffect(() => {
    let mounted = true;
    void request().then(
      (received) => {
        if (mounted) setAnswer(received);
      },
      (error: unknown) => {
        if (mounted) setAnswer('unreachable');
        throw error;
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  if (answer === null) return <Loader role="status" aria-label={text('ui.loading')} />;
  if (answer === 'unreachable') return <Failed message={text('ui.unreachable')} />;
  if (answer.response.ok && answer.data !== undefined) return children(answer.data);
  // Another answer than the server's own, such as a 503 while it closes or an empty body, is no refusal.
  const refusal = Refusal.safeParse(answer.error);
  return <Failed message={refusal.success ? text(refusal.data.code, refusal.data.params) : text('ui.unreachable')} />;
};

const Failed = ({ message }: { message: string }): ReactNode => (
  <Alert color="red" role="alert">
    {message}
  </Alert>
);
