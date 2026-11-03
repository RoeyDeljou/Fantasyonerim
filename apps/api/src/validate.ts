import { z } from 'zod';

// English issue messages for every schema, the zod/mini contract included: mini loads no locale by itself, so
// without this a 400 would only say "Invalid input".
z.config(z.locales.en());

/** Any Zod 4 schema: the @fant/shared contract (zod/mini) or a local one (classic). */
type Schema = z.core.$ZodType;

/** Request input: a ZodError thrown here becomes a 400 `bad_request` in the error handler. */
export function parseInput<S extends Schema>(schema: S, value: unknown): z.output<S> {
  return z.parse(schema, value);
}

export class ContractViolationError extends Error {
  constructor(
    readonly issues: z.core.$ZodIssue[],
    what: string,
  ) {
    super(`Response failed contract validation (${what})`);
    this.name = 'ContractViolationError';
  }
}

/** Response output: our own data failing the shared schema is a server bug (500), never a 400. */
export function serialize<S extends Schema>(schema: S, value: unknown, what = 'response'): z.output<S> {
  const result = z.safeParse(schema, value);
  if (!result.success) throw new ContractViolationError(result.error.issues, what);
  return result.data;
}

export function formatZodIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
