import { PrismaClient } from '@prisma/client';

/**
 * EPM-owned overlay storage.
 *
 * Everything the UI needs comes from OpenProject; this database only adds the
 * attributes OpenProject has no column for. That makes it genuinely optional —
 * if Postgres is not running the app still serves live OpenProject data, just
 * without portfolio, department or budget overlays. `optional()` exists so a
 * missing database degrades one field rather than failing a whole page.
 */

export const prisma = new PrismaClient();

let warned = false;

export async function optional<T>(query: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await query();
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(
        'Overlay database unavailable — serving OpenProject data without EPM overlays. ' +
          'Start it with: npm run db:up',
      );
    }
    return fallback;
  }
}

export async function disconnectPrisma() {
  await prisma.$disconnect().catch(() => undefined);
}
