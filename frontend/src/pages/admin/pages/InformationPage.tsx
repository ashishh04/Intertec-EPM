import { FactList } from '@/components/common/FactList';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { APP_NAME, env } from '@/config/env';
import { t } from '@/lib/i18n';

/**
 * Information: what this installation of EPM is and where it runs.
 *
 * The system EPM reads its projects and people from is deliberately not
 * described — its name, version and host are not something an EPM
 * administrator acts on, and it is never shown to anyone.
 */
export default function InformationPage() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          variant="compact"
          actions={
            <Badge tone="highlight" size="sm" className="capitalize">
              {env.appEnv}
            </Badge>
          }
        >
          <CardTitle>{APP_NAME}</CardTitle>
          <CardDescription>{t('This application and the backend it talks to.')}</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <FactList
            facts={[
              { label: t('App name'), value: APP_NAME, mono: false },
              { label: t('Environment'), value: env.appEnv },
              {
                label: t('API base URL'),
                value: (
                  <span className="block truncate" title={env.apiBaseUrl}>
                    {env.apiBaseUrl}
                  </span>
                ),
              },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
