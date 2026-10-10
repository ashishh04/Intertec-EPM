import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDepartments } from '@/hooks/useDepartments';
import { usePortfolios } from '@/hooks/usePortfolios';
import { useProjects } from '@/hooks/useProjects';
import { useResourceRoles } from '@/hooks/useResources';
import { useTeams } from '@/hooks/useTeams';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

/**
 * Instance, a portfolio, a project, a department, a team or a role; a person
 * only as drilled into. The value is the scope string the dashboards and scheduled
 * reports carry: `instance`, `portfolio:<id>`, `project:<id>`, …
 */
export function ScopePicker({
  id,
  scope,
  personName,
  onChange,
  triggerClassName = 'h-8 text-xs',
}: {
  id: string;
  scope: string;
  personName?: string;
  onChange: (value: string) => void;
  triggerClassName?: string;
}) {
  const portfolios = usePortfolios();
  const projects = useProjects();
  const departments = useDepartments();
  const teams = useTeams();
  const roles = useResourceRoles();

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t('Scope')}</Label>
      <Select value={scope} onValueChange={onChange}>
        <SelectTrigger id={id} className={cn(triggerClassName)}>
          <SelectValue placeholder={t('All projects')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="instance">{t('All projects')}</SelectItem>
          {scope.startsWith('person:') ? (
            <SelectItem value={scope}>{personName ?? t('This person')}</SelectItem>
          ) : null}
          {(portfolios.data ?? []).length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{t('Portfolios')}</SelectLabel>
                {(portfolios.data ?? []).map((portfolio) => (
                  <SelectItem key={portfolio.id} value={`portfolio:${portfolio.id}`}>
                    {portfolio.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
          {(projects.data ?? []).length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{t('Projects')}</SelectLabel>
                {(projects.data ?? []).map((project) => (
                  <SelectItem key={project.id} value={`project:${project.id}`}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
          {(departments.data ?? []).length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{t('Departments')}</SelectLabel>
                {(departments.data ?? []).map((department) => (
                  <SelectItem key={department.id} value={`department:${department.id}`}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
          {(teams.data ?? []).length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{t('Teams')}</SelectLabel>
                {(teams.data ?? []).map((team) => (
                  <SelectItem key={team.id} value={`team:${team.id}`}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
          {(roles.data ?? []).length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{t('Roles')}</SelectLabel>
                {(roles.data ?? []).map((role) => (
                  <SelectItem key={role.id} value={`role:${role.id}`}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  );
}
