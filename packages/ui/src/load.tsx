import type { Refusal } from '@cedarloom/core';
import { Alert, Loader } from '@mantine/core';
import { type ReactNode, useEffect, useState } from 'react';
import { text } from './message.ts';

type Answer<T> = { data: T; error?: never } | { data?: never; error: Refusal };

/** The answer of `request`, sent once when it mounts: a loader until it arrives, then its data or its refusal. */
export const Load = <T,>({
  request,
  children,
}: {
  request: () => Promise<Answer<T>>;
  children: (data: T) => ReactNode;
}): ReactNode => {
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  // Sent once: a parent remounts it with a key to ask again.
  useEffect(() => {
    let mounted = true;
    void request().then((received) => {
      if (mounted) setAnswer(received);
    });
    return () => {
      mounted = false;
    };
  }, []);
  if (answer === null) return <Loader role="status" aria-label={text('ui.loading')} />;
  if (answer.error !== undefined) return <Refused refusal={answer.error} />;
  return children(answer.data);
};

/** A refusal of the server as its message. */
export const Refused = ({ refusal }: { refusal: Refusal }): ReactNode => (
  <Alert color="red" role="alert">
    {text(refusal.code, refusal.params)}
  </Alert>
);
