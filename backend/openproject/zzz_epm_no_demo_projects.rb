# EPM: OpenProject's demo projects are never seeded.
#
# Every container start runs `db:seed`, and OpenProject seeds its demo projects
# ("Demo project", "Scrum project", their work, boards, meetings and wiki)
# whenever the instance has no project at all: DemoData::ProjectsSeeder's
# `applicable?` is `Project.count.zero?`. So a server whose last project had
# been deleted got the demo content back on its next restart. On the deployed
# server that seed then failed; the whole seed is one transaction, so it rolled
# back, the container exited, and OpenProject restarted in a loop with nobody
# able to sign in to EPM (November 2026).
#
# EPM never wants the demo projects, on a new server or an old one, so the
# seeder never applies. Basic data — statuses, types, roles, the admin — is
# seeded as before; only the demo projects, and the overview pages that need
# them, are skipped.
#
# Internal OpenProject API with no compatibility guarantee. After an upgrade,
# check that this still finds the seeder (it logs a warning when it cannot).

module EpmNoDemoProjects
  def applicable?
    false
  end
end

Rails.application.config.to_prepare do
  # By name, so a renamed seeder in a later OpenProject leaves a warning in the
  # log rather than a container that cannot start.
  seeder = "DemoData::ProjectsSeeder".safe_constantize
  if seeder
    seeder.prepend(EpmNoDemoProjects)
  else
    Rails.logger.warn("EPM: DemoData::ProjectsSeeder not found; an instance with no projects may be seeded with demo projects.")
  end
end
