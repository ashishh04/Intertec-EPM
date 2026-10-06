# EPM: a read-only export of work package history, for EPM's analytics model.
#
# OpenProject keeps every version of every work package — the journal behind
# each work package's Activity tab — but API v3 offers no way to read it in
# bulk: per work package, as rendered sentences ("Status changed from New to
# In progress"), which is a view and not data. EPM's analytics model rebuilds
# the state of the portfolio as at any past date from these versions (BR-403),
# so it needs them as rows. This file adds that, and nothing else:
#
#   GET /epm_admin/analytics/journals          work package versions, oldest change first
#   GET /epm_admin/analytics/journals/summary  counts for reconciliation, and every work package id
#   GET /epm_admin/analytics/cost_entries      unit costs logged against work packages (Costs module)
#
# Cost entries are here for the same reason: API v3 has no collection for them
# on 15.5.1 (`/api/v3/cost_entries` is a 404), and the model is asked to hold
# every kind of actual cost — labour comes from time entries, which API v3 does
# list, and anything else logged in the Costs module comes from here.
#
# Read-only. It runs SELECTs and writes nothing, so it cannot change what
# OpenProject records or shows. It reads the journal tables directly rather
# than through a model because a bulk read is the whole point: one query per
# page, built as JSON by Postgres, instead of a model per row.
#
# What a version is, exactly
# --------------------------
# One row per `journals` row of a work package, with that version's attributes
# from `work_package_journals` and its custom values from
# `customizable_journals`. `validFrom` is the lower bound of the journal's
# validity period — the instant OpenProject's own baseline comparison treats
# the version as current from. Changes the same person makes to the same work
# package within the journal aggregation window (Administration → System
# settings, 5 minutes by default) are merged into one version by OpenProject,
# so history resolves to that granularity and no finer.
#
# The upper bound is not exported. OpenProject closes a version's period when
# the next one is written, without touching that row's `updated_at`, so an
# incremental reader could not see the change; EPM derives the end of each
# version from the start of the next, which is the same instant.
#
# Paging is by (updated_at, id), not by id: a version merged by aggregation is
# rewritten in place with a later `updated_at`, and reading by id alone would
# never see it again. The cursor is opaque — pass back what `next` returned.
# Timestamps carry microseconds, because the cursor compares them exactly.
#
# Admin only, identified exactly as API v3 identifies a caller. Everything it
# reads is OpenProject's internal schema, which has no compatibility guarantee;
# after an upgrade, verify the two endpoints still answer — see README.md.

