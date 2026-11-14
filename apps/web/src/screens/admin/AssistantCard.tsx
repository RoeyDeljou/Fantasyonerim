'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { DEFAULT_ASSISTANT_CONFIG } from '@fant/shared';
import type { AdminSettings, AssistantConfig, AssistantVisibility } from '@fant/shared';
import { draftOf, parseAssistantDraft } from '@/lib/assistant/draft';
import type { AssistantDraft, AssistantField } from '@/lib/assistant/draft';
import { useI18n } from '@/i18n';
import { useSection } from '@/i18n/section';
import { adminAssistant } from '@/i18n/sections/adminAssistant';
import { useSaveAdminSettings } from '@/lib/queries';
import { Collapsible, saveProblem } from '@/components/Collapsible';
import { CheckIcon, ChatIcon, EyeIcon } from '@/components/icons';
import { Button, InlineError, Segmented, Spinner, TextField, cx, errorMessage } from '@/components/ui';
import { AlfiePanel } from '@/components/assistant/AlfiePanel';
import { useAlfie } from '@/components/assistant/useAlfie';

const VISIBILITIES: readonly AssistantVisibility[] = ['off', 'admins', 'everyone'];

/**
 * Admin → Settings → "Ask Alfie (FPL Lad)": who sees the launcher, FPL Lad's script URL (empty until they deliver
 * it — then the launcher opens our in-app panel), the partner id and the fallback site. Saves like the other
 * settings cards: the server's current settings with only `assistant` replaced. "Preview" opens Alfie right here
 * with the values in the form (saved or not).
 */
export function AssistantCard({ server }: { server: AdminSettings }) {
  const { t } = useI18n();
  const s = useSection(adminAssistant);
  const save = useSaveAdminSettings();
  const saved = server.assistant ?? DEFAULT_ASSISTANT_CONFIG;
  const [draft, setDraft] = useState<AssistantDraft>(() => draftOf(saved));
  const [errors, setErrors] = useState<Partial<Record<AssistantField, true>>>({});
  const [flash, setFlash] = useState(false);
  const [preview, setPreview] = useState<AssistantConfig>(saved);

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(false), 3000);
    return () => window.clearTimeout(id);
  }, [flash]);

  const alfie = useAlfie(preview);
  // "Preview" swaps the form's config in, then opens Alfie with it on the next render.
  const openAlfie = useRef(alfie.open);
  openAlfie.current = alfie.open;
  const [previewWanted, setPreviewWanted] = useState(0);
  useEffect(() => {
    if (previewWanted > 0) void openAlfie.current();
  }, [previewWanted]);

  const set = (k: AssistantField, v: string) => {
    setDraft({ ...draft, [k]: v });
    setErrors({ ...errors, [k]: undefined });
  };

  function validated(): AssistantConfig | null {
    const r = parseAssistantDraft(draft);
    if (!r.ok) {
      setErrors(r.errors);
      return null;
    }
    setErrors({});
    return r.config;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const assistant = validated();
    if (!assistant) return;
    save.mutate({ ...server, assistant }, { onSuccess: () => setFlash(true) });
  }

  function runPreview() {
    const config = validated();
    if (!config) return;
    setPreview(config);
    setPreviewWanted((n) => n + 1);
  }

  const help = { off: s.offHelp, admins: s.adminsHelp, everyone: s.everyoneHelp };
  return (
    <>
      <form onSubmit={submit} noValidate data-testid="alfie-admin">
        <Collapsible
          id="settings.assistant"
          icon={<ChatIcon size={18} />}
          title={s.title}
          tone={
            saved.visibility === 'everyone'
              ? 'success'
              : saved.visibility === 'admins'
                ? 'primary'
                : 'neutral'
          }
          summary={s[saved.visibility]}
          info={s.info}
          saveError={saveProblem(t, save)}
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink">{s.visibility}</span>
            <Segmented
              label={s.visibility}
              value={draft.visibility}
              options={VISIBILITIES.map((v) => ({ value: v, label: s[v] }))}
              onChange={(visibility) => setDraft({ ...draft, visibility })}
            />
            <ul className="flex flex-col gap-0.5 text-sm" data-testid="alfie-visibility-help">
              {VISIBILITIES.map((v) => (
                <li key={v} className={cx(v === draft.visibility ? 'font-semibold text-ink' : 'text-muted')}>
                  {s[v]}: {help[v]}
                </li>
              ))}
            </ul>
          </div>
          <p
            className={cx(
              'rounded-xl px-3 py-2 text-sm font-medium',
              saved.scriptUrl ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning',
            )}
            data-testid="alfie-status"
          >
            {saved.scriptUrl ? s.connected : s.waiting}
          </p>
          <TextField
            label={s.scriptUrl}
            hint={s.scriptHint}
            type="url"
            inputMode="url"
            dir="ltr"
            placeholder="https://www.fpl-lad.com/embed.js"
            value={draft.scriptUrl}
            error={errors.scriptUrl ? s.scriptInvalid : null}
            onChange={(e) => set('scriptUrl', e.target.value)}
            data-testid="alfie-script-url"
          />
          <TextField
            label={s.partnerId}
            hint={s.partnerHint}
            dir="ltr"
            autoComplete="off"
            value={draft.partnerId}
            error={errors.partnerId ? s.partnerInvalid : null}
            onChange={(e) => set('partnerId', e.target.value)}
            data-testid="alfie-partner-id"
          />
          <TextField
            label={s.fallbackUrl}
            hint={s.fallbackHint}
            type="url"
            inputMode="url"
            dir="ltr"
            placeholder="https://"
            value={draft.fallbackUrl}
            error={errors.fallbackUrl ? s.fallbackInvalid : null}
            onChange={(e) => set('fallbackUrl', e.target.value)}
            data-testid="alfie-fallback-url"
          />
          {save.isError && <InlineError>{errorMessage(t, save.error)}</InlineError>}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button type="submit" disabled={save.isPending} data-testid="alfie-save">
              {save.isPending && <Spinner />}
              {s.save}
            </Button>
            <Button
              variant="secondary"
              onClick={runPreview}
              disabled={alfie.busy}
              aria-haspopup="dialog"
              data-testid="alfie-preview"
            >
              {alfie.busy ? <Spinner /> : <EyeIcon size={18} />}
              {s.preview}
            </Button>
            {flash && (
              <span role="status" className="flex items-center gap-1 text-sm font-semibold text-success">
                <CheckIcon size={16} />
                {t.common.saved}
              </span>
            )}
          </div>
        </Collapsible>
      </form>
      <AlfiePanel
        open={alfie.panelOpen}
        onClose={alfie.closePanel}
        fallbackUrl={preview.fallbackUrl}
        ctx={alfie.ctx}
      />
    </>
  );
}
