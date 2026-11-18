import { z } from 'zod';
import { MESSAGE_IDS } from './messages/catalog.ts';

/** A finding or refusal code: the id of its message in core/messages, so a code without a message is refused. */
export const Code = z.enum(MESSAGE_IDS);
export type Code = z.infer<typeof Code>;

/** A code's parameters, named as the ICU arguments of its message. */
export const Params = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
);
export type Params = z.infer<typeof Params>;

/** A result of a check that did not stop the command. */
export const Finding = z.strictObject({ code: Code, severity: z.enum(['error', 'warning', 'info']), params: Params });
export type Finding = z.infer<typeof Finding>;

/** Why a command stopped. */
export const Refusal = z.strictObject({ code: Code, params: Params });
export type Refusal = z.infer<typeof Refusal>;
