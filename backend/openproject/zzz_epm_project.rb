# EPM: the project settings OpenProject keeps in HTML forms only.
#
# Which modules a project uses, which project attributes it shows, and whether
# it is a template: OpenProject has all three, free, and publishes none of them
# in API v3. This file adds them as JSON endpoints under /epm_project/*:
#
#   GET   /epm_project/projects/:id/modules     { modules: [{ name, enabled }], canEdit }
#   PATCH /epm_project/projects/:id/modules     { enabled: [name] }   -> as GET
#   GET   /epm_project/projects/:id/attributes  { sections: [{ id, name, fields: [...] }], canEdit }
#   PATCH /epm_project/projects/:id/attributes  { customFieldId, enabled } -> as GET
#   PATCH /epm_project/projects/:id/template    { templated }         -> { templated }
#   GET   /epm_project/projects/:id/phases      { phases: [...], canSelect, canEdit, canView }
#   PATCH /epm_project/projects/:id/phases/:definition_id  { active?, startDate?, finishDate? } -> as GET
#   POST  /epm_project/projects/:id/copy        { name, identifier?, parentId?, only: [part] } -> 202 { jobId }
#   GET   /epm_project/projects/:id/abilities   { manageBoards, viewPhases, selectPhases, editPhases, ... }
#
# The copy is API v3's own (POST /api/v3/projects/:id/copy: the same contract,
# service and CopyProjectJob, followed through /api/v3/job_statuses/:jobId)
# without the email OpenProject sends the person when it finishes. That email
# carries OpenProject's name and address, and EPM tells the person itself.
#
# The life-cycle phases (Initiating, Planning, Executing, Closing and their
# gates) are OpenProject's and free to use; turning them on per project and
# dating them is HTML only, hence here (select_project_phases, edit_project_phases).
#
# Unlike the administration add-ons, these act as the caller, identified as
# API v3 identifies them (an OAuth bearer token or `apikey:<key>` Basic auth),
# and go through OpenProject's own services, so its permissions and contracts
# decide: select_project_modules for modules, select_project_custom_fields for
# attributes, and Projects::UpdateService for the template flag (an
# administrator's). A project the caller cannot see is not found.
#
# Internal OpenProject API with no compatibility guarantee: after an upgrade,
# check these still answer (backend/openproject/README.md).

