# EPM: the scheduling network out, and the float EPM computes from it back in.
#
# EPM computes the critical path and the float of every scheduled work package
# (BR-101 to BR-104) and keeps them as its own records. So that OpenProject's
# query engine — which EPM's saved views run on — can filter, sort, group and
# sum on them too (BR-103), EPM also writes them into three work package custom
# fields, created by setup/schedule-fields.rb:
#
#   Total float (days)   integer   working days the item can slip without moving its project's finish
#   Free float (days)    integer   working days it can slip without moving any successor
#   On critical path     boolean   total float of nought
#
#   GET  /epm_admin/schedule/network      every work package of an active project with its dates and
#                                         scheduling mode, the `follows` relations, the working
#                                         calendar, and each one's current values in the three fields
#   GET  /epm_admin/schedule/fingerprint  two digests of that — the network, and the values stored —
#                                         so EPM can tell cheaply whether anything has moved
#   POST /epm_admin/schedule/values       write computed values into the three fields
#
# How the values are written, and why not through the API
# --------------------------------------------------------
# A float figure moves because some other work package's date moved. It is not
# an edit of this one, and writing it through `WorkPackages::UpdateService`
# would treat it as one: a version in the journal under whoever's token EPM
# used, a new lock version — so anyone editing that work package at that moment
# would be refused for a change they cannot see — and the notifications and
# webhooks an edit sends. So the values are written straight into
# `custom_values`, in one transaction, and each work package whose values
# changed has its `updated_at` moved on by one microsecond: invisible in every
# date OpenProject shows or filters on, but a new cache version, which is what
# makes API v3 (its work package representations are cached on `updated_at`)
# show the new figures at once.
#
# And they are kept out of the journal: the part of `Journals::CreateService`
# that records custom values leaves the three fields out, both from each
# version it writes and from its "has anything changed" comparison. Otherwise
# the next person to edit a work package would be shown in its Activity as
# having changed its float.
#
# Only work packages whose type has the fields active (and, for a field not
# "for all projects", whose project has it enabled) hold values; the rest are
# left alone and EPM reports them. The fields are found by name. Renaming one
# disconnects it: EPM then reports the field missing, and stops writing.
#
# Admin only, identified exactly as API v3 identifies a caller. It reads and
# writes OpenProject's internal schema, which has no compatibility guarantee;
# after an upgrade, verify the endpoints still answer — see README.md.

