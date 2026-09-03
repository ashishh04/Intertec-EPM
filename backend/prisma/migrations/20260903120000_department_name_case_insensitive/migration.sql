-- Department names must be unique regardless of case: "Engineering",
-- "engineering" and "ENGINEERING" are one department, not three.
--
-- Enforced in the database rather than only in the application, which could
-- previously be raced past -- two concurrent creates could both pass the
-- case-insensitive check and both be accepted, because Postgres treats the
-- three spellings as distinct values.
--
-- Written as raw SQL because Prisma's schema language cannot express an index
-- on an expression; `@@unique([name])` can only produce an index on the bare
-- column. The plain unique index is therefore dropped and replaced -- keeping
-- both would be redundant, since uniqueness of LOWER(name) already implies
-- uniqueness of name.

-- DropIndex
DROP INDEX IF EXISTS "departments_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_lower_key" ON "departments" (LOWER("name"));
