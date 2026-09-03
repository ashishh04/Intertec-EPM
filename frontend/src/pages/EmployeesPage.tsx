import { useState } from 'react';
import { Search, UserRound, Users } from 'lucide-react';

import { EmptyState } from '@/components/common/EmptyState';
import { MappingDialog } from '@/components/employees/MappingDialog';
import { PageHeader } from '@/components/common/PageHeader';
import { QueryBoundary } from '@/components/common/QueryBoundary';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDebounce } from '@/hooks/useDebounce';
import { useDepartments } from '@/hooks/useDepartments';
import { useEmployees } from '@/hooks/useEmployees';
import { useTeams } from '@/hooks/useTeams';
import { useUserMap } from '@/hooks/useUsers';
import { useAuth } from '@/providers/AuthProvider';
import type { EpmEmployee } from '@/services/api/employees';

/**
 * People, and where they sit.
 *
 * Not an employee directory in the HR sense: nobody is created, removed or
 * renamed here. Identity belongs to OpenProject, and the only thing this page
 * writes is the mapping onto EPM's departments and teams.
 *
 * Everyone who is signed in can read it. Assigning needs `employees:manage`,
 * which the backend checks on every write regardless of what is rendered.
 */

const ALL = '__all__';

export default function EmployeesPage() {
  const { can } = useAuth();
  const mayManage = can('employees:manage');

  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState(ALL);
  const [teamId, setTeamId] = useState(ALL);

  // Typing should not fire a request per keystroke.
  const q = useDebounce(search, 250);

  const employees = useEmployees({
    q: q || undefined,
    departmentId: departmentId === ALL ? undefined : departmentId,
    teamId: teamId === ALL ? undefined : teamId,
  });
  const departments = useDepartments();
  const teams = useTeams();
  const users = useUserMap();

  const [editing, setEditing] = useState<EpmEmployee>();
  const [dialogOpen, setDialogOpen] = useState(false);

  const openEdit = (employee: EpmEmployee) => {
    setEditing(employee);
    setDialogOpen(true);
  };

  const items = employees.data ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Employees"
        description="Where each person sits in the organisation."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={search}
                placeholder="Search people"
                aria-label="Search employees"
                className="w-52 pl-8"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>

            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger className="w-48" aria-label="Filter by department">
                <SelectValue placeholder="All departments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All departments</SelectItem>
                {(departments.data ?? []).map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={teamId} onValueChange={setTeamId}>
              <SelectTrigger className="w-44" aria-label="Filter by team">
                <SelectValue placeholder="All teams" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All teams</SelectItem>
                {(teams.data ?? []).map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      <QueryBoundary
        isLoading={employees.isLoading}
        isError={employees.isError}
        onRetry={() => employees.refetch()}
        errorTitle="Unable to load employees"
        skeleton={
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        }
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={UserRound}
            title={q || departmentId !== ALL || teamId !== ALL ? 'Nobody matches' : 'No people'}
            description={
              q || departmentId !== ALL || teamId !== ALL
                ? 'Try a different search or filter.'
                : 'People appear here once they exist in OpenProject.'
            }
          />
        }
      >
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Team</TableHead>
                  {mayManage ? <TableHead className="w-24" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((employee) => (
                  <TableRow key={employee.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {/* The name comes from the backend; the directory is
                            only consulted for the avatar. */}
                        <UserAvatar user={users.get(employee.id)} size="xs" />
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium">{employee.name}</p>
                          {employee.email ? (
                            <p className="truncate text-2xs text-muted-foreground">
                              {employee.email}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>

                    <TableCell className="text-2xs">
                      {employee.department ? (
                        <span className="flex items-center gap-1.5">
                          {employee.department.name}
                          {/* A mapping outlives its department's archival. */}
                          {employee.department.active ? null : (
                            <Badge tone="warning" className="text-2xs">
                              Archived
                            </Badge>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Unassigned</span>
                      )}
                    </TableCell>

                    <TableCell className="text-2xs">
                      {employee.team ? (
                        <span className="flex items-center gap-1.5">
                          <Users className="h-3 w-3 text-muted-foreground" aria-hidden />
                          {employee.team.name}
                          {employee.team.active ? null : (
                            <Badge tone="warning" className="text-2xs">
                              Archived
                            </Badge>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Unassigned</span>
                      )}
                    </TableCell>

                    {mayManage ? (
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Assign ${employee.name}`}
                          onClick={() => openEdit(employee)}
                        >
                          Assign
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      </QueryBoundary>

      <MappingDialog open={dialogOpen} onOpenChange={setDialogOpen} employee={editing} />
    </div>
  );
}
