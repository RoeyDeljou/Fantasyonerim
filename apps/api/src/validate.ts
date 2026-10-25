import type { z } from 'zod';

/** Request input: a ZodError thrown here becomes a 400 `bad_request` in the error handler. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  return schema.parse(value);
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
export function serialize<S extends z.ZodType>(schema: S, value: unknown, what = 'response'): z.output<S> {
  const result = schema.safeParse(value);
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
