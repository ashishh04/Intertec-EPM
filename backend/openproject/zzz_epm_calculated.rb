# EPM: the inputs calculated fields read, out, and the values EPM computes from
# them, back in (BR-406 to BR-408).
#
# A calculated field is a formula over a work package — its own fields, its
# custom fields, other calculated fields, its children — defined in EPM. EPM
# evaluates it and keeps the values as its own records; so that OpenProject's
# query engine, which EPM's saved views run on, can show them as a column and
# filter, group and sum on them, EPM also writes each value into a work package
# custom field of its own, one per calculated field. The sibling of
# zzz_epm_schedule.rb, which does the same for float.
#
#   GET  /epm_admin/calculated/fields        every work package custom field: format, scope, and
#                                            whether it is one EPM computes
#   POST /epm_admin/calculated/fields/:id    make a custom field one EPM computes, for some types
#                                            and projects or all of them
#   GET  /epm_admin/calculated/inputs        what the formulas read, for every work package of an
#                                            active project (or one work package and everything
#                                            under it, ?root=), in one query
#   GET  /epm_admin/calculated/fingerprint   two digests of that — the inputs, and the values
#                                            stored — so EPM can tell cheaply whether anything moved
#   POST /epm_admin/calculated/values        write computed values
#
# Which custom fields EPM computes
# --------------------------------
# A custom field EPM computes carries `editable = false`. OpenProject reads that
# flag for user custom fields only ("editable by the user"); on a work package
# field it is otherwise unused, and its form does not show it, so it survives
# an administrator editing the field. It is set here, by the endpoint EPM calls
# when it makes the field, and it is what the journal patch and the values
# write below go by: the write refuses any field without it, so a mistake in
# EPM can never overwrite a value a person typed.
#
# How the values are written, and why not through the API
# --------------------------------------------------------
# Exactly as the schedule bridge writes float (see zzz_epm_schedule.rb): straight
# into `custom_values`, in one transaction, only where the value differs, with
# the `updated_at` of each work package changed moved on by one microsecond so
# API v3's cached representation is rebuilt; and kept out of the journal, so a
# recalculated figure is never shown in an Activity tab as somebody's edit.
#
# Admin only, identified exactly as API v3 identifies a caller. It reads and
# writes OpenProject's internal schema, which has no compatibility guarantee;
# after an upgrade, verify the endpoints still answer — see README.md.

module EpmCalculated
  # Looked up briefly: the journal patch asks on every work package save, and
  # every Puma worker asks on its own.
  FIELD_CACHE_SECONDS = 10

  class << self
    # The ids of the work package custom fields EPM computes.
    def field_ids(fresh: false)
      cached = @field_ids
      return cached[:ids] if !fresh && cached && cached[:at] > Time.now.to_f - FIELD_CACHE_SECONDS

      ids = WorkPackageCustomField.where(editable: false).order(:id).pluck(:id).freeze
      @field_ids = { ids: ids, at: Time.now.to_f }
      ids
    end

    # Leaves the computed fields out of the SQL `Journals::CreateService`
    # builds, as the schedule bridge does for float. Both patches can apply to
    # the same statement; each adds its own condition. If upstream rewrites
    # the SQL and the anchors are gone it is returned unchanged — values would
    # then be journalled, which is noise, not harm — and that is logged once.
    def without_calculated_fields(sql)
      ids = field_ids
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
        Rails.logger.warn("[epm_calculated] the journal SQL no longer has the expected shape; calculated fields will be journalled")
      end
      patched
    end
  end

  module Unjournaled
    def insert_sql
      EpmCalculated.without_calculated_fields(super)
    end

    def changes_sql
      EpmCalculated.without_calculated_fields(super)
    end
  end
end

