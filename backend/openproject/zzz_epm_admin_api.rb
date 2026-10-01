# EPM: a private administration API for the settings OpenProject's REST API
# does not expose.
#
# EPM's Administration area mirrors OpenProject's. Most of it reads and writes
# through API v3, but three pages have no API at all upstream: the users
# settings (default language, time zone, display format, deletion, consent),
# the permission catalogue, and role editing. Those exist only as HTML forms
# behind the admin UI, which EPM never shows.
#
# This file adds them as JSON endpoints under /epm_admin/* on the instance:
#
#   GET    /epm_admin/settings/users   the users-settings object
#   PATCH  /epm_admin/settings/users   partial object -> updated object
#   GET    /epm_admin/enterprise       Enterprise-gated features this instance allows
#   PATCH  /epm_admin/days/week       which weekdays are working days
#   POST   /epm_admin/days/non_working  add a public holiday
#   DELETE /epm_admin/days/non_working/:id
#   GET    /epm_admin/permissions      modules with their settable permissions
#   GET    /epm_admin/roles            every role with its permissions
#   POST   /epm_admin/roles            { name, global, copyWorkflowFromRoleId?, permissions }
#   PATCH  /epm_admin/roles/:id        { name?, permissions? }
#   DELETE /epm_admin/roles/:id        204; 422 when built-in or in use
#
# Admin only. The caller is identified exactly as API v3 identifies it — an
# OAuth bearer token (Doorkeeper) or `apikey:<key>` Basic auth (Token::API) —
# and refused with 403 unless that user is an active administrator. Nothing
# here bypasses OpenProject's own rules: settings go through
# Settings::UpdateService, roles through Roles::CreateService /
# UpdateService / DeleteService, so validation, the admin guard, workflow
# copying and the ROLE_UPDATED notifications all behave as in the admin UI.
#
# What it reads is what OpenProject's own forms read:
#   * app/views/admin/settings/users_settings/show.html.erb and
#     Admin::Settings::UsersSettingsController (consent_time is reset to now
#     when the caller asks for it)
#   * RolesHelper#setable_permissions / Roles::BaseContract#assignable_permissions
#     (hidden and public permissions are never offered, a global role only
#     gets global permissions)
#   * RolesController#create_params (global_role, copy_workflow_from)
#
# Everything it touches is internal OpenProject API with no compatibility
# guarantee. After an upgrade, verify the endpoints still answer — see
# backend/openproject/README.md.
#
# Runs last (zzz_ prefix). The controller is defined in to_prepare so every
# application constant it refers to is loadable by then; the routes are
# prepended so no catch-all route in the application can shadow them.

