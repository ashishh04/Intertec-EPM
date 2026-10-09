# EPM schedule fields: total float, free float and "on critical path".
#
# EPM computes the critical path and float of every scheduled work package
# (BR-101) and keeps them in its own database. It also writes them into three
# work package custom fields, so that OpenProject's query engine — which EPM's
# saved views run on — can show them as columns and filter, sort, group and
# sum on them (BR-103). This script creates those fields, once:
#
#   Total float (days)   integer
#   Free float (days)    integer
#   On critical path     boolean
#
# each for all projects, usable as a filter, and active on every type, so
# every work package can hold them. EPM writes the values; nobody types them.
# `zzz_epm_schedule.rb` finds the fields by these names and keeps them out of
# the journal, so a figure EPM writes never shows in an Activity tab.
#
# Configuration, not a patch: OpenProject's own records through its own models.
# Run on demand:
#
#   docker compose exec -T openproject bundle exec rails runner /app/epm-setup/schedule-fields.rb
#
# (In development, where the file is not in the image yet:
#   docker cp backend/openproject/setup/schedule-fields.rb openproject:/tmp/schedule-fields.rb
#   docker exec openproject bash -lc 'cd /app && bundle exec rails runner /tmp/schedule-fields.rb')
#
# Idempotent. It only ever adds: run it again after creating a type, and the
# new type gets the fields. A field an administrator has changed is left as
# they left it — but renaming one disconnects it from EPM.

FIELDS = [
  { name: "Total float (days)", format: "int" },
  { name: "Free float (days)", format: "int" },
  { name: "On critical path", format: "bool" }
].freeze

ActiveRecord::Base.transaction do
  log = ->(message) { puts "  #{message}" }
  puts "EPM schedule fields"

  fields = FIELDS.map do |spec|
    existing = WorkPackageCustomField.find_by(name: spec[:name])
    if existing
      if existing.field_format != spec[:format]
        raise "#{spec[:name]} exists as a #{existing.field_format} field, not #{spec[:format]}. " \
              "Rename or remove it, then run this again."
      end
      next existing
    end

    WorkPackageCustomField.create!(
      name: spec[:name],
      field_format: spec[:format],
      is_required: false,
      is_for_all: true,
      is_filter: true,
      searchable: false
    ).tap { |field| log.call("custom field #{field.name} created (customField#{field.id})") }
  end

  # Activating a field on a type is what lets a work package of that type hold
  # it. Not `reset_attribute_groups`: that starts by deactivating every field.
  Type.find_each do |type|
    missing = fields.map(&:id) - type.custom_field_ids
    next if missing.empty?

    type.custom_field_ids = type.custom_field_ids + missing
    type.save!
    log.call("#{missing.size} schedule field#{missing.size == 1 ? '' : 's'} added to #{type.name}")
  end

  puts "Done: " + fields.map { |field| "#{field.name} customField#{field.id}" }.join(", ")
end
