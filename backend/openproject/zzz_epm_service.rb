# frozen_string_literal: true

# EPM's service account in OpenProject (NFR06, Module 1).
#
# EPM's own work — background jobs, instance-wide reads, the analytics
# extract, the schedule and calculated-field passes, posting approved claims —
# runs as one non-administrator account, "epm-service", made by
# setup/service-account.rb. This file does the two things that account needs
# from inside OpenProject:
#
#   1. Admits it to the EPM add-ons' endpoints that EPM's own work uses, and to
#      no others. Every add-on still admits administrators as before; for this
#      account it asks EpmService.allowed?. Nothing else in OpenProject changes:
#      everywhere else it is an ordinary user with its two roles.
#   2. Makes it a member of every new project, with its project role, so the
#      instance-wide reads keep seeing every project without an administrator
#      adding it.
#
# Identified by its login (EPM_SERVICE_LOGIN, default epm-service), and only
# while it is active and not an administrator.

module EpmService
  ROLE_NAME = "EPM Service"

  # Controller => the actions EPM's own work calls. Anything not here is
  # refused to the service account, whatever the add-on.
  ALLOWED = {
    "EpmAnalyticsController" => %w[summary journals cost_entries],
    "EpmScheduleController" => %w[network fingerprint values],
    "EpmCalculatedController" => %w[fields configure inputs fingerprint values],
    "EpmCostsController" => %w[types create_type entry create_entry destroy_entry],
    "EpmAdminController" => %w[roles administrators],
    # Only the custom fields that calculated fields are mirrored into.
    "EpmAdminCatalogController" => { resource: "custom-fields", actions: %w[show create update destroy] }
  }.freeze

  module_function

  def login
    ENV.fetch("EPM_SERVICE_LOGIN", "epm-service")
  end

  def principal?(user)
    user.is_a?(User) && user.active? && !user.admin? && user.login == login
  end

  # Whether the service account may call this action of this controller.
  def allowed?(user, controller)
    return false unless principal?(user)

    rule = ALLOWED[controller.class.name]
    case rule
    when Array then rule.include?(controller.action_name)
    when Hash then rule[:actions].include?(controller.action_name) && controller.params[:resource].to_s == rule[:resource]
    else false
    end
  end

  # Adds the service account to a project with its role; quiet if either is missing.
  def join(project)
    user = User.find_by(login: login)
    role = ProjectRole.find_by(name: ROLE_NAME)
    return unless user && role && principal?(user)
    return if Member.exists?(project: project, principal: user)

    Member.create!(project: project, principal: user, roles: [role])
  rescue StandardError => e
    Rails.logger.warn("EPM service account not added to project #{project&.id}: #{e.message}")
  end
end

Rails.application.config.to_prepare do
  Project.class_eval do
    after_create_commit { EpmService.join(self) } unless method_defined?(:epm_service_joined)
    define_method(:epm_service_joined) { true }
  end
end
