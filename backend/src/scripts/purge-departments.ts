import { prisma } from '../db/prisma.js';

const before = await prisma.department.count();
const { count } = await prisma.department.deleteMany({});
console.log(`  departments: ${before} -> ${before - count} (removed ${count})`);
console.log('  permission grant rows:', await prisma.epmPermissionGrant.count());
await prisma.$disconnect();
