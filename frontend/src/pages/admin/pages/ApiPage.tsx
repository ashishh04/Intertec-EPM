import { Link } from 'react-router-dom';
import { ArrowRight, Lock } from 'lucide-react';
import { FactList } from '@/components/common/FactList';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { env } from '@/config/env';
import { t } from '@/lib/i18n';

/**
 * The API in play: EPM's own backend. What sits behind it is not named — its
 * version is nothing an EPM administrator acts on.
 */
export default function ApiPage() {
  return (
    <Card>
      <CardHeader variant="compact">
        <CardTitle>{t('API')}</CardTitle>
        <CardDescription>{t('How EPM talks to its backend.')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <FactList
          facts={[
            {
              label: t('EPM API base URL'),
              value: (
                <span className="block truncate" title={env.apiBaseUrl}>
                  {env.apiBaseUrl}
                </span>
              ),
            },
          ]}
        />

        <Alert tone="danger" icon={Lock}>
          {t('API tokens are never exposed to the frontend and cannot be viewed or rotated from this interface. The frontend never receives an upstream URL or token.')}
        </Alert>

        <Button asChild variant="secondary" size="sm">
          <Link to="/settings/integration">
            {t('Open integration status')}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