Rails.application.config.to_prepare do
  next if defined?(EpmAnalyticsController)

  class EpmAnalyticsController < ActionController::API
    DEFAULT_LIMIT = 1000
    MAX_LIMIT = 5000

    TIMESTAMP = %q{'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'}

    around_action :authenticate!

    rescue_from StandardError do |error|
      Rails.logger.error("[epm_analytics] #{error.class}: #{error.message}\n#{error.backtrace&.first(10)&.join("\n")}")
      render json: { message: error.message }, status: :internal_server_error
    end

    # Work package versions changed after the cursor, oldest change first.
    def journals
      limit = params[:limit].present? ? params[:limit].to_i : DEFAULT_LIMIT
      unless (1..MAX_LIMIT).cover?(limit)
        return render json: { message: "limit must be between 1 and #{MAX_LIMIT}." }, status: :unprocessable_entity
      end

      since, after = parse_cursor(params[:cursor])
      return if performed?

      row = ActiveRecord::Base.connection.select_one(page_sql(since, after, limit))
      rows = row["rows"] || "[]"
      count = row["count"].to_i
      last = row["last_cursor"]

      # Built as text by Postgres and passed through untouched: parsing it here
      # only to serialise it again would cost a model per row for nothing.
      body = %({"journals":#{rows},"count":#{count},"next":#{count == limit && last ? last.to_json : 'null'}})
      render json: body
    end

    # Unit costs, changed after the cursor, oldest change first. Paged like the
    # journals and for the same reason: an entry edited later moves to the end.
    def cost_entries
      limit = params[:limit].present? ? params[:limit].to_i : DEFAULT_LIMIT
      unless (1..MAX_LIMIT).cover?(limit)
        return render json: { message: "limit must be between 1 and #{MAX_LIMIT}." }, status: :unprocessable_entity
      end

      since, after = parse_cursor(params[:cursor])
      return if performed?

      row = ActiveRecord::Base.connection.select_one(cost_entries_sql(since, after, limit))
      rows = row["rows"] || "[]"
      count = row["count"].to_i
      last = row["last_cursor"]

      render json: %({"costEntries":#{rows},"count":#{count},"next":#{count == limit && last ? last.to_json : 'null'}})
    end

    # Totals for reconciliation, and the id of every work package that exists,
    # so a reader can drop the history of work packages deleted since.
    def summary
      sql = <<~SQL
        SELECT (SELECT count(*) FROM journals WHERE journable_type = 'WorkPackage') AS journals,
               (SELECT count(DISTINCT journable_id) FROM journals WHERE journable_type = 'WorkPackage') AS journaled_work_packages,
               (SELECT to_char(max(COALESCE(updated_at, created_at)) AT TIME ZONE 'UTC', #{TIMESTAMP})
                  FROM journals WHERE journable_type = 'WorkPackage') AS last_changed_at,
               (SELECT count(*) FROM work_packages) AS work_packages,
               (SELECT count(*) FROM cost_entries) AS cost_entries,
               (SELECT COALESCE(json_agg(id ORDER BY id), '[]'::json)::text FROM work_packages) AS work_package_ids,
               (SELECT to_char(now() AT TIME ZONE 'UTC', #{TIMESTAMP})) AS server_time,
               (SELECT value FROM settings WHERE name = 'journal_aggregation_time_minutes') AS aggregation_minutes
      SQL
      row = ActiveRecord::Base.connection.select_one(sql)

      body = %({"journals":#{row['journals'].to_i},) +
             %("journaledWorkPackages":#{row['journaled_work_packages'].to_i},) +
             %("lastChangedAt":#{row['last_changed_at'].to_json},) +
             %("workPackages":#{row['work_packages'].to_i},) +
             %("costEntries":#{row['cost_entries'].to_i},) +
             %("workPackageIds":#{row['work_package_ids']},) +
             %("serverTime":#{row['server_time'].to_json},) +
             %("aggregationMinutes":#{(row['aggregation_minutes'].presence || '5').to_i}})
      render json: body
    end

    private

    def page_sql(since, after, limit)
      ActiveRecord::Base.sanitize_sql_array([<<~SQL, since, after, limit])
        WITH page AS (
          SELECT j.id,
                 COALESCE(j.updated_at, j.created_at) AS changed_at
            FROM journals j
           WHERE j.journable_type = 'WorkPackage'
             AND j.data_type = 'Journal::WorkPackageJournal'
             AND (COALESCE(j.updated_at, j.created_at), j.id) > (?::timestamptz, ?::bigint)
           ORDER BY COALESCE(j.updated_at, j.created_at), j.id
           LIMIT ?
        ),
        rows AS (
          SELECT j.id                                                          AS "id",
                 j.journable_id                                                AS "workPackageId",
                 j.version                                                     AS "version",
                 j.user_id                                                     AS "userId",
                 to_char(page.changed_at AT TIME ZONE 'UTC', #{TIMESTAMP})     AS "changedAt",
                 to_char(lower(j.validity_period) AT TIME ZONE 'UTC', #{TIMESTAMP}) AS "validFrom",
                 (j.notes IS NOT NULL AND j.notes <> '')                       AS "hasNotes",
                 d.project_id                                                  AS "projectId",
                 d.type_id                                                     AS "typeId",
                 d.status_id                                                   AS "statusId",
                 d.priority_id                                                 AS "priorityId",
                 d.assigned_to_id                                              AS "assigneeId",
                 d.responsible_id                                              AS "accountableId",
                 d.author_id                                                   AS "authorId",
                 d.parent_id                                                   AS "parentId",
                 d.version_id                                                  AS "versionId",
                 d.category_id                                                 AS "categoryId",
                 d.subject                                                     AS "subject",
                 to_char(d.start_date, 'YYYY-MM-DD')                           AS "startDate",
                 to_char(d.due_date, 'YYYY-MM-DD')                             AS "dueDate",
                 d.duration                                                    AS "duration",
                 d.done_ratio                                                  AS "doneRatio",
                 d.derived_done_ratio                                          AS "derivedDoneRatio",
                 d.estimated_hours                                             AS "estimatedHours",
                 d.derived_estimated_hours                                     AS "derivedEstimatedHours",
                 d.remaining_hours                                             AS "remainingHours",
                 d.story_points                                                AS "storyPoints",
                 d.schedule_manually                                           AS "scheduleManually",
                 (SELECT jsonb_object_agg(v.custom_field_id::text, v.vals)
                    FROM (SELECT c.custom_field_id, jsonb_agg(c.value ORDER BY c.id) AS vals
                            FROM customizable_journals c
                           WHERE c.journal_id = j.id
                           GROUP BY c.custom_field_id) v)                      AS "customValues",
                 page.changed_at                                               AS sort_at
            FROM page
            JOIN journals j ON j.id = page.id
            JOIN work_package_journals d ON d.id = j.data_id
        )
        SELECT (SELECT COALESCE(json_agg(row_to_json(r)::jsonb - 'sort_at' ORDER BY r.sort_at, r."id"), '[]'::json)::text FROM rows r) AS rows,
               (SELECT count(*) FROM rows) AS count,
               (SELECT to_char(r.sort_at AT TIME ZONE 'UTC', #{TIMESTAMP}) || '|' || r."id"
                  FROM rows r ORDER BY r.sort_at DESC, r."id" DESC LIMIT 1) AS last_cursor
      SQL
    end

    def cost_entries_sql(since, after, limit)
      ActiveRecord::Base.sanitize_sql_array([<<~SQL, since, after, limit])
        WITH rows AS (
          SELECT e.id                                                  AS "id",
                 e.project_id                                          AS "projectId",
                 e.work_package_id                                     AS "workPackageId",
                 e.user_id                                             AS "userId",
                 e.cost_type_id                                        AS "costTypeId",
                 t.name                                                AS "costTypeName",
                 t.unit                                                AS "unit",
                 e.units                                               AS "units",
                 -- An overridden amount is what the person entered over the
                 -- rate; it is the amount OpenProject itself reports.
                 COALESCE(e.overridden_costs, e.costs)::float8         AS "amount",
                 to_char(e.spent_on, 'YYYY-MM-DD')                     AS "spentOn",
                 to_char(e.created_at AT TIME ZONE 'UTC', #{TIMESTAMP}) AS "createdAt",
                 to_char(e.updated_at AT TIME ZONE 'UTC', #{TIMESTAMP}) AS "updatedAt",
                 e.updated_at                                          AS sort_at
            FROM cost_entries e
            LEFT JOIN cost_types t ON t.id = e.cost_type_id
           WHERE (e.updated_at, e.id) > (?::timestamptz, ?::bigint)
           ORDER BY e.updated_at, e.id
           LIMIT ?
        )
        SELECT (SELECT COALESCE(json_agg(row_to_json(r)::jsonb - 'sort_at' ORDER BY r.sort_at, r."id"), '[]'::json)::text FROM rows r) AS rows,
               (SELECT count(*) FROM rows) AS count,
               (SELECT to_char(r.sort_at AT TIME ZONE 'UTC', #{TIMESTAMP}) || '|' || r."id"
                  FROM rows r ORDER BY r.sort_at DESC, r."id" DESC LIMIT 1) AS last_cursor
      SQL
    end

    # `<timestamp>|<id>`, as `next` returned it; absent means the beginning.
    def parse_cursor(raw)
      return ["-infinity", 0] if raw.blank?

      stamp, id = raw.to_s.split("|", 2)
      time = Time.iso8601(stamp.to_s)
      id = Integer(id.to_s, 10)
      [time.utc.strftime("%Y-%m-%dT%H:%M:%S.%6NZ"), id]
    rescue ArgumentError, TypeError
      render json: { message: "cursor is not one this endpoint returned." }, status: :unprocessable_entity
      [nil, nil]
    end

    def authenticate!
      user = resolve_user
      unless user&.admin? && user.active?
        return render json: { message: "This endpoint is for administrators." }, status: :forbidden
      end

      User.current = user
      yield
    ensure
      User.current = nil
    end

    def resolve_user
      header = request.authorization.to_s
      case header
      when /\ABearer\s+(.+)\z/i
        token = Doorkeeper::AccessToken.by_token(Regexp.last_match(1).strip)
        return nil unless token&.accessible?

        User.find_by(id: token.resource_owner_id)
      when /\ABasic\s+(.+)\z/i
        login, key = Regexp.last_match(1).unpack1("m").to_s.split(":", 2)
        return nil unless login == "apikey" && key.present?

        Token::API.find_by_plaintext_value(key)&.user
      end
    end
  end
end

Rails.application.routes.prepend do
  scope "epm_admin/analytics", controller: "epm_analytics", format: false, defaults: { format: :json } do
    get "journals/summary", action: :summary
    get "journals", action: :journals
    get "cost_entries", action: :cost_entries
  end
end
