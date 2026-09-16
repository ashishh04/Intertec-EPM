# EPM: create, edit and delete for the administration catalogues OpenProject's
# REST API only reads.
#
# The third of the EPM initializers, after zzz_epm_admin_api.rb (users
# settings, permissions, roles) and zzz_epm_admin_settings.rb (settings
# sections). API v3 lists types, statuses and priorities but publishes no write
# affordance on any of them, and does not expose custom fields, webhooks or
# OAuth applications at all. They exist upstream only as HTML forms.
#
#   GET    /epm_admin/catalog                 the catalogues this instance serves
#   GET    /epm_admin/catalog/:resource       field descriptors + rows
#   POST   /epm_admin/catalog/:resource       one row
#   PATCH  /epm_admin/catalog/:resource/:id   one row
#   DELETE /epm_admin/catalog/:resource/:id   204, or 422 with the reason
#
# Self-describing in the same way the settings sections are: the response
# carries the field list, so EPM renders a table and a form from the descriptor
# and a catalogue gains a column here without a change in the browser.
#
# What is deliberately absent: anything the instance's licence gates. Custom
# actions, attribute help texts, project attributes, LDAP, SAML and OpenID are
# Enterprise features, and an endpoint that always answered 403 would be worse
# than no endpoint. `GET /epm_admin/catalog` reports what this instance can
# actually serve so EPM can say so rather than offer a dead page.
#
# Admin only, authenticated as API v3 authenticates. Writes go through each
# model's own validations, so a duplicate name or a type still in use is
# refused the way OpenProject refuses it.
#
# Internal OpenProject API, no compatibility guarantee. Verify after an upgrade.

