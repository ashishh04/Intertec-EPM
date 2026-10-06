# EPM governance types: Change Request and Risk.
#
# The BRD treats change control and the risk register as things a delivery
# platform holds "by configuration" — work package types with their own
# statuses and workflow. OpenProject can hold them; nothing on a fresh instance
# does, and EPM's catalogue can create a type but not give it a workflow or
# enable it in existing projects. This script does all three, once.
#
# It is configuration, not a patch: it writes OpenProject's own records through
# its own models, the way an administrator would through the admin pages, and
# is not loaded at boot. Run it on demand:
#
#   docker compose exec -T openproject bundle exec rails runner /app/epm-setup/governance-types.rb
#
# (In development, where the file is not in the image yet:
#   docker cp backend/openproject/setup/governance-types.rb openproject:/tmp/governance-types.rb
#   docker exec openproject bash -lc 'cd /app && bundle exec rails runner /tmp/governance-types.rb')
#
# Idempotent. A second run creates nothing, and it only ever adds: an existing
# type, status, field or workflow transition an administrator has changed is
# left as they left it.

ActiveRecord::Base.transaction do
  log = ->(message) { puts "  #{message}" }
  puts "EPM governance types"

  # ------------------------------------------------------------------ statuses
  # Two statuses change control needs and the stock list lacks. Open, not
  # closed: a change awaiting a decision, or approved and not yet done, is work
  # in flight.
  next_position = -> { (Status.maximum(:position) || 0) + 1 }
  status = lambda do |name, closed: false|
    found = Status.find_by(name: name)
    next found if found

    created = Status.create!(name: name, is_closed: closed, position: next_position.call)
    log.call("status #{name} created")
    created
  end

  new_s        = Status.find_by!(is_default: true)
  pending      = status.call("Pending approval")
  approved     = status.call("Approved")
  in_progress  = Status.find_by(name: "In progress") || status.call("In progress")
  on_hold      = Status.find_by(name: "On hold") || status.call("On hold")
  closed       = Status.find_by(name: "Closed") || status.call("Closed", closed: true)
  rejected     = Status.find_by(name: "Rejected") || status.call("Rejected", closed: true)

  # --------------------------------------------------------------------- types
  color = ->(name) { Color.find_by(name: name) }
  type = lambda do |name, color_name, description|
    found = Type.find_by(name: name)
    next found if found

    created = Type.create!(
      name: name,
      position: (Type.maximum(:position) || 0) + 1,
      is_in_roadmap: false,
      is_milestone: false,
      # Enabled in every project created from now on, not only in the ones
      # that exist today.
      is_default: true,
      color: color.call(color_name),
      description: description
    )
    log.call("type #{name} created")
    created
  end

  change_request = type.call("Change Request", "Orange",
                             "A proposed change to scope, schedule or budget, decided through an approval chain.")
  risk = type.call("Risk", "Red",
                   "Something that may happen and would hurt delivery. Priority is its severity.")

  # Enabled in every project, so a project manager can raise either at once.
  Project.find_each do |project|
    added = [change_request, risk].reject { |t| project.types.include?(t) }
    next if added.empty?

    project.types << added
    log.call("enabled #{added.map(&:name).join(' and ')} in #{project.identifier}")
  end

  # ------------------------------------------------------------- custom field
  # The figure an approval chain's value threshold is measured against.
  change_value = WorkPackageCustomField.find_by(name: "Change value") ||
                 WorkPackageCustomField.create!(
                   name: "Change value",
                   field_format: "float",
                   is_required: false,
                   is_for_all: true,
                   is_filter: true,
                   searchable: false,
                   editable: true
                 ).tap { log.call("custom field Change value created") }

  unless change_request.custom_field_ids.include?(change_value.id)
    # Activating the field is what makes it writable on the type, and a type on
    # the default form shows every active field without being told to. Not
    # `reset_attribute_groups`: that starts by deactivating every custom field.
    change_request.custom_field_ids = change_request.custom_field_ids + [change_value.id]
    change_request.save!
    log.call("Change value added to Change Request")
  end

  # ------------------------------------------------------------------ workflow
  # The roles that can move a Task are the ones that can move these too.
  task = Type.find_by(name: "Task") || Type.order(:position).first
  role_ids = Workflow.where(type_id: task.id).distinct.pluck(:role_id)

  transitions = lambda do |for_type, pairs|
    added = 0
    role_ids.each do |role_id|
      pairs.each do |from, to|
        next if Workflow.exists?(type_id: for_type.id, role_id: role_id, old_status_id: from.id, new_status_id: to.id)

        Workflow.create!(type_id: for_type.id, role_id: role_id, old_status_id: from.id, new_status_id: to.id)
        added += 1
      end
    end
    log.call("#{added} workflow transitions added to #{for_type.name}") if added.positive?
  end

  # Change control: drafted, submitted, decided, then delivered. Approved and
  # Rejected are reached through EPM's approval chain, which refuses to let
  # anyone set them by hand; the transitions exist so the chain can.
  cr_states = [new_s, pending, approved, rejected, in_progress, on_hold, closed]
  transitions.call(change_request, cr_states.map { |s| [s, s] } + [
    [new_s, pending], [new_s, rejected],
    [pending, new_s], [pending, approved], [pending, rejected],
    [approved, in_progress], [approved, closed],
    [in_progress, on_hold], [in_progress, closed],
    [on_hold, in_progress], [on_hold, closed],
    [rejected, new_s],
    [closed, in_progress]
  ])

  # A risk is worked like a task: open, being mitigated, on hold, closed or
  # rejected as not a risk after all. Copied from the Task workflow.
  Workflow.where(type_id: task.id).find_each do |row|
    next if Workflow.exists?(type_id: risk.id, role_id: row.role_id,
                             old_status_id: row.old_status_id, new_status_id: row.new_status_id)

    Workflow.create!(type_id: risk.id, role_id: row.role_id, old_status_id: row.old_status_id,
                     new_status_id: row.new_status_id, author: row.author, assignee: row.assignee)
  end

  puts "Done: Change Request ##{change_request.id}, Risk ##{risk.id}, Change value customField#{change_value.id}, " \
       "Pending approval ##{pending.id}, Approved ##{approved.id}, Rejected ##{rejected.id}"
end
