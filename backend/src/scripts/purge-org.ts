import { prisma } from '../db/prisma.js';

// Order matters: user_profiles reference departments and teams with RESTRICT,
// and teams reference departments the same way. Clear the mappings first.
const cleared = await prisma.userProfile.updateMany({ data: { departmentId: null, teamId: null } });
const teams = await prisma.team.deleteMany({});
const departments = await prisma.department.deleteMany({});
console.log(`  cleared ${cleared.count} mappings, removed ${teams.count} teams, ${departments.count} departments`);
console.log(
  `  remaining: ${await prisma.team.count()} teams, ${await prisma.department.count()} departments,` +
    ` ${await prisma.userProfile.count()} profiles`,
);
await prisma.$disconnect();
