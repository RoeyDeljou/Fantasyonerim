import { EMAIL_TAKEN_MESSAGE } from '@fant/shared';
import { describe, expect, it } from 'vitest';
import { ApiRequestError, isEmailTaken } from './api';

describe('isEmailTaken (register has two different 409s)', () => {
  it('only the exact "email already used" message is an email conflict', () => {
    expect(isEmailTaken(new ApiRequestError('conflict', 409, EMAIL_TAKEN_MESSAGE))).toBe(true);
    // The Team ID conflict also mentions email — it must lead to the "already registered → sign in" step.
    const teamTaken = 'This Team ID is already registered. Sign in with your email and Team ID.';
    expect(isEmailTaken(new ApiRequestError('conflict', 409, teamTaken))).toBe(false);
    expect(isEmailTaken(new ApiRequestError('bad_request', 400, EMAIL_TAKEN_MESSAGE))).toBe(false);
  });
});
