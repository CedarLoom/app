import { type Code, type CompiledMessage, messageText, type Params } from '@cedarloom/core';
import core from '@cedarloom/core/messages/en.json' with { type: 'json' };
import type { MessagePlaceholders } from './messages/catalog.ts';
import own from './messages/en.json' with { type: 'json' };

const catalog: Readonly<Record<string, CompiledMessage>> = { ...core.messages, ...own.messages };

/** The English text of a code of core/messages or a message of the cli catalog, with its parameters filled in. */
export const message = (id: Code | keyof MessagePlaceholders, params: Params = {}): string =>
  messageText(catalog, id, params);
