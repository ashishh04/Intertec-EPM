# EPM: cost types and cost entries, which API v3 cannot create.
#
# OpenProject's Costs module has cost types — a category with a unit and a
# rate in force from a date — and cost entries: units of a cost type logged
# against a work package. Its budgets count them as spent and its cost reports
# list them. API v3 on 15.5.1 reads one cost entry, or a work package's, but
# creates neither and lists no cost types. EPM's expense claims (Module 10,
# BR-307 to BR-309) are claimed under a cost type and, once approved, become a
# cost entry, so this file adds:
#
#   GET    /epm_admin/costs/types          every cost type in use, with today's rate
#   POST   /epm_admin/costs/types          { name, unit, unitPlural, rate } -> the type
#   GET    /epm_admin/costs/entries/:id    one cost entry
#   POST   /epm_admin/costs/entries        { workPackageId, userId, costTypeId, units, spentOn, comments?, overriddenCosts? }
#   DELETE /epm_admin/costs/entries/:id    204
#
# Admin only, identified exactly as API v3 identifies a caller. Entries are made
# the way OpenProject's own "Log unit costs" form makes them (CostlogController):
# a CostEntry for the work package's project, for the given user, logged by the
# caller (the model sets that itself), saved through the model so its
# validations hold — the user must be a member of the project — and its costs
# come from the rate in force on the day; an amount given is kept as
# overridden_costs, as the form keeps a figure typed over the computed one.

Rails.application.config.to_prepare do
  next if defined?(EpmCostsController)

  class EpmCostsController < ActionController::API
    around_action :authenticate!

    # Rails tries handlers last-declared first, so the catch-all goes first.
    rescue_from StandardError do |error|
      Rails.logger.error("[epm_costs] #{error.class}: #{error.message}\n#{error.backtrace&.first(10)&.join("\n")}")
      render json: { message: error.message }, status: :internal_server_error
    end

    rescue_from ActiveRecord::RecordNotFound do
      render json: { message: "Not found." }, status: :not_found
    end

    def types
      list = CostType.where(deleted_at: nil).order(:name).map { |type| type_json(type) }
      render json: { types: list }
    end

    def create_type
      body = json_body
      name = body["name"].to_s.strip
      unit = body["unit"].to_s.strip
      unit_plural = (body["unitPlural"].presence || unit).to_s.strip
      rate = Float(body["rate"], exception: false)

      return render json: { message: "A name is required." }, status: :unprocessable_entity if name.blank?
      return render json: { message: "A unit is required." }, status: :unprocessable_entity if unit.blank?
      return render json: { message: "The rate must be a number." }, status: :unprocessable_entity if rate.nil? || rate.negative?

      type = CostType.new(name: name, unit: unit, unit_plural: unit_plural, default: false)
      type.rates.build(rate: rate, valid_from: Date.new(2000, 1, 1))
      unless type.save
        return render json: { message: type.errors.full_messages.join(", ").presence || "The cost type was refused." },
                      status: :unprocessable_entity
      end
      render json: type_json(type.reload), status: :created
    end

    def entry
      render json: entry_json(CostEntry.find(params[:id]))
    end

    def create_entry
      body = json_body
      work_package = WorkPackage.find_by(id: body["workPackageId"])
      user = User.find_by(id: body["userId"])
      cost_type = CostType.find_by(id: body["costTypeId"])
      units = Float(body["units"], exception: false)
      spent_on = begin
        Date.iso8601(body["spentOn"].to_s)
      rescue ArgumentError, TypeError
        nil
      end

      return render json: { message: "No such work package." }, status: :unprocessable_entity if work_package.nil?
      return render json: { message: "No such user." }, status: :unprocessable_entity if user.nil?
      return render json: { message: "No such cost type." }, status: :unprocessable_entity if cost_type.nil? || cost_type.deleted_at.present?
      return render json: { message: "units must be a number." }, status: :unprocessable_entity if units.nil?
      return render json: { message: "spentOn must be a calendar date." }, status: :unprocessable_entity if spent_on.nil?

      entry = CostEntry.new
      entry.project = work_package.project
      entry.work_package = work_package
      entry.user = user
      entry.cost_type = cost_type
      entry.units = units
      entry.spent_on = spent_on
      entry.comments = body["comments"].to_s[0, 255].presence
      overridden = Float(body["overriddenCosts"], exception: false) if body.key?("overriddenCosts")
      entry.overridden_costs = overridden unless overridden.nil?

      unless entry.save
        return render json: { message: entry.errors.full_messages.join(", ").presence || "The cost entry was refused." },
                      status: :unprocessable_entity
      end
      render json: entry_json(entry.reload), status: :created
    end

    def destroy_entry
      CostEntry.find(params[:id]).destroy!
      head :no_content
    end

    private

    def type_json(type)
      rate = type.rate_at(Time.zone.today)
      {
        id: type.id,
        name: type.name,
        unit: type.unit,
        unitPlural: type.unit_plural,
        rate: rate&.rate&.to_f,
        default: type.is_default?
      }
    end

    def entry_json(entry)
      {
        id: entry.id,
        projectId: entry.project_id,
        workPackageId: entry.work_package_id,
        userId: entry.user_id,
        loggedById: entry.logged_by_id,
        costTypeId: entry.cost_type_id,
        units: entry.units.to_f,
        costs: (entry.overridden_costs || entry.costs)&.to_f,
        spentOn: entry.spent_on&.iso8601,
        comments: entry.comments
      }
    end

    def json_body
      raw = request.raw_post.to_s
      raw.blank? ? {} : JSON.parse(raw)
    rescue JSON::ParserError
      {}
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
  scope "epm_admin/costs", controller: "epm_costs", format: false, defaults: { format: :json } do
    get "types", action: :types
    post "types", action: :create_type
    get "entries/:id", action: :entry
    post "entries", action: :create_entry
    delete "entries/:id", action: :destroy_entry
  end
end
