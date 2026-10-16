# EPM's automation account: the service principal rules act as (BR-217, NFR06).
#
# A rule's actions — assign, change status, set a field, create a linked work
# package — are writes to OpenProject, and the BRD wants each one in the
# journal under a named service principal rather than under whoever owns the
# API key EPM reads with (an administrator's personal token). This creates that
# principal: a user, "EPM Automation", that nobody signs in as, and a project
# role, "EPM Automation", holding only what rule actions need. It is
# deliberately not an administrator. EPM makes it a member of a project, with
# that role, the first time a rule acts there.
#
# Configuration, not a patch: OpenProject's own records through its own models.
# Run on demand:
#
#   docker compose exec -T openproject bundle exec rails runner /app/epm-setup/automation-account.rb
#
# (In development, where the file is not in the image yet:
#   docker cp backend/openproject/setup/automation-account.rb openproject:/tmp/automation-account.rb
#   docker exec openproject bash -lc 'cd /app && bundle exec rails runner /tmp/automation-account.rb')
#
# The first run prints an API token, once. Put it in EPM's
# OPENPROJECT_AUTOMATION_API_KEY, or in a secret file named by
# OPENPROJECT_AUTOMATION_API_KEY_FILE. Later runs print no token; ROTATE=1
# issues a new one and revokes the old.
#
# Idempotent. It only ever adds, and keeps the role's workflow complete: every
# status change on every type, so a rule can make whichever transition its
# author chose. EPM itself refuses the statuses an approval chain owns.

LOGIN = ENV.fetch("EPM_AUTOMATION_LOGIN", "epm-automation")
MAIL = ENV.fetch("EPM_AUTOMATION_MAIL", "epm-automation@example.com")
ROLE_NAME = "EPM Automation"

# Read work, create it, edit it, move its status, relate it, nest it, comment
# on it and put it in a version — nothing that administers a project.
PERMISSIONS = %i[
  view_project
  view_work_packages
  add_work_packages
  edit_work_packages
  change_work_package_status
  manage_work_package_relations
  manage_subtasks
  add_work_package_comments
  assign_versions
].freeze

token_value = nil

ActiveRecord::Base.transaction do
  log = ->(message) { puts "  #{message}" }
  puts "EPM automation account"

  # --------------------------------------------------------------------- role
  role = ProjectRole.find_by(name: ROLE_NAME)
  if role.nil?
    role = ProjectRole.create!(name: ROLE_NAME, permissions: PERMISSIONS)
    log.call("created role #{ROLE_NAME} ##{role.id}")
  else
    missing = PERMISSIONS - role.permissions.map(&:to_sym)
    if missing.any?
      role.add_permission!(*missing)
      log.call("added #{missing.join(', ')} to role #{ROLE_NAME}")
    end
  end

  # Every transition on every type: a rule's author picks the status.
  statuses = Status.all.to_a
  added = 0
  Type.find_each do |type|
    existing = Workflow.where(role_id: role.id, type_id: type.id)
                       .pluck(:old_status_id, :new_status_id).to_set
    statuses.each do |from|
      statuses.each do |to|
        next if from.id == to.id || existing.include?([from.id, to.id])

        Workflow.create!(role_id: role.id, type_id: type.id, old_status_id: from.id, new_status_id: to.id,
                         author: false, assignee: false)
        added += 1
      end
    end
  end
  log.call("#{added} workflow transitions added") if added.positive?

  # --------------------------------------------------------------------- user
  user = User.find_by(login: LOGIN)
  if user.nil?
    # Nobody signs in as it: the password is random and never shown.
    password = "#{SecureRandom.base64(36)}aA1!"
    user = User.new(login: LOGIN, firstname: "EPM", lastname: "Automation", mail: MAIL,
                    admin: false, language: "en", force_password_change: false)
    user.password = password
    user.password_confirmation = password
    user.activate
    user.save!
    log.call("created user #{LOGIN} ##{user.id}")
  end

  # It acts; it is not told about acting. No reminders, no notifications.
  silent = NotificationSetting.column_names
                              .reject { |name| %w[id project_id user_id created_at updated_at].include?(name) }
                              .to_h { |name| [name, %w[start_date due_date overdue].include?(name) ? nil : false] }
  NotificationSetting.where(user_id: user.id).update_all(silent)

  # ------------------------------------------------------------------- token
  had_token = Token::API.where(user_id: user.id).exists?
  if !had_token || ENV["ROTATE"] == "1"
    Token::API.where(user_id: user.id).destroy_all
    token = Token::API.create!(user: user, token_name: "EPM rules")
    token_value = token.plain_value
    log.call(had_token ? "rotated the API token" : "issued an API token")
  end

  puts "Done: user ##{user.id} (#{LOGIN}), role ##{role.id} (#{ROLE_NAME})"
end

if token_value
  puts ""
  puts "OPENPROJECT_AUTOMATION_API_KEY=#{token_value}"
  puts "Shown once. Put it in EPM's environment or secret store now."
else
  puts "The API token already exists and is not shown again. ROTATE=1 issues a new one."
end
