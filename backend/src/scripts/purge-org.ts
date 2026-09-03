import { prisma } from '../db/prisma.js';

// Teams first: the foreign key is RESTRICT, so a department holding teams
// cannot be removed until they are.
const teams = await prisma.team.deleteMany({});
const departments = await prisma.department.deleteMany({});
console.log(`  removed ${teams.count} teams, ${departments.count} departments`);
console.log(`  remaining: ${await prisma.team.count()} teams, ${await prisma.department.count()} departments`);
await prisma.$disconnect();