Rails.application.config.to_prepare do
  next if defined?(EpmAdminCatalogController)

  class EpmAdminCatalogController < ActionController::API
    class Invalid < StandardError; end
    class Refused < StandardError; end

    around_action :authenticate!
    rescue_from(StandardError) { |error| render_error(error) }

    # Each catalogue: the model, how a row is shown, and the writable fields.
    # `guard` names a method that refuses a delete, returning a sentence or nil.
    def self.catalogues
      {
        "types" => {
          label: "Types",
          singular: "type",
          description: "The kinds of work package a project can create.",
          model: -> { Type },
          order: -> { Type.order(:position) },
          delete_guard: :type_deletable?,
          fields: [
            { key: "name", label: "Name", type: "string", required: true },
            { key: "isMilestone", label: "Milestone", type: "boolean",
              help: "A milestone marks a date rather than a span of work." },
            { key: "isDefault", label: "Active by default", type: "boolean",
              help: "Enabled in a project the moment it is created." },
            { key: "isInRoadmap", label: "Show in roadmap", type: "boolean" },
            { key: "colorId", label: "Colour", type: "enum", options: :color_options }
          ]
        },
        "statuses" => {
          label: "Statuses",
          singular: "status",
          description: "The states a work package moves through.",
          model: -> { Status },
          order: -> { Status.order(:position) },
          delete_guard: :status_deletable?,
          fields: [
            { key: "name", label: "Name", type: "string", required: true },
            { key: "isClosed", label: "Closed", type: "boolean",
              help: "Work in this status counts as finished." },
            { key: "isDefault", label: "Default", type: "boolean",
              help: "Given to a new work package. Only one status can hold this." },
            { key: "isReadonly", label: "Read-only", type: "boolean",
              help: "Locks a work package's fields while it sits here." },
            { key: "defaultDoneRatio", label: "% complete", type: "integer",
              help: "Applied when progress is derived from the status." },
            { key: "colorId", label: "Colour", type: "enum", options: :color_options }
          ]
        },
        "priorities" => {
          label: "Priorities",
          singular: "priority",
          description: "How urgent a work package is.",
          model: -> { IssuePriority },
          order: -> { IssuePriority.order(:position) },
          delete_guard: :priority_deletable?,
          fields: [
            { key: "name", label: "Name", type: "string", required: true },
            { key: "isDefault", label: "Default", type: "boolean",
              help: "Given to a new work package. Only one priority can hold this." },
            { key: "active", label: "Active", type: "boolean",
              help: "An inactive priority stays on existing work but cannot be chosen." },
            { key: "colorId", label: "Colour", type: "enum", options: :color_options }
          ]
        },
        "webhooks" => {
          label: "Webhooks",
          singular: "webhook",
          description: "Where this instance posts when records change.",
          model: -> { ::Webhooks::Webhook },
          order: -> { ::Webhooks::Webhook.order(:name) },
          fields: [
            { key: "name", label: "Name", type: "string", required: true },
            { key: "url", label: "Payload URL", type: "string", required: true,
              help: "Where the POST is sent." },
            { key: "description", label: "Description", type: "text" },
            { key: "secret", label: "Signature secret", type: "string",
              help: "Signs each delivery so the receiver can prove it came from here.", write_only: true },
            { key: "enabled", label: "Enabled", type: "boolean" },
            { key: "allProjects", label: "All projects", type: "boolean",
              help: "Deliver for every project rather than a chosen few." }
          ]
        },
        "oauth-applications" => {
          label: "OAuth applications",
          singular: "application",
          description: "Applications allowed to act on a person's behalf.",
          model: -> { Doorkeeper::Application },
          order: -> { Doorkeeper::Application.order(:name) },
          fields: [
            { key: "name", label: "Name", type: "string", required: true },
            { key: "redirectUri", label: "Redirect URI", type: "text", required: true,
              help: "One per line. Where the person is returned after approving." },
            { key: "confidential", label: "Confidential", type: "boolean",
              help: "The application can keep a secret. Off for single-page and mobile apps." },
            { key: "scopes", label: "Scopes", type: "string",
              help: "Space separated, for example api_v3." }
          ]
        },
        "custom-fields" => {
          label: "Custom fields",
          singular: "custom field",
          description: "Extra attributes on work packages.",
          model: -> { CustomField },
          order: -> { WorkPackageCustomField.order(:position) },
          fields: [
            { key: "name", label: "Name", type: "string", required: true },
            { key: "fieldFormat", label: "Format", type: "enum", options: :format_options,
              required: true, help: "What kind of value it holds. Cannot change once in use." },
            { key: "possibleValues", label: "Possible values", type: "text",
              help: "One per line. Only for a list." },
            { key: "isRequired", label: "Required", type: "boolean" },
            { key: "isForAll", label: "For all projects", type: "boolean",
              help: "Available everywhere rather than enabled per project." },
            { key: "isFilter", label: "Usable as a filter", type: "boolean" }
          ]
        }
      }
    end

    # ---------------------------------------------------------------- actions

    def index
      render json: {
        catalogues: self.class.catalogues.map do |id, spec|
          { id: id, label: spec[:label], singular: spec[:singular], description: spec[:description] }
        end
      }
    end

    def show
      spec = spec!(params[:resource])
      render json: {
        resource: params[:resource],
        label: spec[:label],
        singular: spec[:singular],
        description: spec[:description],
        fields: describe_fields(spec),
        rows: spec[:order].call.map { |record| serialize(record, spec) }
      }
    end

    def create
      spec = spec!(params[:resource])
      record = build(spec)
      assign(record, spec, json_body)
      save!(record)
      render json: serialize(record, spec), status: :created
    end

    def update
      spec = spec!(params[:resource])
      record = find!(spec, params[:id])
      assign(record, spec, json_body)
      save!(record)
      render json: serialize(record, spec)
    end

    def destroy
      spec = spec!(params[:resource])
      record = find!(spec, params[:id])

      if spec[:delete_guard] && (reason = send(spec[:delete_guard], record))
        raise Refused, reason
      end

      record.destroy!
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
      case request.authorization.to_s
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

    # ------------------------------------------------------------- machinery

    def spec!(resource)
      self.class.catalogues[resource] or
        raise ActiveRecord::RecordNotFound, "No such catalogue."
    end

    def build(spec)
      # A work package custom field is the only kind this edits; the base class
      # is abstract about what it belongs to.
      spec[:model].call == CustomField ? WorkPackageCustomField.new : spec[:model].call.new
    end

    def find!(spec, id)
      scope = spec[:model].call == CustomField ? WorkPackageCustomField : spec[:model].call
      scope.find(id)
    end

    def describe_fields(spec)
      spec[:fields].map do |field|
        # camelCase throughout, so the browser reads one convention.
        described = field.except(:options).transform_keys { |k| camelize_key(k) }
        described["options"] = send(field[:options]) if field[:options]
        described
      end
    end

    def serialize(record, spec)
      row = { "id" => record.id.to_s }
      spec[:fields].each do |field|
        next if field[:write_only]

        row[field[:key]] = read_attribute(record, field)
      end
      # Whether a row may be removed, and why not, belongs with the row: the
      # browser should not have to know each catalogue's rules to grey a button.
      if spec[:delete_guard]
        reason = send(spec[:delete_guard], record)
        row["deletable"] = reason.nil?
        row["undeletableReason"] = reason if reason
      else
        row["deletable"] = true
      end
      row
    end

    def read_attribute(record, field)
      name = underscore(field[:key])
      value = record.public_send(name) if record.respond_to?(name)

      case field[:type]
      when "boolean" then !!value
      when "integer" then value.to_i
      when "text"
        # A custom field's possible values are CustomOption records, not
        # strings; asking each for its value is what makes the textarea show
        # the options rather than the association's inspect output.
        if value.respond_to?(:map) && !value.is_a?(String)
          value.map { |item| item.respond_to?(:value) ? item.value : item.to_s }.join("\n")
        else
          value.to_s
        end
      else
        value.nil? ? "" : value.to_s
      end
    end

    def assign(record, spec, body)
      spec[:fields].each do |field|
        key = field[:key]
        next unless body.key?(key)

        value = coerce(field, body[key])
        name = underscore(key)
        next unless record.respond_to?("#{name}=")

        record.public_send("#{name}=", value)
      end
    end

    def coerce(field, value)
      case field[:type]
      when "boolean"
        raise Invalid, "#{field[:key]} must be true or false." unless [true, false].include?(value)

        value
      when "integer"
        return nil if value.nil? || value.to_s.strip.empty?

        number = Integer(value.to_s, exception: false)
        raise Invalid, "#{field[:key]} must be a whole number." if number.nil?

        number
      when "text"
        # possibleValues and redirectUri are line-separated lists upstream.
        lines = value.to_s.split("\n").map(&:strip).reject(&:empty?)
        field[:key] == "possibleValues" ? lines : value.to_s
      when "enum"
        choice = value.to_s
        return nil if choice.empty?

        allowed = field[:options] ? send(field[:options]).map { |o| o[:value] } : nil
        raise Invalid, "#{choice.inspect} is not a value #{field[:key]} accepts." if allowed && !allowed.include?(choice)

        choice
      else
        value.to_s
      end
    end

    def save!(record)
      return if record.save

      raise Invalid, record.errors.full_messages.join(", ")
    end

    # ---------------------------------------------------------- delete rules
    # Each returns a sentence explaining the refusal, or nil when it may go.

    def type_deletable?(type)
      return "#{type.name} is a standard type and cannot be removed." if type.is_standard?

      count = WorkPackage.where(type_id: type.id).count
      return "#{type.name} is still used by #{count} work #{'package'.pluralize(count)}." if count.positive?

      nil
    end

    def status_deletable?(status)
      return "#{status.name} is the default status." if status.is_default?

      count = WorkPackage.where(status_id: status.id).count
      return "#{status.name} is still used by #{count} work #{'package'.pluralize(count)}." if count.positive?

      nil
    end

    def priority_deletable?(priority)
      return "#{priority.name} is the default priority." if priority.is_default?

      count = WorkPackage.where(priority_id: priority.id).count
      return "#{priority.name} is still used by #{count} work #{'package'.pluralize(count)}." if count.positive?

      nil
    end

    # --------------------------------------------------------------- options

    def color_options
      [{ value: "", label: "None" }] +
        Color.order(:name).map do |color|
          # The hex travels with the option so the browser can draw the colour
          # instead of only naming it.
          { value: color.id.to_s, label: color.name, hex: color.hexcode }
        end
    rescue StandardError
      [{ value: "", label: "None" }]
    end

    def format_options
      # The formats a work package custom field can take, as OpenProject names
      # them. Deliberately not the full list: the exotic ones need extra
      # attributes this form does not collect.
      [
        { value: "string", label: "Text" },
        { value: "text", label: "Long text" },
        { value: "int", label: "Integer" },
        { value: "float", label: "Float" },
        { value: "list", label: "List" },
        { value: "date", label: "Date" },
        { value: "bool", label: "Boolean" },
        { value: "user", label: "User" },
        { value: "version", label: "Version" }
      ]
    end

    # ------------------------------------------------------------------ misc

    def camelize_key(key)
      parts = key.to_s.split("_")
      ([parts.first] + parts.drop(1).map(&:capitalize)).join
    end

    def underscore(key)
      key.to_s.gsub(/([a-z\d])([A-Z])/) { "#{Regexp.last_match(1)}_#{Regexp.last_match(2)}" }.downcase
    end

    def json_body
      raw = request.raw_post
      return {} if raw.blank?

      parsed = JSON.parse(raw)
      parsed.is_a?(Hash) ? parsed : {}
    rescue JSON::ParserError
      {}
    end

    def render_error(error)
      case error
      when Invalid
        render json: { message: error.message }, status: :unprocessable_entity
      when Refused
        render json: { message: error.message }, status: :unprocessable_entity
      when ActiveRecord::RecordNotFound
        render json: { message: "That does not exist." }, status: :not_found
      when ActiveRecord::RecordInvalid
        render json: { message: error.record.errors.full_messages.join(", ") }, status: :unprocessable_entity
      else
        Rails.logger.error("EPM admin catalog: #{error.class}: #{error.message}")
        render json: { message: "That could not be completed." }, status: :internal_server_error
      end
    end
  end
end

Rails.application.routes.prepend do
  scope "epm_admin", defaults: { format: :json } do
    get "catalog", to: "epm_admin_catalog#index"
    get "catalog/:resource", to: "epm_admin_catalog#show", constraints: { resource: /[a-z-]+/ }
    post "catalog/:resource", to: "epm_admin_catalog#create", constraints: { resource: /[a-z-]+/ }
    patch "catalog/:resource/:id", to: "epm_admin_catalog#update",
                                   constraints: { resource: /[a-z-]+/, id: /\d+/ }
    delete "catalog/:resource/:id", to: "epm_admin_catalog#destroy",
                                    constraints: { resource: /[a-z-]+/, id: /\d+/ }
  end
end