Rails.application.config.to_prepare do
  unless Journals::CreateService::Customizable.ancestors.include?(EpmCalculated::Unjournaled)
    Journals::CreateService::Customizable.prepend(EpmCalculated::Unjournaled)
  end

  next if defined?(EpmCalculatedController)

  class EpmCalculatedController < ActionController::API
    class Invalid < StandardError; end

    MAX_VALUES = 5000
    MAX_TEXT = 1000

    around_action :authenticate!

    rescue_from StandardError do |error|
      case error
      when Invalid, ArgumentError, JSON::ParserError
        render json: { message: error.message }, status: :unprocessable_entity
      when ActiveRecord::RecordNotFound
        render json: { message: "That custom field does not exist." }, status: :not_found
      when ActiveRecord::RecordInvalid
        render json: { message: error.record.errors.full_messages.join(", ") }, status: :unprocessable_entity
      else
        Rails.logger.error("[epm_calculated] #{error.class}: #{error.message}\n#{error.backtrace&.first(10)&.join("\n")}")
        render json: { message: error.message }, status: :internal_server_error
      end
    end

    # Every work package custom field, as formulas and EPM's scope settings need it.
    def fields
      render json: { fields: WorkPackageCustomField.order(:id).map { |field| describe(field) } }
    end

    # Makes a custom field one EPM computes: `editable = false`, usable as a
    # filter, never required, active on the given types (every type when none
    # are given) and enabled in the given projects (for all projects when none
    # are). Activating on a type is what lets a work package of that type hold
    # a value; types not given lose it.
    def configure
      field = WorkPackageCustomField.find(Integer(params[:id]))
      body = json_body
      type_ids = Array(body["typeIds"]).map { |id| Integer(id) }.uniq
      project_ids = Array(body["projectIds"]).map { |id| Integer(id) }.uniq

      ActiveRecord::Base.transaction do
        field.editable = false
        field.is_filter = true
        field.is_required = false
        field.is_for_all = project_ids.empty?
        field.save!
        field.project_ids = project_ids.empty? ? [] : Project.where(id: project_ids).pluck(:id)

        wanted = type_ids.empty? ? Type.pluck(:id) : Type.where(id: type_ids).pluck(:id)
        # From 17 fields belong to a type's variants, not the type: every variant
        # of a wanted type gets the field, and every other variant loses it.
        TypeVariant.find_each do |variant|
          has = variant.custom_field_ids.include?(field.id)
          want = wanted.include?(variant.type_id)
          next if has == want

          # Not `reset_attribute_groups`: that starts by deactivating every field.
          variant.custom_field_ids = want ? variant.custom_field_ids + [field.id] : variant.custom_field_ids - [field.id]
          variant.save!
        end
      end
      EpmCalculated.field_ids(fresh: true)

      render json: describe(field.reload)
    end

    # What the formulas read, in one statement. Postgres builds the JSON.
    def inputs
      custom = id_list(params[:fields])
      calculated = EpmCalculated.field_ids(fresh: true)
      root = params[:root].presence && Integer(params[:root])
      row = ActiveRecord::Base.connection.select_one(inputs_sql(custom, calculated, root))
      fingerprint = root ? nil : { inputs: row["inputs_digest"], values: row["values_digest"] }
      fields = WorkPackageCustomField.where(id: (custom + calculated).uniq).order(:id).to_h { |field| [field.id.to_s, describe(field)] }
      body = %({"workPackages":#{row['work_packages']},"customFields":#{fields.to_json},) +
             %("calendar":#{calendar.to_json},"fingerprint":#{fingerprint.to_json}})
      render json: body
    end

    # The same digests the inputs carry, without the inputs.
    def fingerprint
      custom = id_list(params[:fields])
      calculated = EpmCalculated.field_ids(fresh: true)
      row = ActiveRecord::Base.connection.select_one(<<~SQL)
        SELECT (#{inputs_digest_sql(custom, calculated)}) AS inputs_digest,
               (#{values_digest_sql(calculated)}) AS values_digest,
               (SELECT count(*) FROM work_packages w JOIN projects p ON p.id = w.project_id AND p.active) AS work_packages
      SQL
      render json: { inputs: row["inputs_digest"], values: row["values_digest"], workPackages: row["work_packages"].to_i }
    end

    # { "values": [{ "id": 12, "values": { "41": "3.5", "42": null } }, ...] }
    # Each value as the field stores it: a decimal number, YYYY-MM-DD, "t" or
    # "f", or text; null clears it. Only what differs from what is stored is
    # written, and only for the fields named, which must all be EPM's.
    def values
      body = json_body
      entries = Array(body["values"])
      unless entries.all? { |entry| entry.is_a?(Hash) && entry["id"].present? && entry["values"].is_a?(Hash) }
        raise Invalid, "values must be a list of { id, values: { customFieldId: value } }."
      end
      raise Invalid, "At most #{MAX_VALUES} work packages at a time." if entries.size > MAX_VALUES

      ours = EpmCalculated.field_ids(fresh: true)
      fields = WorkPackageCustomField.where(id: ours).index_by(&:id)
      wanted = Hash.new { |hash, key| hash[key] = {} }
      entries.each do |entry|
        work_package = Integer(entry["id"])
        entry["values"].each do |key, value|
          field = fields[Integer(key)]
          raise Invalid, "Custom field #{key} is not one EPM computes." unless field

          wanted[work_package][field.id] = encode(field, value)
        end
      end

      render json: write_values(wanted)
    end

    private

    def describe(field)
      {
        id: field.id,
        name: field.name,
        format: field.field_format,
        multiValue: field.multi_value?,
        calculated: field.editable == false,
        isForAll: field.is_for_all?,
        isFilter: field.is_filter?,
        typeIds: field.type_variants.map(&:type_id).uniq.sort,
        projectIds: field.project_ids.sort,
        options: field.field_format == "list" ? field.custom_options.to_h { |option| [option.id.to_s, option.value] } : nil
      }
    end

    def id_list(value)
      value.to_s.split(",").map(&:strip).reject(&:empty?).map { |id| Integer(id) }.uniq
    end

    def list_sql(ids)
      ids.any? ? ids.map { |id| Integer(id) }.join(",") : "NULL"
    end

    def calendar
      {
        workingDays: Array(Setting.working_days).map(&:to_i),
        nonWorkingDays: NonWorkingDay.order(:date).pluck(:date).map(&:iso8601)
      }
    end

    # From 17 a type's fields belong to its variants: a project picks a variant of
    # each type (project_types), else the type's default variant applies.
    # A work package may hold a field when its type has it active and the
    # field is for all projects or enabled in its project.
    def holds_sql(field_id)
      field_id = Integer(field_id)
      <<~SQL.squish
        EXISTS (SELECT 1 FROM custom_fields_types cft
                  JOIN custom_fields f ON f.id = cft.custom_field_id
                 WHERE cft.type_variant_id = COALESCE((SELECT pt.variant_id FROM project_types pt WHERE pt.project_id = w.project_id AND pt.type_id = w.type_id), (SELECT tv.id FROM type_variants tv WHERE tv.type_id = w.type_id AND tv.is_default_variant LIMIT 1)) AND f.id = #{field_id}
                   AND (f.is_for_all OR EXISTS (SELECT 1 FROM custom_fields_projects cfp
                                                 WHERE cfp.custom_field_id = f.id AND cfp.project_id = w.project_id)))
      SQL
    end

    def inputs_sql(custom, calculated, root)
      within = root ? "AND w.id IN (SELECT h.descendant_id FROM work_package_hierarchies h WHERE h.ancestor_id = #{Integer(root)})" : ""
      holds = if calculated.any?
                "(SELECT COALESCE(json_agg(f.id ORDER BY f.id), '[]'::json) FROM custom_fields f " \
                  "WHERE f.id IN (#{list_sql(calculated)}) AND #{holds_sql_for_column('f.id')})"
              else
                "'[]'::json"
              end
      digests = if root
                  "NULL AS inputs_digest, NULL AS values_digest"
                else
                  "(#{inputs_digest_sql(custom, calculated)}) AS inputs_digest, (#{values_digest_sql(calculated)}) AS values_digest"
                end
      <<~SQL
        WITH wp AS (
          SELECT w.id, w.project_id, w.type_id, w.parent_id, w.estimated_hours, w.remaining_hours, w.done_ratio,
                 w.start_date, w.due_date, w.story_points
            FROM work_packages w
            JOIN projects p ON p.id = w.project_id AND p.active
           WHERE true #{within}
        ),
        spent AS (
          SELECT h.ancestor_id AS id, SUM(t.hours) AS hours
            FROM work_package_hierarchies h
            JOIN time_entries t ON t.work_package_id = h.descendant_id AND NOT COALESCE(t.ongoing, false)
           WHERE h.ancestor_id IN (SELECT id FROM wp)
           GROUP BY h.ancestor_id
        ),
        given AS (
          SELECT v.id, json_object_agg(v.field::text, v.vals) AS custom
            FROM (SELECT c.customized_id AS id, c.custom_field_id AS field, json_agg(c.value ORDER BY c.id) AS vals
                    FROM custom_values c
                   WHERE c.customized_type = 'WorkPackage' AND c.custom_field_id IN (#{list_sql(custom)})
                     AND c.customized_id IN (SELECT id FROM wp)
                   GROUP BY c.customized_id, c.custom_field_id) v
           GROUP BY v.id
        ),
        stored AS (
          SELECT v.id, json_object_agg(v.field::text, v.value) AS current
            FROM (SELECT DISTINCT ON (c.customized_id, c.custom_field_id)
                         c.customized_id AS id, c.custom_field_id AS field, c.value
                    FROM custom_values c
                   WHERE c.customized_type = 'WorkPackage' AND c.custom_field_id IN (#{list_sql(calculated)})
                     AND c.customized_id IN (SELECT id FROM wp)
                   ORDER BY c.customized_id, c.custom_field_id, c.id) v
           GROUP BY v.id
        )
        SELECT
          (SELECT COALESCE(json_agg(json_build_object(
                    'id', w.id,
                    'projectId', w.project_id,
                    'typeId', w.type_id,
                    'parentId', w.parent_id,
                    'estimatedHours', w.estimated_hours,
                    'remainingHours', w.remaining_hours,
                    'spentHours', COALESCE(spent.hours, 0),
                    'percentDone', w.done_ratio,
                    'startDate', to_char(w.start_date, 'YYYY-MM-DD'),
                    'dueDate', to_char(w.due_date, 'YYYY-MM-DD'),
                    'storyPoints', w.story_points,
                    'custom', COALESCE(given.custom, '{}'::json),
                    'current', COALESCE(stored.current, '{}'::json),
                    'holds', #{holds}
                  ) ORDER BY w.id), '[]'::json)::text
             FROM wp w
             LEFT JOIN spent ON spent.id = w.id
             LEFT JOIN given ON given.id = w.id
             LEFT JOIN stored ON stored.id = w.id) AS work_packages,
          #{digests}
      SQL
    end

    # `holds_sql` with the field id taken from a column rather than a constant.
    def holds_sql_for_column(column)
      <<~SQL.squish
        EXISTS (SELECT 1 FROM custom_fields_types cft
                 WHERE cft.type_variant_id = COALESCE((SELECT pt.variant_id FROM project_types pt WHERE pt.project_id = w.project_id AND pt.type_id = w.type_id), (SELECT tv.id FROM type_variants tv WHERE tv.type_id = w.type_id AND tv.is_default_variant LIMIT 1)) AND cft.custom_field_id = #{column})
        AND (f.is_for_all OR EXISTS (SELECT 1 FROM custom_fields_projects cfp
                                      WHERE cfp.custom_field_id = #{column} AND cfp.project_id = w.project_id))
      SQL
    end

    # Everything a formula can read: each work package's own fields, its place
    # in the tree, the time logged, the custom values formulas name (and a list
    # field's option labels), where each computed field applies, and the
    # calendar. Read in the same statement as the inputs, so a change made
    # while EPM computes is never mistaken for one it has already seen.
    def inputs_digest_sql(custom, calculated)
      <<~SQL.squish
        SELECT md5(concat_ws('|',
          (SELECT string_agg(concat_ws(',', w.id, w.project_id, w.type_id, w.parent_id, w.estimated_hours,
                                       w.remaining_hours, w.done_ratio, w.start_date, w.due_date, w.story_points),
                             ';' ORDER BY w.id)
             FROM work_packages w JOIN projects p ON p.id = w.project_id AND p.active),
          (SELECT concat_ws(',', count(*), sum(hours), max(updated_at), max(id))
             FROM time_entries WHERE NOT COALESCE(ongoing, false)),
          (SELECT string_agg(concat_ws(',', v.customized_id, v.custom_field_id, v.value), ';'
                             ORDER BY v.customized_id, v.custom_field_id, v.id)
             FROM custom_values v
            WHERE v.customized_type = 'WorkPackage' AND v.custom_field_id IN (#{list_sql(custom)})),
          (SELECT string_agg(concat_ws(',', o.id, o.value), ';' ORDER BY o.id)
             FROM custom_options o WHERE o.custom_field_id IN (#{list_sql(custom)})),
          (SELECT string_agg(concat_ws(',', f.id, f.is_for_all,
                    (SELECT string_agg(s.type_id::text, ' ' ORDER BY s.type_id) FROM (SELECT DISTINCT tv.type_id FROM custom_fields_types t JOIN type_variants tv ON tv.id = t.type_variant_id WHERE t.custom_field_id = f.id) s),
                    (SELECT string_agg(pp.project_id::text, ' ' ORDER BY pp.project_id) FROM custom_fields_projects pp WHERE pp.custom_field_id = f.id)),
                  ';' ORDER BY f.id)
             FROM custom_fields f WHERE f.id IN (#{list_sql(calculated)})),
          #{ActiveRecord::Base.connection.quote(calendar.to_json)}))
      SQL
    end

    # The values the computed fields hold now, so one changed by hand is
    # noticed and put back.
    def values_digest_sql(calculated)
      <<~SQL.squish
        SELECT md5(COALESCE(
          (SELECT string_agg(concat_ws(',', v.customized_id, v.custom_field_id, v.value), ';'
                             ORDER BY v.customized_id, v.custom_field_id, v.id)
             FROM custom_values v
            WHERE v.customized_type = 'WorkPackage' AND v.custom_field_id IN (#{list_sql(calculated)})), ''))
      SQL
    end

    # A value as the field stores it, refusing anything that is not one.
    def encode(field, value)
      return nil if value.nil?

      case field.field_format
      when "float", "int"
        text = value.to_s
        raise Invalid, "#{text.inspect} is not a number for #{field.name}." unless text.match?(/\A-?\d+(\.\d+)?\z/)

        text
      when "date"
        text = value.to_s
        raise Invalid, "#{text.inspect} is not a date for #{field.name}." unless text.match?(/\A\d{4}-\d{2}-\d{2}\z/)

        text
      when "bool"
        case value
        when true, "t", "true" then OpenProject::Database::DB_VALUE_TRUE
        when false, "f", "false" then OpenProject::Database::DB_VALUE_FALSE
        else raise Invalid, "#{value.inspect} is not true or false for #{field.name}."
        end
      else
        value.to_s[0, MAX_TEXT]
      end
    end

    def write_values(wanted)
      result = { written: 0, cleared: 0, unchanged: 0, skipped: 0, touched: 0 }
      return result if wanted.empty?

      work_package_ids = wanted.keys
      field_ids = wanted.values.flat_map(&:keys).uniq

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
        changed = Hash.new { |hash, key| hash[key] = [] }
        wanted.each do |wp, values|
          any = false
          values.each do |field_id, value|
            if value && !allowed.include?([wp, field_id])
              result[:skipped] += 1
              value = nil
            end
            next if current[wp][field_id] == value

            any = true
            changed[field_id] << wp
            if value
              rows << { customized_type: "WorkPackage", customized_id: wp, custom_field_id: field_id, value: value }
              result[:written] += 1
            else
              result[:cleared] += 1
            end
          end
          any ? result[:touched] += 1 : result[:unchanged] += 1
        end

        if changed.any?
          changed.each do |field_id, wps|
            CustomValue.where(customized_type: "WorkPackage", customized_id: wps, custom_field_id: field_id).delete_all
          end
          CustomValue.insert_all(rows) if rows.any?
          # A microsecond on: a new cache version for API v3, invisible anywhere a date is shown.
          WorkPackage.where(id: changed.values.flatten.uniq).update_all("updated_at = updated_at + interval '1 microsecond'")
        end
      end

      result
    end

    def json_body
      raw = request.raw_post
      return {} if raw.blank?

      parsed = JSON.parse(raw)
      raise Invalid, "The body must be a JSON object." unless parsed.is_a?(Hash)

      parsed
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
  scope "epm_admin/calculated", controller: "epm_calculated", format: false, defaults: { format: :json } do
    get "fields", action: :fields
    post "fields/:id", action: :configure, constraints: { id: /\d+/ }
    get "inputs", action: :inputs
    get "fingerprint", action: :fingerprint
    post "values", action: :values
  end
end
