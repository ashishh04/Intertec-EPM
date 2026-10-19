# Load-test data for NFR01 (Module 20): people, projects and work at the
# modelled scale — by default 500 people and 100,000 work packages in 50
# projects — made through OpenProject's own models, so journals, memberships
# and the schedule are as real use leaves them.
#
# FOR A TEST INSTANCE ONLY. Everything it makes is named with a prefix
# (LOAD_PREFIX, default "lt") and removed by LOAD_ACTION=remove. It is kept out
# of setup/ on purpose: that folder is copied into the production image, and
# this must never be one command away on a production server. It refuses to
# run unless LOAD_CONFIRM names the instance's host.
#
#   docker cp backend/openproject/load-test/load-data.rb openproject:/tmp/load-data.rb
#   docker exec -e LOAD_CONFIRM=<host name> -e LOAD_PASSWORD=<password> openproject \
#     bash -lc 'cd /app && bundle exec rails runner /tmp/load-data.rb'
#
# Settings (environment):
#   LOAD_ACTION    create (default) or remove
#   LOAD_USERS     people to make, default 500 (logins <prefix>-user-001 …)
#   LOAD_PROJECTS  projects, default 50 (identifiers <prefix>-p-01 …)
#   LOAD_TASKS     work packages in all, default 100000, spread evenly
#   LOAD_PASSWORD  every load user's password (OpenProject's password rules apply)
#   LOAD_PREFIX    default "lt"
#   LOAD_SEED      random seed, default 20261019, so two runs make the same plan
#
# What a project holds: every person is a member of three projects (one in
# ten a project admin); each project's work is a tenth parents of five
# children and the rest standalone, dated over the next six months with
# estimates of 2 to 40 hours, assigned among its members; one in five
# standalone items follows the one before it. Re-running create adds only
# what is missing.

ACTION = ENV.fetch("LOAD_ACTION", "create")
PREFIX = ENV.fetch("LOAD_PREFIX", "lt")
USERS = Integer(ENV.fetch("LOAD_USERS", "500"))
PROJECTS = Integer(ENV.fetch("LOAD_PROJECTS", "50"))
TASKS = Integer(ENV.fetch("LOAD_TASKS", "100000"))
SEED = Integer(ENV.fetch("LOAD_SEED", "20261019"))

host = Setting.host_name.to_s
abort "LOAD_CONFIRM must name this instance's host (#{host}) — this makes or removes load-test data." unless ENV["LOAD_CONFIRM"] == host

admin = User.where(admin: true, status: Principal.statuses[:active]).order(:id).first
abort "No active administrator to act as." unless admin
User.current = admin
log = ->(text) { puts "#{Time.now.utc.strftime('%H:%M:%S')}  #{text}"; $stdout.flush }

user_login = ->(n) { format("%s-user-%03d", PREFIX, n) }
project_identifier = ->(n) { format("%s-p-%02d", PREFIX, n) }

if ACTION == "remove"
  projects = Project.where("identifier LIKE ?", "#{PREFIX}-p-%")
  log.("Removing #{projects.count} projects (their work goes with them)")
  projects.find_each { |project| Projects::DeleteService.new(user: admin, model: project).call }
  users = User.where("login LIKE ?", "#{PREFIX}-user-%")
  log.("Removing #{users.count} people")
  users.find_each { |user| Users::DeleteService.new(model: user, user: admin).call }
  log.("Removed. OpenProject finishes deleting in its background jobs.")
  exit 0
end

password = ENV["LOAD_PASSWORD"].to_s
abort "Set LOAD_PASSWORD." if password.empty?
random = Random.new(SEED)

# ------------------------------------------------------------------ people
log.("People: #{USERS}")
people = (1..USERS).map do |n|
  login = user_login.(n)
  User.find_by(login: login) || begin
    user = User.new(login: login, firstname: "Load", lastname: format("User %03d", n),
                    mail: "#{login}@example.invalid", admin: false, language: "en")
    user.password = password
    user.password_confirmation = password
    user.status = Principal.statuses[:active]
    user.save!
    user
  end