Rails.application.config.to_prepare do
  next if defined?(EpmAdminController)

  class EpmAdminController < ActionController::API
    KIND_BY_TYPE = {
      "ProjectRole" => "project",
      "GlobalRole" => "global",
      "WorkPackageRole" => "work_package",
      "ProjectQueryRole" => "project_query"
    }.freeze

    # Enterprise-gated features EPM offers a button for. Anything listed here
    # is reported by `GET /epm_admin/enterprise` so the UI can disable the
    # button with a reason rather than let the action fail.
    EPM_ENTERPRISE_FEATURES = %i[placeholder_users].freeze

    # camelCase name in the JSON <-> Setting name, and how each is written.
    SETTINGS = {
      "defaultLanguage" => [:default_language, :language],
      "userDefaultTimezone" => [:user_default_timezone, :timezone],
      "defaultAutoHidePopups" => [:default_auto_hide_popups, :boolean],
      "userFormat" => [:user_format, :user_format],
      "usersDeletableByAdmins" => [:users_deletable_by_admins, :boolean],
      "usersDeletableBySelf" => [:users_deletable_by_self, :boolean],
      "consentRequired" => [:consent_required, :boolean],
      "consentInfo" => [:consent_info, :hash],
      "consentDeclineMail" => [:consent_decline_mail, :string]
    }.freeze

    around_action :authenticate!

    # Rails tries handlers last-declared first, so the catch-all goes first and
    # the specific ones below it win.
    rescue_from StandardError do |error|
      Rails.logger.error("[epm_admin] #{error.class}: #{error.message}\n#{error.backtrace&.first(10)&.join("\n")}")
      render json: { message: error.message }, status: :internal_server_error
    end

    rescue_from ActiveRecord::RecordNotFound do
      render json: { message: "Not found." }, status: :not_found
    end

    # ---------------------------------------------------------------- settings

    def settings_users
      render json: users_settings
    end

    def update_settings_users
      body = json_body
      changes = {}
      SETTINGS.each do |key, (name, format)|
        next unless body.key?(key)

        value = coerce_setting(key, body[key], format)
        # A setting pinned by environment or configuration.yml is shown
        # disabled in OpenProject's form. Sending it back unchanged is fine;
        # asking for a different value is refused rather than exploding.
        unless setting_writable?(name)
          next if value == current_setting_value(name, format)

          raise_validation("#{key} is set by the instance's configuration and cannot be changed here.")
        end
        changes[name.to_s] = value
      end
      changes["consent_time"] = Time.zone.now.iso8601 if body["resetConsentTime"] == true

      unless changes.empty?
        call = Settings::UpdateService.new(user: User.current).call(changes)
        return render_failure(call) unless call.success?
      end

      render json: users_settings
    end

    # ------------------------------------------------------------- enterprise

    # Which Enterprise-gated features this instance may use.
    #
    # OpenProject publishes no API for this, and the only other way to find out
    # is to attempt the action and read the refusal — which is what placeholder
    # users did: a form that could be filled in completely and then always
    # failed on a Community instance. Asked once, up front, so the UI can say
    # so instead of inviting the attempt.
    def enterprise
      allows = EPM_ENTERPRISE_FEATURES.to_h do |feature|
        [feature.to_s.camelize(:lower), enterprise_allows?(feature)]
      end

      render json: { active: enterprise_active?, allows: allows }
    end

    # ------------------------------------------------------------- permissions

    def permissions
      render json: permission_modules
    end

    # ------------------------------------------------------------------- days

    # Working days and public holidays.
    #
    # API v3 publishes `/days/week` and `/days/non_working` read-only — a write
    # to either is a 404 on 15.5.1 — while OpenProject's own administration
    # edits them happily under Calendars and dates. So the reads stay on API v3
    # and the writes come through here, which is the same division this file
    # already makes for users settings, roles and the catalogue.
    #
    # Both go through Settings::UpdateService rather than touching `Setting`
    # directly, because changing either reschedules every work package that
    # depends on it: the service runs OpenProject's validation and enqueues
    # `WorkPackages::ApplyWorkingDaysChangeJob`. Writing the column by hand
    # would change the calendar and leave every existing date untouched.

    WEEKDAY_NAMES = %w[Monday Tuesday Wednesday Thursday Friday Saturday Sunday].freeze

    def update_week_days
      given = json_body["days"]
      unless given.is_a?(Array) && given.all? { |d| d.is_a?(Hash) }
        return render json: { message: "days must be an array of { day, working }." },
                      status: :unprocessable_entity
      end

      working = Array(Setting.working_days).map(&:to_i).to_set

      given.each do |entry|
        day = entry["day"].to_i
        unless (1..7).cover?(day)
          return render json: { message: "#{entry['day'].inspect} is not a day of the week (1 is Monday, 7 is Sunday)." },
                        status: :unprocessable_entity
        end

        entry["working"] ? working.add(day) : working.delete(day)
      end

      if working.empty?
        return render json: { message: "At least one day of the week has to be a working day." },
                      status: :unprocessable_entity
      end

      call = Settings::UpdateService.new(user: User.current).call(working_days: working.to_a.sort)
      return render_failure(call) unless call.success?

      render json: week_days_json
    end

    def create_non_working_day
      body = json_body
      name = body["name"].to_s.strip

      parsed = begin
        Date.iso8601(body["date"].to_s)
      rescue ArgumentError, TypeError
        nil
      end

      return render json: { message: "date must be a calendar date, e.g. 2026-12-25." }, status: :unprocessable_entity if parsed.nil?
      return render json: { message: "A name is required." }, status: :unprocessable_entity if name.blank?

      if NonWorkingDay.exists?(date: parsed)
        return render json: { message: "#{parsed.iso8601} is already a non-working day." },
                      status: :unprocessable_entity
      end

      # The record, not a setting. OpenProject has no `non_working_days`
      # setting — its own Calendars and dates form edits `NonWorkingDay` rows
      # directly — so `Settings::UpdateService` raises "There's no setting
      # named non_working_days" if asked. The reschedule the form would have
      # triggered is requested separately below.
      day = NonWorkingDay.new(date: parsed, name: name)
      unless day.save
        return render json: { message: day.errors.full_messages.join(", ").presence || "The date was refused." },
                      status: :unprocessable_entity
      end

      apply_non_working_days_change(added: [parsed])
      render json: non_working_day_json(day), status: :created
    end

    def destroy_non_working_day
      day = NonWorkingDay.find(params[:id])
      removed = day.date
      day.destroy!
      apply_non_working_days_change(removed: [removed])
      head :no_content
    end

    # ------------------------------------------------------------------- roles

    def roles
      render json: Role.ordered_by_builtin_and_position.includes(:role_permissions).map { |r| role_json(r) }
    end

    def create_role
      body = json_body
      global = body["global"] == true
      probe = global ? GlobalRole.new : ProjectRole.new
      permissions = permission_names(body["permissions"], probe) or return

      params = {
        name: body["name"].to_s,
        permissions: permissions,
        global_role: global ? "1" : nil,
        copy_workflow_from: body["copyWorkflowFromRoleId"].presence
      }
      call = Roles::CreateService.new(user: User.current).call(params)
      return render_failure(call) unless call.success?

      render json: role_json(call.result.reload), status: :created
    end

    def update_role
      role = Role.find(params[:id])
      body = json_body

      changes = {}
      changes[:name] = body["name"].to_s if body.key?("name")
      if body.key?("permissions")
        changes[:permissions] = permission_names(body["permissions"], role) or return
      end

      call = Roles::UpdateService.new(user: User.current, model: role).call(changes)
      return render_failure(call) unless call.success?

      render json: role_json(call.result.reload)
    end

    def destroy_role
      role = Role.find(params[:id])

      if role.builtin?
        return render json: { message: "#{role.name} is a built-in role and cannot be deleted." }, status: :unprocessable_entity
      end
      unless role.deletable?
        return render json: { message: "#{role.name} is still assigned to members and cannot be deleted." },
                      status: :unprocessable_entity
      end

      call = Roles::DeleteService.new(user: User.current, model: role).call
      return render_failure(call) unless call.success?

      head :no_content
    end

    private

    # ------------------------------------------------------------------ auth

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

    # -------------------------------------------------------------- settings

    def users_settings
      consent_time = Setting.consent_time
      {
        defaultLanguage: Setting.default_language.to_s,
        availableLanguages: language_options,
        userDefaultTimezone: Setting.user_default_timezone.presence,
        availableTimezones: timezone_identifiers,
        defaultAutoHidePopups: Setting.default_auto_hide_popups == true,
        userFormat: Setting.user_format.to_s,
        userFormatOptions: User::USER_FORMATS_STRUCTURE.keys.map { |f| { value: f.to_s, label: User.current.name(f) } },
        usersDeletableByAdmins: Setting.users_deletable_by_admins == true,
        usersDeletableBySelf: Setting.users_deletable_by_self == true,
        consentRequired: Setting.consent_required == true,
        consentInfo: (Setting.consent_info.is_a?(Hash) ? Setting.consent_info : {}).transform_values(&:to_s),
        consentTime: consent_time.present? ? consent_time.iso8601 : nil,
        consentDeclineMail: Setting.consent_decline_mail.to_s,
        # Keys of the fields above that the instance pins through environment
        # or configuration.yml; OpenProject's own form disables those.
        readOnlySettings: SETTINGS.reject { |_key, (name, _format)| setting_writable?(name) }.keys
      }
    end

    def setting_writable?(name)
      definition = Settings::Definition[name]
      definition.nil? || definition.writable?
    end

    # The current value in the same form coerce_setting produces, so an
    # unchanged read-only field can be recognised and skipped.
    def current_setting_value(name, format)
      current = Setting[name]
      case format
      when :boolean then current == true ? "1" : "0"
      when :hash then (current.is_a?(Hash) ? current : {}).to_h { |lang, text| [lang.to_s, text.to_s] }
      else current.to_s
      end
    end

    # Same list and labels as OpenProject's default-language select
    # (ApplicationHelper#all_lang_options_for_select): every locale shipped,
    # named in itself, sorted by that name.
    def language_options
      Redmine::I18n.all_languages
                   .map { |code| { code: code.to_s, label: I18n.t("cldr.language_name", locale: code, default: code.to_s) } }
                   .sort_by { |o| o[:label] }
    end

    # Same list as Settings::TimeZoneSettingComponent: one canonical IANA zone
    # per group, in OpenProject's (UTC offset) order; that identifier is what
    # the setting stores.
    def timezone_identifiers
      UserPreferences::UpdateContract
        .assignable_time_zones
        .group_by { |tz| tz.tzinfo.canonical_zone }
        .keys
        .map(&:identifier)
        .uniq
    end

    # Values travel to Settings::UpdateService in the form OpenProject's own
    # settings form posts them ("1"/"0" for check boxes, strings otherwise).
    def coerce_setting(key, value, format)
      case format
      when :boolean
        raise_validation("#{key} must be true or false.") unless [true, false].include?(value)
        value ? "1" : "0"
      when :language
        code = value.to_s
        raise_validation("#{code.inspect} is not an available language.") unless Redmine::I18n.all_languages.include?(code)
        code
      when :timezone
        zone = value.to_s
        unless zone.empty? || timezone_identifiers.include?(zone)
          raise_validation("#{zone.inspect} is not a known time zone.")
        end
        zone
      when :user_format
        name = value.to_s
        unless User::USER_FORMATS_STRUCTURE.key?(name.to_sym)
          raise_validation("#{name.inspect} is not a user display format.")
        end
        name
      when :hash
        raise_validation("#{key} must be an object of language code to text.") unless value.is_a?(Hash)
        value.to_h { |lang, text| [lang.to_s, text.to_s] }
      else
        value.to_s
      end
    end

    # ------------------------------------------------------------ enterprise

    # Both guarded: `EnterpriseToken` is core, but its shape has moved between
    # releases and an administration page must not 500 because a token helper
    # was renamed. Unknown means "not allowed", which is the safe answer.
    # `!!` because these answer nil rather than false on a Community instance,
    # and the contract says boolean: a JSON null reads as "unknown" to the
    # caller, which is a third state the UI would have to handle for no reason.
    def enterprise_active?
      defined?(EnterpriseToken) ? !!EnterpriseToken.active? : false
    rescue StandardError
      false
    end

    def enterprise_allows?(feature)
      defined?(EnterpriseToken) ? !!EnterpriseToken.allows_to?(feature) : false
    rescue StandardError
      false
    end

    # ----------------------------------------------------------- permissions

    # RolesController#visible_permissions grouped as RolesHelper#group_permissions_by_module
    # does it: by module, only the enabled modules, in AccessControl order with
    # the project (nil) module first.
    def permission_modules
      visible = OpenProject::AccessControl.permissions.reject(&:public?).select(&:visible?)
      module_names = OpenProject::AccessControl.sorted_module_names(include_disabled: false)
      grantable = assignable_by_kind

      visible.group_by { |p| p.project_module.to_s }.slice(*module_names).map do |mod, perms|
        {
          id: mod.blank? ? "project" : mod,
          label: module_label(mod),
          permissions: perms.map do |p|
            {
              name: p.name.to_s,
              label: I18n.t("permission_#{p.name}", default: p.name.to_s.humanize),
              explanation: I18n.t("permission_#{p.name}_explanation", default: nil).presence,
              global: p.global?,
              grantTo: grantable.select { |_kind, names| names.include?(p.name.to_s) }.keys
            }
          end
        }
      end
    end

    # The role classes a permission may belong to, keyed by the kind name the
    # API reports. A class missing from this edition is skipped rather than
    # raising, so the catalogue still answers.
    def role_probes
      {
        "project" => "ProjectRole",
        "global" => "GlobalRole",
        "work_package" => "WorkPackageRole",
        "project_query" => "ProjectQueryRole"
      }
    end

    # Which permissions each kind of role may hold.
    #
    # Read from the same contract `permission_names` validates against, so what
    # the catalogue offers and what a create will accept cannot drift. Deriving
    # it from `global?` instead was close but wrong: `view_project_query` and
    # `edit_project_query` are not global, and are not grantable to a project
    # role either, so a form that offered them under "Project" refused every
    # submission with "These permissions cannot be given to this role".
    def assignable_by_kind
      @assignable_by_kind ||= role_probes.each_with_object({}) do |(kind, class_name), acc|
        klass = class_name.safe_constantize
        next if klass.nil?

        acc[kind] = Roles::BaseContract
          .new(klass.new, User.current)
          .assignable_permissions
          .map { |permission| permission.name.to_s }
          .to_set
      rescue StandardError => e
        Rails.logger.warn("[epm_admin] assignable permissions for #{class_name}: #{e.message}")
      end
    end

    # RolesHelper#permission_header_for_project_module
    def module_label(mod)
      if mod.blank?
        Project.model_name.human
      else
        I18n.t("permission_header_for_project_module_#{mod}", default: [:"project_module_#{mod}", mod.humanize])
      end
    end

    # ------------------------------------------------------------------ days

    def week_days_json
      working = Array(Setting.working_days).map(&:to_i)
      (1..7).map do |day|
        { day: day, name: WEEKDAY_NAMES[day - 1], working: working.include?(day) }
      end
    end

    def non_working_day_json(day)
      { id: day.id.to_s, date: day.date.iso8601, name: day.name }
    end

    # Rescheduling is what makes a calendar change mean anything: a new public
    # holiday has to push the work that fell on it.
    #
    # Requested rather than assumed. The job's signature is internal and has
    # moved between releases, so a failure to enqueue is logged and the write
    # still stands — the calendar is correct either way, and refusing the
    # change because the follow-up could not be scheduled would be worse.
    def apply_non_working_days_change(added: [], removed: [])
      return unless defined?(WorkPackages::ApplyWorkingDaysChangeJob)

      WorkPackages::ApplyWorkingDaysChangeJob.perform_later(
        user_id: User.current.id,
        previous_working_days: Array(Setting.working_days),
        previous_non_working_days: (NonWorkingDay.pluck(:date) - added + removed).map(&:to_s)
      )
    rescue StandardError => e
      Rails.logger.warn("[epm_admin] could not enqueue the calendar reschedule: #{e.message}")
    end

    # ----------------------------------------------------------------- roles

    def role_json(role)
      {
        id: role.id.to_s,
        name: role.name,
        builtin: role.builtin?,
        position: role.position.to_i,
        kind: KIND_BY_TYPE.fetch(role.type.to_s, "project"),
        permissions: role.permissions.map(&:to_s)
      }
    end

    # The permissions OpenProject's form would offer for this role, and only
    # those; an unknown or unsettable name is refused rather than silently dropped.
    def permission_names(given, role)
      given = Array(given)
      unless given.all? { |name| name.is_a?(String) }
        render json: { message: "permissions must be an array of permission names." }, status: :unprocessable_entity
        return nil
      end

      assignable = Roles::BaseContract.new(role, User.current).assignable_permissions.map { |p| p.name.to_s }
      unknown = given - assignable
      unless unknown.empty?
        render json: { message: "These permissions cannot be given to this role: #{unknown.join(', ')}." },
               status: :unprocessable_entity
        return nil
      end

      given.uniq.map(&:to_sym)
    end

    # ------------------------------------------------------------ plumbing

    def json_body
      raw = request.raw_post
      return {} if raw.blank?

      parsed = JSON.parse(raw)
      parsed.is_a?(Hash) ? parsed : {}
    rescue JSON::ParserError
      {}
    end

    def render_failure(call)
      message = call.errors.respond_to?(:full_messages) ? call.errors.full_messages.join(", ") : call.message.to_s
      render json: { message: message.presence || "The change was refused." }, status: :unprocessable_entity
    end

    class ValidationRefused < StandardError; end

    def raise_validation(message)
      raise ValidationRefused, message
    end

    rescue_from ValidationRefused do |error|
      render json: { message: error.message }, status: :unprocessable_entity
    end
  end
end

Rails.application.routes.prepend do
  scope "epm_admin", controller: "epm_admin", format: false, defaults: { format: :json } do
    get "settings/users", action: :settings_users
    patch "settings/users", action: :update_settings_users
    get "enterprise", action: :enterprise
    get "permissions", action: :permissions
    get "roles", action: :roles
    post "roles", action: :create_role
    patch "days/week", action: :update_week_days
    post "days/non_working", action: :create_non_working_day
    delete "days/non_working/:id", action: :destroy_non_working_day, constraints: { id: /\d+/ }
    patch "roles/:id", action: :update_role, constraints: { id: /\d+/ }
    delete "roles/:id", action: :destroy_role, constraints: { id: /\d+/ }
  end
end