Rails.application.config.to_prepare do
  next if defined?(EpmProjectController)

  # Projects::EnqueueCopyService less its finishing email: the same job in the
  # same kind of batch (CopyProjectJob reads the user and the source project
  # from the batch), with no on_finish callback to send it.
  class EpmQuietCopyService < ::Projects::EnqueueCopyService
    private

    def schedule_copy_job(params)
      job = nil
      GoodJob::Batch.enqueue(user:, source_project: source) do
        job = CopyProjectJob.perform_later(target_project_params: params[:target_project_params],
                                           copy_from_template: params.dig(:target_project_params, :template).present?,
                                           associations_to_copy: params[:only].to_a,
                                           skip_custom_field_validation: params[:skip_custom_field_validation],
                                           send_mails: false)
      end
      job
    end
  end

  class EpmProjectController < ActionController::API
    around_action :authenticate!
    before_action :find_project

    rescue_from StandardError do |error|
      Rails.logger.error("[epm_project] #{error.class}: #{error.message}\n#{error.backtrace&.first(10)&.join("\n")}")
      render json: { message: error.message }, status: :internal_server_error
    end

    rescue_from ActiveRecord::RecordNotFound do
      render json: { message: "Not found." }, status: :not_found
    end

    # ------------------------------------------------------------- modules

    def modules
      render json: modules_json
    end

    def update_modules
      return forbidden unless @user.allowed_in_project?(:select_project_modules, @project)

      available = OpenProject::AccessControl.available_project_modules.map(&:to_s)
      names = Array(json_body["enabled"]).map(&:to_s) & available
      call = Projects::EnabledModulesService.new(model: @project, user: @user).call(enabled_modules: names)
      return render_failure(call) unless call.success?

      @project.reload
      render json: modules_json
    end

    # ---------------------------------------------------------- attributes

    def attributes
      render json: attributes_json
    end

    def update_attributes
      return forbidden unless @user.allowed_in_project?(:select_project_custom_fields, @project)

      body = json_body
      field = ProjectCustomField.visible(@user).find(body["customFieldId"])
      call = ProjectCustomFieldProjectMappings::ToggleService
               .new(user: @user)
               .call(project_id: @project.id, custom_field_id: field.id, value: body["enabled"] ? true : false)
      return render_failure(call) unless call.success?

      @project.reload
      render json: attributes_json
    end

    # -------------------------------------------------------------- phases

    def phases
      render json: phases_json
    end

    # { active } turns a phase on or off (select_project_phases); { startDate,
    # finishDate } sets its dates (edit_project_phases), and OpenProject moves
    # the phases after it as it does in its own form.
    def update_phase
      definition = Project::PhaseDefinition.find(params[:definition_id])
      body = json_body

      if body.key?("active")
        return forbidden unless @user.allowed_in_project?(:select_project_phases, @project)

        call = ProjectPhases::ActivationService
                 .new(user: @user, project: @project, definitions: Project::PhaseDefinition.where(id: definition.id))
                 .call(active: body["active"] ? true : false)
        return render_failure(call) unless call.success?
      end

      if body.key?("startDate") || body.key?("finishDate")
        return forbidden unless @user.allowed_in_project?(:edit_project_phases, @project)

        phase = Project::Phase.find_by(project_id: @project.id, definition_id: definition.id)
        unless phase&.active?
          return render json: { message: "Turn the phase on before giving it dates." }, status: :unprocessable_entity
        end

        attributes = {}
        attributes[:start_date] = body["startDate"].presence if body.key?("startDate")
        attributes[:finish_date] = body["finishDate"].presence if body.key?("finishDate")
        call = ProjectPhases::UpdateService.new(user: @user, model: phase).call(**attributes)
        return render_failure(call) unless call.success?
      end

      @project.reload
      render json: phases_json
    end

    # ------------------------------------------------------------ template

    def update_template
      call = Projects::UpdateService.new(user: @user, model: @project).call(templated: json_body["templated"] ? true : false)
      return render_failure(call) unless call.success?

      render json: { templated: @project.reload.templated? }
    end

    # ----------------------------------------------------------- abilities

    # What the caller may do in this project, for a screen that offers an
    # action before it is tried: each answered by the project's own roles and
    # modules, as the action itself would be.
    def abilities
      render json: {
        manageBoards: @user.allowed_in_project?(:manage_board_views, @project),
        viewPhases: @user.allowed_in_project?(:view_project_phases, @project),
        selectPhases: @user.allowed_in_project?(:select_project_phases, @project),
        editPhases: @user.allowed_in_project?(:edit_project_phases, @project),
        selectModules: @user.allowed_in_project?(:select_project_modules, @project),
        selectAttributes: @user.allowed_in_project?(:select_project_custom_fields, @project),
        copyProject: @user.allowed_in_project?(:copy_projects, @project)
      }
    end

    # ---------------------------------------------------------------- copy

    # `only` names the parts to bring across (members, versions, categories,
    # work_packages, work_package_attachments, wiki, queries, boards, overview,
    # phases, ...); anything not named stays behind. Refused as API v3 refuses:
    # copy_projects here, and the new project's own contract (a free
    # identifier, the right to create it).
    def copy
      return forbidden unless @user.allowed_in_project?(:copy_projects, @project)

      body = json_body
      target = { name: body["name"].to_s }
      target[:identifier] = body["identifier"].to_s if body["identifier"].present?
      target[:parent_id] = body["parentId"].to_i if body["parentId"].present?
      only = Array(body["only"]).map(&:to_s).grep(/\A[a-z_]+\z/)

      call = EpmQuietCopyService.new(user: @user, model: @project)
                                .call(target_project_params: target, only:, send_notifications: false)
      return render_failure(call) unless call.success?

      render json: { jobId: call.result.job_id }, status: :accepted
    end

    private

    def modules_json
      enabled = @project.enabled_module_names.map(&:to_s)
      {
        modules: OpenProject::AccessControl.available_project_modules.map do |name|
          { name: name.to_s, enabled: enabled.include?(name.to_s) }
        end,
        canEdit: @user.allowed_in_project?(:select_project_modules, @project)
      }
    end

    def attributes_json
      enabled_ids = ProjectCustomFieldProjectMapping.where(project_id: @project.id).pluck(:custom_field_id)
      visible_ids = ProjectCustomField.visible(@user, project: @project).pluck(:id)
      sections = ProjectCustomFieldSection.includes(:custom_fields).order(:position).filter_map do |section|
        fields = section.custom_fields.select { |field| visible_ids.include?(field.id) }.sort_by { |field| field.position.to_i }
        next if fields.empty?

        {
          id: section.id,
          name: section.name,
          fields: fields.map do |field|
            {
              id: field.id,
              name: field.name,
              format: field.field_format,
              required: field.is_required?,
              forAll: field.is_for_all?,
              enabled: field.is_for_all? || enabled_ids.include?(field.id)
            }
          end
        }
      end
      { sections:, canEdit: @user.allowed_in_project?(:select_project_custom_fields, @project) }
    end

    def phases_json
      by_definition = Project::Phase.where(project_id: @project.id).index_by(&:definition_id)
      {
        phases: Project::PhaseDefinition.order(:position).map do |definition|
          phase = by_definition[definition.id]
          {
            definitionId: definition.id,
            name: definition.name,
            position: definition.position,
            active: phase&.active? || false,
            startDate: phase&.start_date&.iso8601,
            finishDate: phase&.finish_date&.iso8601,
            startGate: definition.start_gate?,
            startGateName: definition.start_gate? ? definition.start_gate_name : nil,
            finishGate: definition.finish_gate?,
            finishGateName: definition.finish_gate? ? definition.finish_gate_name : nil
          }
        end,
        canSelect: @user.allowed_in_project?(:select_project_phases, @project),
        canEdit: @user.allowed_in_project?(:edit_project_phases, @project),
        canView: @user.allowed_in_project?(:view_project_phases, @project)
      }
    end

    def find_project
      @project = Project.visible(@user).find(params[:id])
    end

    def authenticate!
      @user = resolve_user
      return render(json: { message: "Sign in to continue." }, status: :unauthorized) unless @user&.active?

      User.current = @user
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

    def forbidden
      render json: { message: "You may not change this in this project." }, status: :forbidden
    end

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
  end
end

Rails.application.routes.prepend do
  scope "epm_project", controller: "epm_project", format: false, defaults: { format: :json } do
    get "projects/:id/modules", action: :modules, constraints: { id: /\d+/ }
    patch "projects/:id/modules", action: :update_modules, constraints: { id: /\d+/ }
    get "projects/:id/attributes", action: :attributes, constraints: { id: /\d+/ }
    patch "projects/:id/attributes", action: :update_attributes, constraints: { id: /\d+/ }
    patch "projects/:id/template", action: :update_template, constraints: { id: /\d+/ }
    post "projects/:id/copy", action: :copy, constraints: { id: /\d+/ }
    get "projects/:id/abilities", action: :abilities, constraints: { id: /\d+/ }
    get "projects/:id/phases", action: :phases, constraints: { id: /\d+/ }
    patch "projects/:id/phases/:definition_id", action: :update_phase, constraints: { id: /\d+/, definition_id: /\d+/ }
  end
end