end

# ---------------------------------------------------------------- projects
member_role = ProjectRole.where(builtin: Role::NON_BUILTIN).detect { |role| role.permissions.include?(:work_package_assigned) && !role.permissions.include?(:edit_project) }
admin_role = ProjectRole.where(builtin: Role::NON_BUILTIN).detect { |role| role.permissions.include?(:edit_project) && role.permissions.include?(:work_package_assigned) }
abort "Need a project role that can be assigned work, and one that can edit a project." unless member_role && admin_role

log.("Projects: #{PROJECTS}")
projects = (1..PROJECTS).map do |n|
  identifier = project_identifier.(n)
  Project.find_by(identifier: identifier) || begin
    attributes = { name: format("Load Project %02d", n), identifier: identifier, public: false }
    # From OpenProject 17 a project is one kind of workspace, and the model insists on the kind.
    attributes[:workspace_type] = "project" if Project.respond_to?(:workspace_types)
    result = Projects::CreateService.new(user: admin).call(**attributes)
    raise "Project #{identifier}: #{result.errors.full_messages.join(', ')}" unless result.success?
    project = result.result
    project.enabled_module_names = (project.enabled_module_names + %w[work_package_tracking time_tracking costs gantt calendar_view board_view]).uniq
    project.save!
    project
  end
end

log.("Memberships: each person in three projects")
people.each_with_index do |user, index|
  3.times do |k|
    project = projects[(index + k * 17) % projects.size]
    next if Member.exists?(project: project, principal: user)

    role = (index % 10).zero? && k.zero? ? admin_role : member_role
    Members::CreateService.new(user: admin).call(principal: user, project: project, roles: [role])
  end
end

# -------------------------------------------------------------------- work
task_type = Type.find_by(name: "Task") || Type.where(is_milestone: false).order(:position).first
summary_type = Type.find_by(name: "Summary task") || task_type
status = Status.default
priority = IssuePriority.default || IssuePriority.first
per_project = TASKS / projects.size
today = Date.current
made = 0

projects.each_with_index do |project, p|
  have = WorkPackage.where(project: project).count
  next log.("  #{project.identifier}: #{have} already") if have >= per_project

  assignees = Member.where(project: project).includes(:principal).map(&:principal).select { |principal| principal.is_a?(User) }
  previous = nil
  remaining = per_project - have
  while remaining.positive?
    WorkPackage.transaction do
      [remaining, 500].min.times do
        start = today + random.rand(0..180)
        attributes = {
          project: project, author: admin, status: status, priority: priority,
          assigned_to: assignees.sample(random: random),
          start_date: start, due_date: start + random.rand(0..10),
        }
        if remaining >= 6 && random.rand < 0.1 / 0.6
          parent = WorkPackage.create!(attributes.merge(type: summary_type, subject: "Load epic #{p + 1}-#{remaining}"))
          5.times do |c|
            child_start = start + c * 2
            WorkPackage.create!(attributes.merge(type: task_type, parent: parent, subject: "Load task #{p + 1}-#{remaining}-#{c + 1}",
                                                 start_date: child_start, due_date: child_start + 1,
                                                 estimated_hours: random.rand(2..40), assigned_to: assignees.sample(random: random)))
          end
          remaining -= 6
          made += 6
          previous = nil
        else
          work = WorkPackage.create!(attributes.merge(type: task_type, subject: "Load task #{p + 1}-#{remaining}", estimated_hours: random.rand(2..40)))
          Relation.create!(from: work, to: previous, relation_type: Relation::TYPE_FOLLOWS) if previous && random.rand < 0.2
          previous = work
          remaining -= 1
          made += 1
        end
        break if remaining <= 0
      end
    end
  end
  log.("  #{project.identifier}: #{WorkPackage.where(project: project).count} work packages")
end

log.("Done: #{people.size} people, #{projects.size} projects, #{made} work packages made this run.")