module EpmSchedule
  FIELDS = {
    "totalFloat" => { name: "Total float (days)", format: "int" },
    "freeFloat" => { name: "Free float (days)", format: "int" },
    "critical" => { name: "On critical path", format: "bool" }
  }.freeze

  # The fields are looked up by name and held briefly: the journal patch below
  # asks on every work package save, and every Puma worker asks on its own.
  FIELD_CACHE_SECONDS = 10

  class << self
    # { "totalFloat" => 12, ... } for the fields that exist with the right format.
    def field_ids(fresh: false)
      cached = @field_ids
      return cached[:ids] if !fresh && cached && cached[:at] > Time.now.to_f - FIELD_CACHE_SECONDS

      found = WorkPackageCustomField.where(name: FIELDS.values.pluck(:name)).pluck(:name, :field_format, :id)
      ids = FIELDS.each_with_object({}) do |(key, spec), memo|
        match = found.find { |name, format, _id| name == spec[:name] && format == spec[:format] }
        memo[key] = match[2] if match
      end
      @field_ids = { ids: ids.freeze, at: Time.now.to_f }
      ids
    end

    # What each expected field is on this instance: its id, or why it cannot be used.
    def field_report
      FIELDS.to_h do |key, spec|
        field = WorkPackageCustomField.find_by(name: spec[:name])
        state = if field.nil? then { id: nil, problem: "missing" }
                elsif field.field_format != spec[:format] then { id: field.id, problem: "format #{field.field_format}, not #{spec[:format]}" }
                else { id: field.id, problem: nil }
                end
        [key, state.merge(name: spec[:name])]
      end
    end

    # Leaves the computed fields out of SQL that `Journals::CreateService`
    # builds over `custom_values` and `customizable_journals`. If upstream
    # rewrites that SQL and the anchors are gone, it is returned unchanged —
    # float would then be journalled like any field, which is noise, not harm —
    # and the fact is logged once.
    def without_computed_fields(sql)
      ids = field_ids.values
      return sql if ids.empty?

      list = ids.map { |id| Integer(id) }.join(",")
      patched = sql.gsub(/custom_values\.customized_type = ('[^']*')/) do
        "custom_values.customized_type = #{Regexp.last_match(1)} AND custom_values.custom_field_id NOT IN (#{list})"
      end
      patched = patched.gsub("customizable_journals.journal_id = max_journals.id",
                             "customizable_journals.journal_id = max_journals.id " \
                             "AND customizable_journals.custom_field_id NOT IN (#{list})")
      if patched == sql && !@warned
        @warned = true
        Rails.logger.warn("[epm_schedule] the journal SQL no longer has the expected shape; float fields will be journalled")
      end
      patched
    end
  end

  module Unjournaled
    def insert_sql
      EpmSchedule.without_computed_fields(super)
    end

    def changes_sql
      EpmSchedule.without_computed_fields(super)
    end
  end
end

Rails.application.config.to_prepare do
  unless Journals::CreateService::Customizable.ancestors.include?(EpmSchedule::Unjournaled)
    Journals::CreateService::Customizable.prepend(EpmSchedule::Unjournaled)
  end

  next if defined?(EpmScheduleController)

  class EpmScheduleController < ActionController::API
    MAX_VALUES = 5000

    around_action :authenticate!

    rescue_from StandardError do |error|
      Rails.logger.error("[epm_schedule] #{error.class}: #{error.message}\n#{error.backtrace&.first(10)&.join("\n")}")
      render json: { message: error.message }, status: :internal_server_error
    end

    # The network, in one read. Postgres builds the JSON.
    def network
      ids = EpmSchedule.field_ids(fresh: true)
      row = ActiveRecord::Base.connection.select_one(network_sql(ids))
      fingerprint = { network: row["network_digest"], values: row["values_digest"] }
      body = %({"workPackages":#{row['work_packages']},"relations":#{row['relations']},) +
             %("calendar":#{calendar.to_json},"fields":#{EpmSchedule.field_report.to_json},) +
             %("fingerprint":#{fingerprint.to_json}})
      render json: body
    end

    # The same digests the network carries, without the network.
    def fingerprint
      ids = EpmSchedule.field_ids(fresh: true)
      row = ActiveRecord::Base.connection.select_one(fingerprint_sql(ids))
      render json: { network: row["network_digest"], values: row["values_digest"],
                     workPackages: row["work_packages"].to_i, relations: row["relations"].to_i }
    end

    # { "values": [{ "id": 1, "totalFloat": 3, "freeFloat": 0, "critical": false }, ...] }
    # A null clears that field. Only what differs from what is stored is written.
    def values
      body = JSON.parse(request.raw_post.presence || "{}")
      entries = body.is_a?(Hash) ? Array(body["values"]) : []
      unless entries.all? { |entry| entry.is_a?(Hash) && entry["id"].present? }
        return render json: { message: "values must be a list of { id, totalFloat, freeFloat, critical }." },
                      status: :unprocessable_entity
      end
      if entries.size > MAX_VALUES
        return render json: { message: "At most #{MAX_VALUES} work packages at a time." }, status: :unprocessable_entity
      end

      ids = EpmSchedule.field_ids(fresh: true)
      if ids.size < EpmSchedule::FIELDS.size
        return render json: { message: "The schedule fields are not set up. Run setup/schedule-fields.rb.",
                              fields: EpmSchedule.field_report }, status: :conflict
      end

      render json: write_values(entries, ids)
    end

    private

    def calendar
      {
        workingDays: Array(Setting.working_days).map(&:to_i),
        nonWorkingDays: NonWorkingDay.order(:date).pluck(:date).map(&:iso8601)
      }
    end

    def field_list(ids)
      ids.values.any? ? ids.values.map { |id| Integer(id) }.join(",") : "NULL"
    end

    # A work package may hold a field when its type has it active and the field
    # is for all projects or enabled in its project.
    def holds_sql(field_id)
      field_id = Integer(field_id)
      <<~SQL.squish
        EXISTS (SELECT 1 FROM custom_fields_types cft
                  JOIN custom_fields f ON f.id = cft.custom_field_id
                 WHERE cft.type_id = w.type_id AND f.id = #{field_id}
                   AND (f.is_for_all OR EXISTS (SELECT 1 FROM custom_fields_projects cfp
                                                 WHERE cfp.custom_field_id = f.id AND cfp.project_id = w.project_id)))
      SQL
    end

    def value_sql(field_id)
      return "NULL" unless field_id

      "(SELECT v.value FROM custom_values v WHERE v.customized_type = 'WorkPackage' AND v.customized_id = w.id " \
        "AND v.custom_field_id = #{Integer(field_id)} ORDER BY v.id LIMIT 1)"
    end

    def network_sql(ids)
      total = ids["totalFloat"]
      <<~SQL
        WITH wp AS (
          SELECT w.id, w.project_id, w.parent_id, w.subject, w.start_date, w.due_date, w.duration,
                 COALESCE(w.schedule_manually, false) AS schedule_manually,
                 COALESCE(w.ignore_non_working_days, false) AS ignore_non_working_days,
                 COALESCE(t.is_milestone, false) AS is_milestone,
                 #{total ? holds_sql(total) : 'false'} AS mirrorable,
                 #{value_sql(ids['totalFloat'])} AS total_float,
                 #{value_sql(ids['freeFloat'])} AS free_float,
                 #{value_sql(ids['critical'])} AS critical
            FROM work_packages w
            JOIN projects p ON p.id = w.project_id AND p.active
            JOIN types t ON t.id = w.type_id
        )
        SELECT
          (SELECT COALESCE(json_agg(json_build_object(
                    'id', wp.id,
                    'projectId', wp.project_id,
                    'parentId', wp.parent_id,
                    'subject', wp.subject,
                    'startDate', to_char(wp.start_date, 'YYYY-MM-DD'),
                    'dueDate', to_char(wp.due_date, 'YYYY-MM-DD'),
                    'duration', wp.duration,
                    'scheduleManually', wp.schedule_manually,
                    'ignoreNonWorkingDays', wp.ignore_non_working_days,
                    'isMilestone', wp.is_milestone,
                    'mirrorable', wp.mirrorable,
                    'values', json_build_object(
                      'totalFloat', CASE WHEN wp.total_float ~ '^-?[0-9]+$' THEN wp.total_float::int END,
                      'freeFloat', CASE WHEN wp.free_float ~ '^-?[0-9]+$' THEN wp.free_float::int END,
                      'critical', CASE WHEN wp.critical IS NULL OR wp.critical = '' THEN NULL ELSE wp.critical = 't' END)
                  ) ORDER BY wp.id), '[]'::json)::text
             FROM wp) AS work_packages,
          (SELECT COALESCE(json_agg(json_build_object(
                    'id', r.id,
                    'successorId', r.from_id,
                    'predecessorId', r.to_id,
                    'lag', COALESCE(r.lag, 0)) ORDER BY r.id), '[]'::json)::text
             FROM relations r
            WHERE r.relation_type = 'follows') AS relations,
          (#{network_digest_sql(ids)}) AS network_digest,
          (#{values_digest_sql(ids)}) AS values_digest
      SQL
    end

    def fingerprint_sql(ids)
      <<~SQL
        SELECT (#{network_digest_sql(ids)}) AS network_digest,
               (#{values_digest_sql(ids)}) AS values_digest,
               (SELECT count(*) FROM work_packages w JOIN projects p ON p.id = w.project_id AND p.active) AS work_packages,
               (SELECT count(*) FROM relations WHERE relation_type = 'follows') AS relations
      SQL
    end

    # Everything the pass reads: dates and scheduling mode, hierarchy, which
    # work packages may hold the fields, the relations and the calendar. Not
    # subjects, statuses or anything else that cannot move a figure. Read in
    # the same statement as the network, so a change made while EPM computes
    # is never mistaken for one it has already seen.
    def network_digest_sql(ids)
      total = ids["totalFloat"]
      <<~SQL.squish
        SELECT md5(concat_ws('|',
          (SELECT string_agg(concat_ws(',', w.id, w.project_id, w.parent_id, w.start_date, w.due_date, w.duration,
                                       w.schedule_manually, w.ignore_non_working_days, t.is_milestone,
                                       #{total ? holds_sql(total) : 'false'}), ';' ORDER BY w.id)
             FROM work_packages w
             JOIN projects p ON p.id = w.project_id AND p.active
             JOIN types t ON t.id = w.type_id),
          (SELECT string_agg(concat_ws(',', r.id, r.from_id, r.to_id, r.lag), ';' ORDER BY r.id)
             FROM relations r WHERE r.relation_type = 'follows'),
          #{ActiveRecord::Base.connection.quote(calendar.to_json)},
          #{ActiveRecord::Base.connection.quote(ids.to_json)}))
      SQL
    end

    # The values stored in the three fields now, so a value changed by hand is
    # noticed and put back.
    def values_digest_sql(ids)
      <<~SQL.squish
        SELECT md5(COALESCE(
          (SELECT string_agg(concat_ws(',', v.customized_id, v.custom_field_id, v.value), ';'
                             ORDER BY v.customized_id, v.custom_field_id, v.id)
             FROM custom_values v
            WHERE v.customized_type = 'WorkPackage' AND v.custom_field_id IN (#{field_list(ids)})), ''))
      SQL
    end

    def write_values(entries, ids)
      wanted = {}
      entries.each do |entry|
        wanted[Integer(entry["id"])] = {
          ids["totalFloat"] => entry["totalFloat"].nil? ? nil : Integer(entry["totalFloat"]).to_s,
          ids["freeFloat"] => entry["freeFloat"].nil? ? nil : Integer(entry["freeFloat"]).to_s,
          ids["critical"] => if entry["critical"].nil? then nil
                             elsif ActiveModel::Type::Boolean.new.cast(entry["critical"]) then OpenProject::Database::DB_VALUE_TRUE
                             else OpenProject::Database::DB_VALUE_FALSE
                             end
        }
      end
      result = { written: 0, cleared: 0, unchanged: 0, skipped: 0, touched: 0 }
      return result if wanted.empty?

      field_ids = ids.values
      work_package_ids = wanted.keys

      ActiveRecord::Base.transaction do
        # Which (work package, field) pairs may hold a value at all.
        allowed = Set.new
        field_ids.each do |field_id|
          ActiveRecord::Base.connection.select_values(
            ActiveRecord::Base.sanitize_sql_array(
              ["SELECT w.id FROM work_packages w WHERE w.id IN (?) AND #{holds_sql(field_id)}", work_package_ids]
            )
          ).each { |id| allowed << [id.to_i, field_id] }
        end

        current = Hash.new { |hash, key| hash[key] = {} }
        CustomValue.where(customized_type: "WorkPackage", customized_id: work_package_ids, custom_field_id: field_ids)
                   .order(:id)
                   .pluck(:customized_id, :custom_field_id, :value)
                   .each { |wp, field, value| current[wp][field] ||= value.presence }

        rows = []
        changed = []
        wanted.each do |wp, values|
          kept = values.to_h do |field_id, value|
            if value && !allowed.include?([wp, field_id])
              result[:skipped] += 1
              value = nil
            end
            [field_id, value]
          end
          if kept.all? { |field_id, value| current[wp][field_id] == value }
            result[:unchanged] += 1
            next
          end

          changed << wp
          kept.each do |field_id, value|
            if value
              rows << { customized_type: "WorkPackage", customized_id: wp, custom_field_id: field_id, value: value }
              result[:written] += 1
            elsif current[wp][field_id]
              result[:cleared] += 1
            end
          end
        end

        if changed.any?
          # A changed work package has all three rewritten: delete, then insert
          # what it should hold. Its `updated_at` moves by a microsecond so
          # API v3's cached representation is rebuilt.
          CustomValue.where(customized_type: "WorkPackage", customized_id: changed, custom_field_id: field_ids).delete_all
          CustomValue.insert_all(rows) if rows.any?
          WorkPackage.where(id: changed).update_all("updated_at = updated_at + interval '1 microsecond'")
          result[:touched] = changed.size
        end
      end

      result
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
  scope "epm_admin/schedule", controller: "epm_schedule", format: false, defaults: { format: :json } do
    get "network", action: :network
    get "fingerprint", action: :fingerprint
    post "values", action: :values
  end
end
