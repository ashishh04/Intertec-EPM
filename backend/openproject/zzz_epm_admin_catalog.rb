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
            # Since 17.9 this is the base variant's, not the type's: the
            # column moved to type_variants.enabled_in_new_projects.
            { key: "isDefault", label: "Active by default", type: "boolean",
              variant: "enabled_in_new_projects",
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
            { key: "active", label: "Active", type: "boolean", default: true,
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
          # The instance's own built-in applications (its mobile app) are not
          # listed: they cannot be edited here, and they are the instance's,
          # not anything an EPM administrator set up.
          order: lambda {
            scope = Doorkeeper::Application.order(:name)
            Doorkeeper::Application.column_names.include?("builtin") ? scope.where(builtin: false) : scope
          },
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
            { key: "isForAll", label: "For all projects", type: "boolean", default: true,
              help: "Available everywhere rather than enabled per project." },
            { key: "projectIds", label: "Projects", type: "multi", options: :project_options, link: :link_projects,
              help: "The projects that have it, when it is not for all projects." },
            { key: "typeIds", label: "Types", type: "multi", options: :type_options,
              read: :linked_type_ids, link: :link_types, empty_label: "Every type",
              help: "The kinds of work package that have it. A task can hold a value only if its type has the field." },
            { key: "isFilter", label: "Usable as a filter", type: "boolean", default: true }
          ]
        },
        # Project attributes: fields every project can carry, grouped in sections.
        # Free in OpenProject except three formats (hierarchy, weighted item list,
        # calculated value), which are not offered. Which projects show one that is
        # not for all projects is chosen per project (zzz_epm_project.rb).
        "project-attributes" => {
          label: "Project attributes",
          singular: "project attribute",
          description: "Fields every project can carry, such as a cost centre, a sponsor or a business unit, grouped in sections.",
          model: -> { ProjectCustomField },
          order: -> { ProjectCustomField.order(:custom_field_section_id, :position) },
          fields: [
            { key: "name", label: "Name", type: "string", required: true },
            { key: "fieldFormat", label: "Format", type: "enum", options: :project_format_options,
              required: true, help: "What kind of value it holds. Cannot change once in use." },
            { key: "possibleValues", label: "Possible values", type: "text",
              help: "One per line. Only for a list." },
            { key: "multiValue", label: "Several values", type: "boolean",
              help: "Lets a project hold more than one of the possible values. Only for a list or a user." },
            { key: "isRequired", label: "Required", type: "boolean" },
            { key: "isForAll", label: "For all projects", type: "boolean",
              help: "Shown in every project. Otherwise each project chooses whether to show it." },
            { key: "customFieldSectionId", label: "Section", type: "enum", options: :project_section_options,
              required: true, help: "The heading it is listed under on a project." },
            { key: "adminOnly", label: "Administrators only", type: "boolean",
              help: "Only administrators can see or change it." }
          ]
        },
        # The instance's user custom fields, under the name its newer releases
        # give them. `build` and `find!` take the model as given here, so these
        # rows are UserCustomField and never touch the work package fields.
        "user-attributes" => {
          label: "User attributes",
          singular: "user attribute",
          description: "Extra information kept on each person's profile, such as a job title or a skill.",
          model: -> { UserCustomField },
          order: -> { UserCustomField.order(:position) },
          fields: [
            { key: "name", label: "Name", type: "string", required: true },
            { key: "fieldFormat", label: "Format", type: "enum", options: :user_format_options,
              required: true, help: "What kind of value it holds. Cannot change once in use." },
            { key: "possibleValues", label: "Possible values", type: "text",
              help: "One per line. Only for a list." },
            { key: "multiValue", label: "Several values", type: "boolean",
              help: "Lets a person hold more than one of the possible values. Only for a list." },
            { key: "isRequired", label: "Required", type: "boolean",
              help: "Everyone must have a value. Not available for a yes/no attribute." },
            { key: "adminOnly", label: "Administrators only", type: "boolean",
              help: "Only administrators can see or change it." },
            { key: "editable", label: "Editable by the person", type: "boolean",
              help: "People can change their own value." }
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
      write!(record, spec, json_body)
      render json: serialize(record, spec), status: :created
    end

    def update
      spec = spec!(params[:resource])
      record = find!(spec, params[:id])
      write!(record, spec, json_body)
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
      unless user&.active? && (user.admin? || (defined?(EpmService) && EpmService.allowed?(user, self)))
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
      model = spec[:model].call
      # A work package custom field is the only kind this edits; the base class
      # is abstract about what it belongs to.
      return WorkPackageCustomField.new if model == CustomField

      record = model.new
      # A project attribute is listed under a section. Left unchosen, it goes
      # under the first one (made on first use); a chosen one replaces it.
      if model == ProjectCustomField
        project_section_options
        record.custom_field_section_id = ProjectCustomFieldSection.order(:position).first&.id
      end
      record
    end

    def find!(spec, id)
      scope = spec[:model].call == CustomField ? WorkPackageCustomField : spec[:model].call
      scope.find(id)
    end

    def describe_fields(spec)
      spec[:fields].map do |field|
        # camelCase throughout, so the browser reads one convention. `read` and
        # `link` name methods here, which are nobody's business but this file's.
        described = field.except(:options, :read, :link).transform_keys { |k| camelize_key(k) }
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
      value =
        if field[:variant]
          record.default_variant&.public_send(field[:variant])
        elsif field[:read]
          send(field[:read], record)
        elsif record.respond_to?(name)
          record.public_send(name)
        end

      case field[:type]
      when "boolean" then !!value
      when "integer" then value.to_i
      when "multi" then Array(value).map(&:to_s)
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

    # A row and whatever it holds through other tables, which needs it saved
    # first: both or neither.
    def write!(record, spec, body)
      assign(record, spec, body)
      ActiveRecord::Base.transaction do
        save!(record)
        spec[:fields].each do |field|
          next unless field[:link] && body.key?(field[:key])

          send(field[:link], record, coerce(field, body[field[:key]]))
        end
      end
      record.reload if spec[:fields].any? { |field| field[:link] }
    end

    def assign(record, spec, body)
      spec[:fields].each do |field|
        key = field[:key]
        next unless body.key?(key) && !field[:link]

        value = coerce(field, body[key])
        if field[:variant]
          # Built here on create, so the type's own before_validation sees a
          # base variant already and does not add a second one. Saved with the
          # type: `variants` is autosaved.
          variant = record.default_variant || record.variants.build(is_default_variant: true, variant_name: nil)
          variant.public_send("#{field[:variant]}=", value)
          next
        end

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
      when "multi"
        chosen = Array(value).map(&:to_s).uniq
        unknown = chosen - send(field[:options]).map { |option| option[:value] }
        raise Invalid, "#{unknown.first.inspect} is not a value #{field[:key]} accepts." if unknown.any?

        chosen
      else
        value.to_s
      end
    end

    def save!(record)
      return if record.save

      raise Invalid, record.errors.full_messages.join(", ")
    end

    # ------------------------------------------------- what a custom field is on

    # A custom field reaches a work package only through its type and, unless it
    # is for all projects, its project. API v3 can set neither, and without these
    # a field made here existed but never reached a form, a filter value or an
    # export.

    def linked_type_ids(field)
      field.type_variants.map(&:type_id).uniq.sort
    end

    # As EpmCalculatedController#configure: from 17 fields belong to a type's
    # variants, not the type, so every variant of a chosen type gets the field and
    # every other variant loses it. None chosen means every type, as there.
    def link_types(field, ids)
      wanted = ids.empty? ? Type.pluck(:id) : ids.map(&:to_i)
      TypeVariant.find_each do |variant|
        has = variant.custom_field_ids.include?(field.id)
        want = wanted.include?(variant.type_id)
        next if has == want

        # Not `reset_attribute_groups`: that starts by deactivating every field.
        variant.custom_field_ids = want ? variant.custom_field_ids + [field.id] : variant.custom_field_ids - [field.id]
        variant.save!
      end
    end

    def link_projects(field, ids)
      if ids.empty? && !field.is_for_all?
        raise Invalid, "Choose the projects that have this field, or make it for all projects."
      end

      field.project_ids = ids.map(&:to_i)
    end

    # ---------------------------------------------------------- delete rules
    # Each returns a sentence explaining the refusal, or nil when it may go.

    def type_deletable?(type)
      # Standard types went with 17.9's type variants; kept for older instances.
      return "#{type.name} is a standard type and cannot be removed." if type.respond_to?(:is_standard?) && type.is_standard?

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

    def type_options
      Type.order(:position).map { |type| { value: type.id.to_s, label: type.name } }
    end

    def project_options
      Project.active.order(:name).map { |project| { value: project.id.to_s, label: project.name } }
    end

    # The formats a project attribute can take: those free in this edition.
    def project_format_options
      [
        { value: "string", label: "Text" },
        { value: "text", label: "Long text" },
        { value: "int", label: "Integer" },
        { value: "float", label: "Float" },
        { value: "list", label: "List" },
        { value: "date", label: "Date" },
        { value: "bool", label: "Boolean" },
        { value: "user", label: "User" },
        { value: "version", label: "Version" },
        { value: "link", label: "Link (URL)" }
      ]
    end

    # The sections project attributes are listed under. A first one is made when
    # there is none, so the first attribute has somewhere to go.
    def project_section_options
      ProjectCustomFieldSection.create!(name: "Project attributes") if ProjectCustomFieldSection.none?
      ProjectCustomFieldSection.order(:position).map { |section| { value: section.id.to_s, label: section.name } }
    end

    # The formats a user custom field can take: the instance offers user,
    # version and link only to work packages, projects and time entries.
    def user_format_options
      [
        { value: "string", label: "Text" },
        { value: "text", label: "Long text" },
        { value: "int", label: "Integer" },
        { value: "float", label: "Float" },
        { value: "list", label: "List" },
        { value: "date", label: "Date" },
        { value: "bool", label: "Boolean" }
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
