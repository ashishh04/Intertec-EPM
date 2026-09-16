# EPM: the administration settings OpenProject exposes only as HTML forms.
#
# A companion to zzz_epm_admin_api.rb, which does the same for users settings,
# the permission catalogue and roles. This file covers the settings *sections*
# of the administration area: work packages, projects, languages, repositories,
# emails, incoming email, aggregation, authentication and calendars.
#
#   GET   /epm_admin/sections            the sections this instance can serve
#   GET   /epm_admin/sections/:id        one section, as field descriptors
#   PATCH /epm_admin/sections/:id        { key: value, ... } -> the section again
#
# The response is **self-describing**: every field carries its type, its
# current value, its options where it is a choice, and whether it can be
# written. EPM's frontend renders a section from that descriptor alone, so a
# new section appears in the product by being added to SECTIONS here and
# nowhere else. The alternative — a bespoke page per section on both sides —
# is the same form typed three times.
#
# Admin only, authenticated exactly as API v3 authenticates: an OAuth bearer
# token or `apikey:<key>` Basic auth, refused with 403 unless that user is an
# active administrator. Writes go through Settings::UpdateService, so the
# validation, the admin guard and the change notifications behave as they do
# in OpenProject's own forms.
#
# A setting pinned by environment or configuration.yml reports `writable:
# false`. EPM renders it disabled, and a request to change it is refused
# rather than silently dropped.
#
# Everything here is internal OpenProject API with no compatibility guarantee.
# After an upgrade, verify the endpoints still answer — see the README beside
# this file.
#
# Runs last (zzz_ prefix), defined in to_prepare so application constants are
# loadable, routes prepended so no catch-all can shadow them.

