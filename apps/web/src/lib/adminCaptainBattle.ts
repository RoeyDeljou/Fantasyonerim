'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CaptainBattleConfigSchema } from '@fant/shared';
import type { CaptainBattleConfig } from '@fant/shared';
import { nullable, request } from './api';
import { qk } from './queries';

/** The admin Captain Battle editor's data. Admin-only, so it stays out of the main bundle (see seasonCaptains.ts). */
export function useAdminCaptainBattle(enabled: boolean) {
  return useQuery({
    queryKey: qk.adminCaptainBattle,
    queryFn: ({ signal }) =>
      request('GET', '/v1/admin/captain-battle', nullable(CaptainBattleConfigSchema), { signal }),
    enabled,
  });
}

export function useSaveAdminCaptainBattle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CaptainBattleConfig) =>
      request('PUT', '/v1/admin/captain-battle', CaptainBattleConfigSchema, { body }),
    onSuccess: (c) => {
      qc.setQueryData(qk.adminCaptainBattle, c);
      void qc.invalidateQueries({ queryKey: qk.captainBattle });
      void qc.invalidateQueries({ queryKey: qk.config });
    },
  });
}
