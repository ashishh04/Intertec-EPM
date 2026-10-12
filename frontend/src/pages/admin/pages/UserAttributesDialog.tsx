import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

import { SchemaForm } from '@/components/common/SchemaForm';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSchemaForm } from '@/hooks/useSchemaForm';
import { t } from '@/lib/i18n';
import { adminService } from '@/services';
import { writableFields } from '@/services/api/forms';
import type { EpmAccount } from '@/types';
import { describeError } from './shared-format';

/**
 * One person's user attributes — the fields Administration → User attributes
 * defines — read and written through the instance's own user form, so the
 * choices, the required ones and the validation are the instance's.
 *
 * Only attributes are ever sent: the backend drops anything else, so this
 * cannot touch a login, an email or administrator rights.
 */
export function UserAttributesDialog({
  account,
  onOpenChange,
}: {
  /** The person whose attributes are open; none closes the dialog. */
  account?: EpmAccount;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={Boolean(account)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Keyed by person, so one person's unsaved values never carry over
            to the next one opened. */}
        {account ? <AttributesForm key={account.id} account={account} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AttributesForm({ account, onDone }: { account: EpmAccount; onDone: () => void }) {
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    (payload: Record<string, unknown>) => adminService.userAttributesForm(account.id, payload),
    [account.id],
  );
  const form = useSchemaForm(load);

  const fieldCount = useMemo(() => (form.form ? writableFields(form.form.schema).length : 0), [form.form]);
  const loaded = Boolean(form.form);

  const save = async () => {
    setSaving(true);
    try {
      await adminService.updateUserAttributes(account.id, form.draft);
      // The person's profile shows these values.
      void client.invalidateQueries({ queryKey: ['admin', 'users', account.id, 'attributes'] });
      toast.success(t('Attributes saved'), { description: account.name });
      onDone();
    } catch (error) {
      toast.error(t('The attributes were not saved'), { description: describeError(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('Attributes of {name}', { name: account.name })}</DialogTitle>
        <DialogDescription>
          {t('The user attributes defined for everyone, with this person’s values.')}
        </DialogDescription>
      </DialogHeader>

      <div className="epm-dialog-body epm-scroll -me-1 space-y-4 py-1 pe-2">
        {loaded && fieldCount === 0 ? (
          <Alert tone="neutral" title={t('No user attributes yet')}>
            <p>{t('Attributes are defined for everyone at once, and then filled in for each person here.')}</p>
            <Link
              to="/admin/users/user-attributes"
              className="mt-1 inline-block font-medium text-primary underline-offset-4 hover:underline"
              onClick={onDone}
            >
              {t('Define user attributes')}
            </Link>
          </Alert>
        ) : (
          <SchemaForm
            form={form.form}
            values={form.draft}
            errors={form.errors}
            onChange={form.setValue}
            isLoading={form.isLoading}
          />
        )}

        {form.error ? <Alert tone="danger">{describeError(form.error)}</Alert> : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={saving}>
          {t('Cancel')}
        </Button>
        {fieldCount > 0 ? (
          <Button onClick={save} loading={saving} disabled={!form.canSubmit || saving}>
            {t('Save changes')}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