Rails.application.config.to_prepare do
  next if defined?(EpmAdminSettingsController)

  class EpmAdminSettingsController < ActionController::API
    # A field is [setting_name, type, options_source].
    #
    # `type` decides both how the value is coerced on the way in and how EPM
    # renders it. `options_source` names a method below that lists the legal
    # choices; it is required for :enum and :multi_enum and ignored otherwise.
    SECTIONS = {
      # Avatars live inside a plugin's settings hash rather than in a setting of
      # their own, so these two fields are written back as one hash. The
      # :plugin_flag type carries which hash and which key.
      "avatars" => {
        label: "Avatars",
        description: "Whether people may upload a picture, and whether Gravatar is consulted.",
        fields: [
          ["plugin_openproject_avatars/enable_local_avatars", :plugin_flag, nil,
           "Uploaded avatars", "Let people upload their own picture."],
          ["plugin_openproject_avatars/enable_gravatars", :plugin_flag, nil,
           "Gravatar", "Fall back to the Gravatar service for an address with no uploaded picture."]
        ]
      },
      "work-packages" => {
        label: "Work package settings",
        description: "Instance-wide behaviour of work packages, including how progress is recorded.",
        fields: [
          ["work_package_done_ratio", :enum, :done_ratio_options,
           "Progress tracking", "Whether percentage complete is typed in or derived from the status."],
          ["work_package_list_default_highlighting_mode", :enum, :highlighting_options,
           "Default highlighting", "What colour in a work package table refers to."],
          ["cross_project_work_package_relations", :boolean, nil,
           "Cross-project relations", "Allow relations between work packages in different projects."],
          ["display_subprojects_work_packages", :boolean, nil,
           "Include subproject work", "Show a subproject's work packages in its parent by default."],
          ["work_packages_projects_export_limit", :integer, nil,
           "Export limit", "The most work packages a single export may contain."]
        ]
      },
      "projects" => {
        label: "Project settings",
        description: "Defaults applied when a project is created.",
        fields: [
          ["default_projects_public", :boolean, nil,
           "New projects are public", "Whether a newly created project is visible without membership."],
          ["new_project_user_role_id", :enum, :project_role_options,
           "Creator's role", "The role the creator receives in a project they make."]
        ]
      },
      "languages" => {
        label: "Languages",
        description: "Which languages the interface offers, and which one is the default.",
        fields: [
          ["available_languages", :multi_enum, :language_options,
           "Available languages", "The languages a person may choose from."],
          ["default_language", :enum, :language_options,
           "Default language", "Used until someone chooses their own."]
        ]
      },
      "repositories" => {
        label: "Repositories",
        description: "Which source control systems projects may connect to.",
        fields: [
          ["enabled_scm", :multi_enum, :scm_options,
           "Enabled systems", "The version control systems a project may use."],
          ["repositories_automatic_managed_vendor", :enum, :managed_vendor_options,
           "Automatically managed vendor", "Created for a project without asking, when set."]
        ]
      },
      "emails" => {
        label: "Email notifications",
        description: "How the instance sends mail.",
        fields: [
          ["plain_text_mail", :boolean, nil,
           "Send plain text only", "Omit the HTML part of every email."],
          ["email_delivery_method", :enum, :delivery_method_options,
           "Delivery method", "How mail leaves the instance."]
        ]
      },
      "incoming-emails" => {
        label: "Incoming emails",
        description: "How replies and forwarded mail are turned into work package updates.",
        fields: [
          ["mail_handler_body_delimiters", :text, nil,
           "Truncate after these lines", "One per line. Everything below a match is dropped from the comment."],
          ["mail_handler_ignore_filenames", :text, nil,
           "Ignore these attachments", "One filename per line, such as a signature image."]
        ]
      },
      "aggregation" => {
        label: "Aggregation",
        description: "How closely spaced changes by one person are folded into a single journal entry.",
        fields: [
          ["journal_aggregation_time_minutes", :integer, nil,
           "Aggregation window (minutes)", "Successive edits inside this window become one entry. Also delays webhooks."]
        ]
      },
      "authentication" => {
        label: "Authentication settings",
        description: "How people prove who they are, and how long a session lasts.",
        fields: [
          ["login_required", :boolean, nil,
           "Authentication required", "Refuse anonymous access to everything."],
          ["self_registration", :enum, :self_registration_options,
           "Self-registration", "Whether an account can be created without an administrator."],
          ["password_min_length", :integer, nil,
           "Minimum password length", "Characters required in a password."],
          ["password_active_rules", :multi_enum, :password_rule_options,
           "Password character rules",
           "The kinds of character a password may be required to contain."],
          ["password_min_adhered_rules", :integer, nil,
           "Rules a password must meet",
           "How many of the rules above are required. Zero enforces none of them, "            "so only the minimum length applies."],
          ["brute_force_block_after_failed_logins", :integer, nil,
           "Block after failed attempts", "Consecutive failures before an account is temporarily blocked."],
          ["session_ttl_enabled", :boolean, nil,
           "Expire idle sessions", "End a session after a period of inactivity."],
          ["session_ttl", :integer, nil,
           "Session lifetime (minutes)", "How long an idle session survives."]
        ]
      },
      "calendars" => {
        label: "Calendar subscriptions",
        description: "Whether calendars and feeds can be subscribed to from outside EPM.",
        fields: [
          ["ical_enabled", :boolean, nil,
           "iCalendar subscriptions", "Let people subscribe to a calendar from another application."],
          ["feeds_enabled", :boolean, nil,
           "Atom feeds", "Publish activity as a feed."]
        ]
      }
    }.freeze

    around_action :authenticate!, except: %i[timezones password_policy]
    around_action :authenticate_any!, only: %i[timezones password_policy]
    rescue_from(StandardError) { |error| render_unexpected(error) }

    # The zone names this instance accepts.
    #
    # Not the browser's list: `Intl.supportedValuesOf` reports canonical IANA
    # ids, which for India is Asia/Calcutta, while Rails accepts only
    # Asia/Kolkata. Offering the wrong one produces a picker whose every
    # choice is rejected, so the authority has to be the instance.
    #
    # Readable by any signed-in person, because setting your own timezone is
    # not an administrative act and the list itself is public knowledge.
    def timezones
      render json: {
        timezones: ActiveSupport::TimeZone.all.map { |zone| zone.tzinfo.identifier }.uniq.sort
      }
    end

    # The password policy this instance actually enforces.
    #
    # Readable by any signed-in person, because choosing your own password is
    # not an administrative act, and a rule you are not told about is a rule you
    # can only discover by being rejected.
    #
    # Served so a client can show the requirements *before* someone submits,
    # without restating them. A client that hard-codes them drifts the moment an
    # administrator changes the setting, and then shows a rule nobody enforces
    # or hides one that is. `min_adhered_rules` is the number of `active_rules`
    # a password must satisfy — zero means none of them are required and only
    # the length applies, which is easy to misread as "all of them".
    def password_policy
      evaluator = OpenProject::Passwords::Evaluator
      render json: {
        minLength: evaluator.min_length,
        activeRules: evaluator.active_rules,
        minAdheredRules: evaluator.min_adhered_rules
      }
    end

    def index
      render json: {
        sections: SECTIONS.map { |id, spec| { id: id, label: spec[:label], description: spec[:description] } }
      }
    end

    def show
      spec = SECTIONS[params[:id]]
      return render json: { message: "No such settings section." }, status: :not_found unless spec

      render json: serialize(params[:id], spec)
    end

    def update
      spec = SECTIONS[params[:id]]
      return render json: { message: "No such settings section." }, status: :not_found unless spec

      body = json_body
      changes = {}

      spec[:fields].each do |(name, type, options_source, _label, _help)|
        key = camelize(name)
        next unless body.key?(key)

        value = coerce(key, body[key], type, options_source)

        # Pinned by the instance's own configuration. Sending it back unchanged
        # is fine, because a form round-trips every field it rendered; asking
        # for a different value is refused rather than quietly ignored.
        unless writable?(name)
          next if value == raw_for_compare(name, type)

          return render json: {
            message: "#{camelize(name)} is set by the instance's configuration and cannot be changed here."
          }, status: :unprocessable_entity
        end

        if type == :plugin_flag
          setting, flag = name.split("/")
          # Merged rather than replaced: writing the hash wholesale would drop
          # any key this section does not render.
          merged = (changes[setting] || Setting.send(setting).to_h).merge(flag => value)
          changes[setting] = merged
        else
          changes[name] = value
        end
      end

      unless changes.empty?
        call = Settings::UpdateService.new(user: User.current).call(changes)
        unless call.success?
          return render json: { message: call.errors.full_messages.join(", ") }, status: :unprocessable_entity
        end
      end

      render json: serialize(params[:id], spec)
    end

    private

    # ------------------------------------------------------------------ auth
    # Identical to EpmAdminController's, deliberately: two files that
    # authenticate differently would be two things to audit.

    # Any active person, administrator or not.
    def authenticate_any!
      user = resolve_user
      return render json: { message: "Sign in first." }, status: :unauthorized unless user&.active?

      User.current = user
      yield
    ensure
      User.current = nil
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

    # ------------------------------------------------------------- serialize

    def serialize(id, spec)
      {
        id: id,
        label: spec[:label],
        description: spec[:description],
        fields: spec[:fields].map do |(name, type, options_source, label, help)|
          field = {
            key: camelize(name),
            label: label,
            help: help,
            # How it is stored is EPM's problem, not the browser's: a plugin
            # flag is a boolean as far as anything rendering it is concerned.
            type: (type == :plugin_flag ? "boolean" : type.to_s),
            value: value_for(name, type),
            writable: writable?(name)
          }
          field[:options] = send(options_source) if options_source
          field
        end
      }
    end

    def value_for(name, type)
      if type == :plugin_flag
        setting, key = name.split("/")
        # Cast exactly as the owning module does — OpenProject's own plugin
        # settings form posts "1"/"0", so the stored value is as likely to be
        # a string as a boolean, and `!!"0"` is true.
        return ActiveModel::Type::Boolean.new.cast(Setting.send(setting).to_h[key])
      end

      raw = Setting.send(name)
      case type
      when :plugin_flag
        raise Invalid, "#{key} must be true or false." unless [true, false].include?(value)

        # "1"/"0", the shape the module's own checkbox form posts.
        value ? "1" : "0"
      when :boolean then !!raw
      when :integer then raw.to_i
      when :multi_enum then Array(raw).map(&:to_s)
      when :text then Array(raw).is_a?(Array) && raw.is_a?(Array) ? raw.join("\n") : raw.to_s
      else raw.to_s
      end
    end

    # What `value_for` would produce, for comparing an incoming value against
    # the stored one when the setting is pinned.
    def raw_for_compare(name, type)
      coerce(camelize(name), value_for(name, type), type, nil)
    end

    def writable?(name)
      probe = "#{name.split("/").first}_writable?"
      Setting.respond_to?(probe) ? Setting.send(probe) : true
    end

    # -------------------------------------------------------------- coercion
    # Values reach Settings::UpdateService in the shape OpenProject's own
    # forms post them: "1"/"0" for checkboxes, strings otherwise, arrays for
    # multi-selects.

    def coerce(key, value, type, options_source)
      case type
      when :boolean
        raise Invalid, "#{key} must be true or false." unless [true, false].include?(value)

        value ? "1" : "0"
      when :integer
        integer = Integer(value.to_s, exception: false)
        raise Invalid, "#{key} must be a whole number." if integer.nil?
        raise Invalid, "#{key} cannot be negative." if integer.negative?

        integer.to_s
      when :enum
        choice = value.to_s
        allowed = options_source ? send(options_source).map { |o| o[:value] } : nil
        if allowed && !allowed.include?(choice)
          raise Invalid, "#{choice.inspect} is not a value #{key} accepts."
        end

        choice
      when :multi_enum
        raise Invalid, "#{key} must be a list." unless value.is_a?(Array)

        chosen = value.map(&:to_s)
        allowed = options_source ? send(options_source).map { |o| o[:value] } : nil
        if allowed && (unknown = chosen - allowed).any?
          raise Invalid, "#{unknown.first.inspect} is not a value #{key} accepts."
        end

        chosen
      when :text
        # Stored as an array of lines by OpenProject; presented as a textarea.
        value.to_s.split("\n").map(&:strip).reject(&:empty?)
      else
        value.to_s
      end
    end

    # --------------------------------------------------------------- options

    def language_options
      Redmine::I18n.all_languages.map { |code| { value: code.to_s, label: language_label(code) } }
                   .sort_by { |o| o[:label].downcase }
    end

    def language_label(code)
      # The key OpenProject's own language picker uses (ApplicationHelper
      # #translate_language), so EPM labels a language exactly as it does.
      name = ::I18n.t("cldr.language_name", locale: code.to_s, default: "")
      name.presence || code.to_s
    rescue StandardError
      code.to_s
    end

    def scm_options
      Redmine::SCM::Base.all.map { |name| { value: name.to_s.downcase, label: name.to_s } }
    rescue StandardError
      [{ value: "subversion", label: "Subversion" }, { value: "git", label: "Git" }]
    end

    # The character classes OpenProject can require. Fixed rather than derived:
    # `Setting.password_active_rules` validates against this exact set, so a
    # value outside it is refused on write.
    def password_rule_options
      [
        { value: "lowercase", label: "Lowercase letter" },
        { value: "uppercase", label: "Uppercase letter" },
        { value: "numeric", label: "Number" },
        { value: "special", label: "Symbol" }
      ]
    end

    def managed_vendor_options
      [{ value: "", label: "None" }] + scm_options
    end

    def done_ratio_options
      [
        { value: "field", label: "Work-based — typed on the work package" },
        { value: "status", label: "Status-based — derived from the status" }
      ]
    end

    def highlighting_options
      [
        { value: "inline", label: "Inline" },
        { value: "none", label: "None" },
        { value: "status", label: "Status" },
        { value: "type", label: "Type" },
        { value: "priority", label: "Priority" }
      ]
    end

    def delivery_method_options
      [
        { value: "smtp", label: "SMTP" },
        { value: "sendmail", label: "Sendmail" }
      ]
    end

    def self_registration_options
      [
        { value: "0", label: "Disabled" },
        { value: "1", label: "Account activation by email" },
        { value: "2", label: "Manual account activation" },
        { value: "3", label: "Automatic account activation" }
      ]
    end

    def project_role_options
      ProjectRole.givable.map { |role| { value: role.id.to_s, label: role.name } }
    rescue StandardError
      []
    end

    # ----------------------------------------------------------------- misc

    class Invalid < StandardError; end

    def camelize(name)
      # A plugin flag is named "setting/key"; only the key is addressable.
      parts = name.to_s.split("/").last.split("_")
      ([parts.first] + parts.drop(1).map(&:capitalize)).join
    end

    def json_body
      raw = request.raw_post
      return {} if raw.blank?

      parsed = JSON.parse(raw)
      parsed.is_a?(Hash) ? parsed : {}
    rescue JSON::ParserError
      {}
    end

    def render_unexpected(error)
      if error.is_a?(Invalid)
        render json: { message: error.message }, status: :unprocessable_entity
      else
        Rails.logger.error("EPM admin settings: #{error.class}: #{error.message}")
        render json: { message: "That could not be read." }, status: :internal_server_error
      end
    end
  end
end

Rails.application.routes.prepend do
  scope "epm_admin", defaults: { format: :json } do
    get "timezones", to: "epm_admin_settings#timezones"
    get "password_policy", to: "epm_admin_settings#password_policy"
    get "sections", to: "epm_admin_settings#index"
    get "sections/:id", to: "epm_admin_settings#show", constraints: { id: /[a-z-]+/ }
    patch "sections/:id", to: "epm_admin_settings#update", constraints: { id: /[a-z-]+/ }
  end
end
