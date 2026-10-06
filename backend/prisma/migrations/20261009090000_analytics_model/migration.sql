-- The analytics model (BRQ-05: BR-402, BR-403, BR-404).
--
-- A reporting model in its own schema, `analytics`, loaded from OpenProject
-- and from EPM's own tables by the refresh in `domain/analytics-model/`. It is
-- the interface reporting reads — EPM's dashboards and any BI tool on the read
-- replica — so the raw application tables never are, and a change to either
-- application's schema is absorbed by the loader instead of by every report.
--
-- Dimensions carry surrogate keys (`*_sk`) and, where attributes change, keep
-- every version: `valid_from`/`valid_to`/`is_current` (slowly changing, type 2).
-- Facts are the current state of every work package, every version of every
-- work package from OpenProject's journals (what reconstruction as at a past
-- date reads), time entries with their cost, and unit costs. A refresh run log
-- records each load, how long it took and how it reconciled to source.
--
-- Prisma does not manage this schema: the datasource is `public`, so these
-- objects are invisible to its diffs and are written with SQL by the loader.

CREATE SCHEMA IF NOT EXISTS analytics;
COMMENT ON SCHEMA analytics IS 'EPM reporting model. Read this, not the application tables. Loaded by the EPM backend; see docs/brd/M12-Reports-Analytics-design.md.';

-- ------------------------------------------------------------------ calendar

CREATE TABLE analytics.dim_date (
    date_key       INTEGER PRIMARY KEY,           -- 20261006
    date           DATE NOT NULL UNIQUE,
    year           SMALLINT NOT NULL,
    quarter        SMALLINT NOT NULL,
    month          SMALLINT NOT NULL,
    month_name     TEXT NOT NULL,
    iso_year       SMALLINT NOT NULL,
    iso_week       SMALLINT NOT NULL,
    iso_week_label TEXT NOT NULL,                 -- 2026-W41
    week_start     DATE NOT NULL,                 -- the Monday of the ISO week
    day_of_week    SMALLINT NOT NULL,             -- 1 Monday .. 7 Sunday
    day_name       TEXT NOT NULL,
    is_weekend     BOOLEAN NOT NULL
);

INSERT INTO analytics.dim_date
SELECT to_char(d, 'YYYYMMDD')::int,
       d::date,
       extract(year FROM d)::smallint,
       extract(quarter FROM d)::smallint,
       extract(month FROM d)::smallint,
       trim(to_char(d, 'Month')),
       extract(isoyear FROM d)::smallint,
       extract(week FROM d)::smallint,
       to_char(d, 'IYYY') || '-W' || to_char(d, 'IW'),
       (d - ((extract(isodow FROM d)::int - 1) * interval '1 day'))::date,
       extract(isodow FROM d)::smallint,
       trim(to_char(d, 'Day')),
       extract(isodow FROM d) IN (6, 7)
  FROM generate_series('2015-01-01'::date, '2040-12-31'::date, interval '1 day') AS d;

-- ------------------------------------------------------- reference (type 1)
--
-- `category` is EPM's reading of each entry (`mapping/catalog.ts`): a status
-- may be closed without the work having been delivered — Rejected is — and
-- every measure that counts completed work reads the category, not `is_closed`.
-- An entry deleted upstream is kept, because history still names it, and
-- marked `present = false`; reconciliation counts the present ones.

