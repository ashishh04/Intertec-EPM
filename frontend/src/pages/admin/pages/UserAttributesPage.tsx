import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { t } from '@/lib/i18n';
import { CatalogPage } from './CatalogPage';

/**
 * User attributes: what is known about each person beyond their account.
 *
 * The built-in ones are on every profile and cannot be removed. The rest are
 * defined here for everyone at once — a job title, a skill, a cost centre —
 * and filled in per person from the Users list (Attributes). They are the
 * instance's user custom fields, served as a catalogue like types and
 * statuses, so the table and the form come from the instance's descriptor.
 */

interface BuiltIn {
  label: string;
  description: string;
}

const BUILT_IN: BuiltIn[] = [
  {
    get label() { return t('Username'); },
    get description() { return t('What the person signs in with.'); },
  },
  {
    get label() { return t('First name'); },
    get description() { return t('Shown wherever the person is named.'); },
  },
  {
    get label() { return t('Last name'); },
    get description() { return t('Shown wherever the person is named.'); },
  },
  {
    get label() { return t('Email'); },
    get description() { return t('Where invitations and notifications go. It can also be used to sign in.'); },
  },
  {
    get label() { return t('Language'); },
    get description() { return t('The language EPM is shown in for them.'); },
  },
  {
    get label() { return t('Department'); },
    get description() { return t('Where they sit in the organisation, set under Organization.'); },
  },
];

export default function UserAttributesPage() {
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader variant="compact">
          <CardTitle>{t('Built-in attributes')}</CardTitle>
          <CardDescription>
            {t('On every profile, and cannot be removed. Add your own below, then fill them in for each person from the Users list.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {BUILT_IN.map((attribute) => (
              <li key={attribute.label} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground">{attribute.label}</p>
                  <p className="text-2xs text-muted-foreground">{attribute.description}</p>
                </div>
                <Badge tone="neutral" size="sm" className="shrink-0">
                  {t('Built-in')}
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <section className="space-y-3" aria-labelledby="custom-user-attributes">
        <div>
          <h2 id="custom-user-attributes" className="text-sm font-semibold tracking-tight">
            {t('Custom attributes')}
          </h2>
          <p className="text-2xs text-muted-foreground">
            {t('Defined here for everyone at once. A list holds the choices people pick from; a required attribute must be filled in for everyone.')}
          </p>
        </div>
        <CatalogPage resource="user-attributes" />
      </section>
    </div>
  );
}
