# EPM's service account (NFR06, Module 1): the principal EPM's own work runs as —
# background jobs, instance-wide reads, the analytics extract, the schedule and
# calculated-field passes, posting approved claims. Until now that was an
# administrator's personal API key; NFR06 wants a service principal scoped to
# the minimum permission set, with its credential in the secret store.
#
# What it makes, through OpenProject's own models:
#   - a user, "EPM Service" (login epm-service), that nobody signs in as and
#     that is NOT an administrator;
#   - a global role, "EPM Service (directory)", with only the instance-wide reads EPM
#     needs: every person in the directory, and their email;
#   - a project role, "EPM Service", that reads a project and writes only what
#     EPM's own work writes (see PROJECT_PERMISSIONS);
#   - membership of every project with that role. New projects get it from
#     the add-on zzz_epm_service.rb as they are created.
# The EPM add-ons admit this account on the endpoints EPM's own work uses, and
# nowhere else (zzz_epm_service.rb, EpmService.allowed?).
#
# Configuration, not a patch. Run on each instance, and again after a role or
# permission change in a release (idempotent: it only ever adds):
#
#   docker compose exec -T openproject bundle exec rails runner /app/epm-setup/service-account.rb
#
# The first run issues an API token. With TOKEN_FILE=<path> it is written to
# that file (mode 600) rather than printed — copy it into EPM's secret store as
# OPENPROJECT_API_KEY (or the file OPENPROJECT_API_KEY_FILE names), then delete
# the file. ROTATE=1 issues a new token and revokes the old.

LOGIN = ENV.fetch("EPM_SERVICE_LOGIN", "epm-service")
MAIL = ENV.fetch("EPM_SERVICE_MAIL", "epm-service@example.invalid")
ROLE_NAME = "EPM Service"
# Global and project roles share one name space in OpenProject.
GLOBAL_ROLE_NAME = "EPM Service (directory)"

GLOBAL_PERMISSIONS = %i[view_all_principals view_user_email].freeze

# Reading a project: everything OpenProject calls view_*, as the analytics
# extract, the portfolio and the directory read across projects. Writing: the
# little EPM's own work writes — memberships for portal access and the
# automation account, and the member list to know who works where.
WRITE_PERMISSIONS = %i[view_project view_members manage_members].freeze

token_value = nil

ActiveRecord::Base.transaction do
  log = ->(message) { puts "  #{message}" }
  puts "EPM service account"

  view_permissions = OpenProject::AccessControl.permissions
                                               .select { |permission| permission.project? && permission.name.to_s.start_with?("view_") }
                                               .map(&:name)
  project_permissions = (view_permissions + WRITE_PERMISSIONS).uniq

  # ------------------------------------------------------------- global role
  global_role = GlobalRole.find_by(name: GLOBAL_ROLE_NAME)
  if global_role.nil?
    global_role = GlobalRole.create!(name: GLOBAL_ROLE_NAME, permissions: GLOBAL_PERMISSIONS)
    log.call("created global role #{GLOBAL_ROLE_NAME} ##{global_role.id}")
  else
    missing = GLOBAL_PERMISSIONS - global_role.permissions.map(&:to_sym)
    global_role.add_permission!(*missing) if missing.any?
  end

  # ------------------------------------------------------------ project role
  role = ProjectRole.find_by(name: ROLE_NAME)
  if role.nil?
    role = ProjectRole.create!(name: ROLE_NAME, permissions: project_permissions)
    log.call("created project role #{ROLE_NAME} ##{role.id} (#{project_permissions.size} permissions)")
  else
    missing = project_permissions - role.permissions.map(&:to_sym)
    if missing.any?
      role.add_permission!(*missing)
      log.call("added #{missing.join(', ')} to role #{ROLE_NAME}")
    end
  end

  # -------------------------------------------------------------------- user
  user = User.find_by(login: LOGIN)
  if user.nil?
    # Nobody signs in as it: the password is random and never shown.
    password = "#{SecureRandom.base64(36)}aA1!"
    user = User.new(login: LOGIN, firstname: "EPM", lastname: "Service", mail: MAIL,
                    admin: false, language: "en", force_password_change: false)
    user.password = password
    user.password_confirmation = password
    user.activate
    user.save!
    log.call("created user #{LOGIN} ##{user.id}")
  end
  abort "#{LOGIN} is an administrator; it must not be. Remove the flag first." if user.admin?

  # A global role is a membership with no project.
  global_member = Member.find_by(project_id: nil, user_id: user.id)
  if global_member.nil?
    Member.create!(project: nil, principal: user, roles: [global_role])
    log.call("gave #{LOGIN} the global role")
  elsif global_member.roles.exclude?(global_role)
    global_member.roles << global_role
    log.call("gave #{LOGIN} the global role")
  end

  # It works; it is not told about working. No reminders, no notifications.
  silent = NotificationSetting.column_names
                              .reject { |name| %w[id project_id user_id created_at updated_at].include?(name) }
                              .to_h { |name| [name, %w[start_date due_date overdue].include?(name) ? nil : false] }
  NotificationSetting.where(user_id: user.id).update_all(silent)

  # ------------------------------------------------------------- membership
  added = 0
  Project.find_each do |project|
    member = Member.find_by(project: project, principal: user)
    if member.nil?
      Member.create!(project: project, principal: user, roles: [role])
      added += 1
    elsif member.roles.exclude?(role)
      member.roles << role
      added += 1
    end
  end
  log.call("member of #{added} more project(s)") if added.positive?

  # ------------------------------------------------------------------ token
  had_token = Token::API.where(user_id: user.id).exists?
  if !had_token || ENV["ROTATE"] == "1"
    Token::API.where(user_id: user.id).destroy_all
    token = Token::API.create!(user: user, token_name: "EPM service")
    token_value = token.plain_value
    log.call(had_token ? "rotated the API token" : "issued an API token")
  end

  puts "Done: user ##{user.id} (#{LOGIN}), global role ##{global_role.id}, project role ##{role.id}, #{Project.count} projects"
end

if token_value
  if ENV["TOKEN_FILE"].to_s.empty?
    puts ""
    puts "OPENPROJECT_API_KEY=#{token_value}"
    puts "Shown once. Put it in EPM's environment or secret store now."
  else
    File.write(ENV["TOKEN_FILE"], token_value, perm: 0o600)
    puts "The API token is in #{ENV['TOKEN_FILE']}. Move it into EPM's secret store and delete the file."
  end
else
  puts "The API token already exists and is not shown again. ROTATE=1 issues a new one."
end