CREATE TABLE analytics.dim_status (
    status_id   INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    is_closed   BOOLEAN NOT NULL,
    category    TEXT NOT NULL,
    is_default  BOOLEAN NOT NULL DEFAULT false,
    position    INTEGER,
    present     BOOLEAN NOT NULL DEFAULT true,
    loaded_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE analytics.dim_type (
    type_id      INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    is_milestone BOOLEAN NOT NULL,
    category     TEXT NOT NULL,
    position     INTEGER,
    present      BOOLEAN NOT NULL DEFAULT true,
    loaded_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE analytics.dim_priority (
    priority_id INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    position    INTEGER,
    is_default  BOOLEAN NOT NULL DEFAULT false,
    present     BOOLEAN NOT NULL DEFAULT true,
    loaded_at   TIMESTAMPTZ NOT NULL
);

-- ----------------------------------------------- slowly changing (type 2)
--
-- One row per version of an entity. A refresh compares each entity's
-- attributes (`row_hash`) with its current row: unchanged, nothing happens;
-- changed, the current row is closed at the refresh and a new one opened; gone
-- upstream, the current row is closed and none opened, so its history stays.
-- An entity's first row starts when the entity was created, where that is
-- known: the model was not watching before its first load, and that is the
-- most honest start for "as first seen".

CREATE TABLE analytics.dim_project (
    project_sk         BIGSERIAL PRIMARY KEY,
    project_id         INTEGER NOT NULL,
    identifier         TEXT,
    name               TEXT NOT NULL,
    parent_project_id  INTEGER,
    active             BOOLEAN NOT NULL,
    public             BOOLEAN NOT NULL,
    portfolio_id       TEXT,
    owner_user_id      INTEGER,
    planned_start      DATE,
    planned_finish     DATE,
    budget_total       DOUBLE PRECISION,
    row_hash           TEXT NOT NULL,
    valid_from         TIMESTAMPTZ NOT NULL,
    valid_to           TIMESTAMPTZ,
    is_current         BOOLEAN NOT NULL
);
CREATE UNIQUE INDEX dim_project_current ON analytics.dim_project (project_id) WHERE is_current;
CREATE INDEX dim_project_history ON analytics.dim_project (project_id, valid_from);

CREATE TABLE analytics.dim_portfolio (
    portfolio_sk  BIGSERIAL PRIMARY KEY,
    portfolio_id  TEXT NOT NULL,
    code          TEXT,
    name          TEXT NOT NULL,
    active        BOOLEAN NOT NULL,
    row_hash      TEXT NOT NULL,
    valid_from    TIMESTAMPTZ NOT NULL,
    valid_to      TIMESTAMPTZ,
    is_current    BOOLEAN NOT NULL
);
CREATE UNIQUE INDEX dim_portfolio_current ON analytics.dim_portfolio (portfolio_id) WHERE is_current;
CREATE INDEX dim_portfolio_history ON analytics.dim_portfolio (portfolio_id, valid_from);

CREATE TABLE analytics.dim_department (
    department_sk    BIGSERIAL PRIMARY KEY,
    department_id    TEXT NOT NULL,
    code             TEXT,
    name             TEXT NOT NULL,
    manager_user_id  INTEGER,
    active           BOOLEAN NOT NULL,
    row_hash         TEXT NOT NULL,
    valid_from       TIMESTAMPTZ NOT NULL,
    valid_to         TIMESTAMPTZ,
    is_current       BOOLEAN NOT NULL
);
CREATE UNIQUE INDEX dim_department_current ON analytics.dim_department (department_id) WHERE is_current;
CREATE INDEX dim_department_history ON analytics.dim_department (department_id, valid_from);

CREATE TABLE analytics.dim_team (
    team_sk        BIGSERIAL PRIMARY KEY,
    team_id        TEXT NOT NULL,
    code           TEXT,
    name           TEXT NOT NULL,
    department_id  TEXT,
    lead_user_id   INTEGER,
    active         BOOLEAN NOT NULL,
    row_hash       TEXT NOT NULL,
    valid_from     TIMESTAMPTZ NOT NULL,
    valid_to       TIMESTAMPTZ,
    is_current     BOOLEAN NOT NULL
);
CREATE UNIQUE INDEX dim_team_current ON analytics.dim_team (team_id) WHERE is_current;
CREATE INDEX dim_team_history ON analytics.dim_team (team_id, valid_from);

-- People. No email address, login or rate: the model holds what reporting
-- needs about a person and nothing a report has no use for.
CREATE TABLE analytics.dim_user (
    user_sk                BIGSERIAL PRIMARY KEY,
    user_id                INTEGER NOT NULL,
    name                   TEXT NOT NULL,
    status                 TEXT NOT NULL,
    -- `service` for EPM's automation account: it made a rule's changes, so the
    -- journal names it, and it is nobody's capacity.
    kind                   TEXT NOT NULL,
    department_id          TEXT,
    team_id                TEXT,
    weekly_capacity_hours  DOUBLE PRECISION,
    row_hash               TEXT NOT NULL,
    valid_from             TIMESTAMPTZ NOT NULL,
    valid_to               TIMESTAMPTZ,
    is_current             BOOLEAN NOT NULL
);
CREATE UNIQUE INDEX dim_user_current ON analytics.dim_user (user_id) WHERE is_current;
CREATE INDEX dim_user_history ON analytics.dim_user (user_id, valid_from);

-- Versions, which EPM reads as sprints, with the points EPM recorded as
-- committed at the start. Type 1, and kept when deleted upstream.
CREATE TABLE analytics.dim_version (
    version_id        INTEGER PRIMARY KEY,
    project_id        INTEGER,
    name              TEXT NOT NULL,
    start_date        DATE,
    end_date          DATE,
    status            TEXT NOT NULL,
    committed_points  DOUBLE PRECISION,
    present           BOOLEAN NOT NULL DEFAULT true,
    loaded_at         TIMESTAMPTZ NOT NULL
);

-- Who is a member of which project, as of the last refresh: the people a
-- project or portfolio draws its capacity from. People only, not groups.
CREATE TABLE analytics.bridge_project_member (
    project_id  INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    roles       TEXT[] NOT NULL,
    loaded_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (project_id, user_id)
);
CREATE INDEX bridge_project_member_user ON analytics.bridge_project_member (user_id);

-- --------------------------------------------------------------------- facts

-- Every work package as it is now: an accumulating snapshot, one row each,
-- built from its latest version, with when it was created (its first version)
-- and when it last became closed (the start of the closed versions at the end
-- of its history). Estimates are its own, never rolled up from children, so a
-- sum over work packages counts each hour once.
CREATE TABLE analytics.fact_work_package (
    work_package_id         INTEGER PRIMARY KEY,
    project_id              INTEGER NOT NULL,
    project_sk              BIGINT,
    type_id                 INTEGER NOT NULL,
    status_id               INTEGER NOT NULL,
    priority_id             INTEGER,
    assignee_user_id        INTEGER,
    accountable_user_id     INTEGER,
    author_user_id          INTEGER,
    parent_id               INTEGER,
    version_id              INTEGER,
    subject                 TEXT NOT NULL,
    start_date              DATE,
    due_date                DATE,
    created_at              TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ,
    -- When it last became closed, from the journals; null while it is open.
    closed_at               TIMESTAMPTZ,
    is_closed               BOOLEAN NOT NULL,
    is_milestone            BOOLEAN NOT NULL,
    estimated_hours         DOUBLE PRECISION,
    remaining_hours         DOUBLE PRECISION,
    spent_hours             DOUBLE PRECISION NOT NULL DEFAULT 0,
    done_ratio              INTEGER,
    story_points            INTEGER,
    custom_values           JSONB,
    created_date_key        INTEGER,
    start_date_key          INTEGER,
    due_date_key            INTEGER,
    closed_date_key         INTEGER,
    loaded_at               TIMESTAMPTZ NOT NULL
);
CREATE INDEX fact_work_package_project ON analytics.fact_work_package (project_id);
CREATE INDEX fact_work_package_due ON analytics.fact_work_package (due_date) WHERE NOT is_closed;
CREATE INDEX fact_work_package_closed ON analytics.fact_work_package (closed_at);
CREATE INDEX fact_work_package_assignee ON analytics.fact_work_package (assignee_user_id);

-- Every version of every work package, from OpenProject's journals. A version
-- is current from `valid_from` until the next one starts (`valid_to`, null for
-- the latest). The state of anything as at instant T is the version whose
-- range contains T — `analytics.work_packages_as_at(T)` below.
CREATE TABLE analytics.fact_work_package_version (
    journal_id               BIGINT PRIMARY KEY,
    work_package_id          INTEGER NOT NULL,
    version                  INTEGER NOT NULL,
    valid_from               TIMESTAMPTZ NOT NULL,
    valid_to                 TIMESTAMPTZ,
    changed_at               TIMESTAMPTZ NOT NULL,
    changed_by_user_id       INTEGER,
    has_notes                BOOLEAN NOT NULL DEFAULT false,
    project_id               INTEGER NOT NULL,
    type_id                  INTEGER NOT NULL,
    status_id                INTEGER NOT NULL,
    is_closed                BOOLEAN,
    priority_id              INTEGER,
    assignee_user_id         INTEGER,
    accountable_user_id      INTEGER,
    author_user_id           INTEGER,
    parent_id                INTEGER,
    version_id               INTEGER,
    category_id              INTEGER,
    subject                  TEXT,
    start_date               DATE,
    due_date                 DATE,
    duration                 INTEGER,
    done_ratio               INTEGER,
    derived_done_ratio       INTEGER,
    estimated_hours          DOUBLE PRECISION,
    derived_estimated_hours  DOUBLE PRECISION,
    remaining_hours          DOUBLE PRECISION,
    story_points             INTEGER,
    schedule_manually        BOOLEAN,
    custom_values            JSONB,
    loaded_at                TIMESTAMPTZ NOT NULL,
    UNIQUE (work_package_id, version)
);
CREATE INDEX fact_work_package_version_period ON analytics.fact_work_package_version (valid_from, valid_to);
CREATE INDEX fact_work_package_version_project ON analytics.fact_work_package_version (project_id);

-- Time logged, with its labour cost at the person's hourly rate (null where
-- the person has no rate: not costed, rather than free).
CREATE TABLE analytics.fact_time_entry (
    time_entry_id    INTEGER PRIMARY KEY,
    spent_on         DATE NOT NULL,
    spent_date_key   INTEGER NOT NULL,
    user_id          INTEGER,
    project_id       INTEGER,
    work_package_id  INTEGER,
    activity_id      INTEGER,
    activity_name    TEXT,
    hours            DOUBLE PRECISION NOT NULL,
    cost             DOUBLE PRECISION,
    created_at       TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ,
    loaded_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX fact_time_entry_spent ON analytics.fact_time_entry (spent_on);
CREATE INDEX fact_time_entry_project ON analytics.fact_time_entry (project_id);
CREATE INDEX fact_time_entry_user ON analytics.fact_time_entry (user_id);

-- Unit costs logged in OpenProject's Costs module (materials, travel...).
CREATE TABLE analytics.fact_cost_entry (
    cost_entry_id    INTEGER PRIMARY KEY,
    spent_on         DATE NOT NULL,
    spent_date_key   INTEGER NOT NULL,
    user_id          INTEGER,
    project_id       INTEGER NOT NULL,
    work_package_id  INTEGER,
    cost_type_id     INTEGER,
    cost_type_name   TEXT,
    unit             TEXT,
    units            DOUBLE PRECISION,
    amount           DOUBLE PRECISION,
    created_at       TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ,
    loaded_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX fact_cost_entry_project ON analytics.fact_cost_entry (project_id);

-- --------------------------------------------- independent capture (BR-403)
--
-- The state of every work package as API v3 reported it at a moment, taken
-- without reference to the journals. Reconstruction from the journals is
-- checked against it: the two are independent routes to the same answer.

CREATE TABLE analytics.snapshot_capture (
    capture_id      BIGSERIAL PRIMARY KEY,
    captured_at     TIMESTAMPTZ NOT NULL,
    trigger         TEXT NOT NULL,
    work_packages   INTEGER NOT NULL
);
CREATE INDEX snapshot_capture_at ON analytics.snapshot_capture (captured_at);

CREATE TABLE analytics.snapshot_work_package (
    capture_id           BIGINT NOT NULL REFERENCES analytics.snapshot_capture (capture_id) ON DELETE CASCADE,
    work_package_id      INTEGER NOT NULL,
    -- When this row's page was read, which is the instant it was true.
    read_at              TIMESTAMPTZ NOT NULL,
    lock_version         INTEGER,
    project_id           INTEGER NOT NULL,
    type_id              INTEGER NOT NULL,
    status_id            INTEGER NOT NULL,
    priority_id          INTEGER,
    assignee_user_id     INTEGER,
    accountable_user_id  INTEGER,
    parent_id            INTEGER,
    version_id           INTEGER,
    subject              TEXT,
    start_date           DATE,
    due_date             DATE,
    done_ratio           INTEGER,
    estimated_hours      DOUBLE PRECISION,
    PRIMARY KEY (capture_id, work_package_id)
);

-- ------------------------------------------------------ semantic layer (BR-404)
--
-- The governed catalogue: every measure EPM reports, defined once in code
-- (`domain/semantic/measures.ts`) and written here at startup, so a BI tool
-- reads the same definition a dashboard computes. Daily values are computed
-- by those same definitions and stored, so a BI tool can chart a measure
-- without re-implementing it.

CREATE TABLE analytics.measure_definition (
    measure_id   TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    unit         TEXT NOT NULL,
    definition   TEXT NOT NULL,
    grain        TEXT NOT NULL,
    version      INTEGER NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE analytics.fact_measure_daily (
    measure_id   TEXT NOT NULL,
    scope_type   TEXT NOT NULL,
    scope_id     TEXT NOT NULL,
    date_key     INTEGER NOT NULL,
    value        DOUBLE PRECISION,
    computed_at  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (measure_id, scope_type, scope_id, date_key)
);

-- ----------------------------------------------------------------- refreshes

CREATE TABLE analytics.refresh_run (
    run_id          BIGSERIAL PRIMARY KEY,
    kind            TEXT NOT NULL,                 -- full | incremental
    trigger         TEXT NOT NULL,                 -- schedule | manual | change
    started_at      TIMESTAMPTZ NOT NULL,
    finished_at     TIMESTAMPTZ,
    status          TEXT NOT NULL,                 -- running | succeeded | failed
    duration_ms     INTEGER,
    -- The agreed window a full refresh must finish within, and whether it did.
    window_ms       INTEGER,
    within_window   BOOLEAN,
    rows            JSONB,
    reconciliation  JSONB,
    reconciled      BOOLEAN,
    error           TEXT,
    holder          TEXT
);
CREATE INDEX refresh_run_started ON analytics.refresh_run (started_at DESC);

-- Watermarks the incremental refresh resumes from.
CREATE TABLE analytics.refresh_state (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL
);

-- ------------------------------------------------- reconstruction (BR-403)

-- Every work package as it stood at `at`: the version whose period contains
-- it. Work packages created after `at` are absent, as they should be.
CREATE FUNCTION analytics.work_packages_as_at(at TIMESTAMPTZ)
RETURNS SETOF analytics.fact_work_package_version
LANGUAGE sql STABLE AS $$
    SELECT v.*
      FROM analytics.fact_work_package_version v
     WHERE v.valid_from <= at
       AND (v.valid_to IS NULL OR v.valid_to > at)
$$;
COMMENT ON FUNCTION analytics.work_packages_as_at(TIMESTAMPTZ) IS 'Each work package as it stood at the given instant, from OpenProject''s journals (BR-403).';
