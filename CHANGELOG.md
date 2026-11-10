# Release notes

What changed in each release of EPM, and what to do when deploying it. The
steps to deploy any release (back up, pull, up, check, roll back) are in
`deploy/runbooks/upgrades.md`; `DEPLOY.md` has the one-time setup.

## 1.2.0 (to be tagged)

Changes since 1.1.0 (21 October 2026).

### New

- **Delivery forecasts** (Insights → Forecasts; BR-509, BR-510). A model
  learnt from the organisation's own finished work says how likely each
  active project is to finish by its planned date, the range it will most
  likely finish in, and its effort and cost at completion against budget,
  naming the work that decides the finish. Forecasts refresh every six hours,
  and every forecast can be reproduced exactly from what it was made from.
  A back-test checks the model against what actually happened. It needs
  real finished work to judge: until there is enough, it says so and how much
  is needed.
- **Recommended actions** (BR-511, BR-512). The forecasts lead to recommended
  changes: re-plan an unlikely finish, set a budget the likely cost will
  pass, re-date the work that decides the finish. Each cites its evidence and
  expected effect. Nothing changes until someone allowed to make the change
  approves it; approvals and rejections are journalled.
- **EPM roles.** An administrator gives each person a role (Manager, HR,
  Employee or External) on the new Access roles page (Administration → Users
  and permissions). A role brings a bundle of EPM permissions, its own
  sidebar and its own Overview. Every change of role is journalled.
- **Forgotten passwords.** "Forgot password?" on the sign-in page now emails a
  link to choose a new password. The link works once, within 60 minutes, and
  using it signs the person out everywhere. Administrator accounts are not
  reset by email: the administrator is emailed why, and another administrator
  resets it.
- **Pragnya** analyses risk and budget exposure, naming the evidence behind
  each finding (BR-501, BR-502). It also reads forecasts and recommended
  actions, and offers each role only the tools that role uses. It can never
  approve a recommendation.
- **Integration events** (BR-506). Events from OpenProject are kept, retried
  and, if they keep failing, set aside, then replayed from the Integration
  page once the cause is fixed. An outage loses nothing.
- **Two-factor authentication.** A code from an authenticator app (Microsoft
  Authenticator, Google Authenticator, Authy and the like) when signing in, so a
  stolen password alone is not enough. Anyone can turn it on in Settings →
  Security or in the portal, with recovery codes for a lost phone. An
  administrator can require it per role, and sees who has set it up, under
  Administration → Authentication → Two-factor authentication. Off until
  someone turns it on or requires it.

### Improved

- Project members can open the documents filed under their project, not only
  the person who uploaded them.
- The calendar loads a month in one to three seconds instead of seven to ten,
  and its week and day views draw at once. Work sits on its deadline.
- Forecasts and back-tests take a fraction of the time on a large history, and
  keep working past about 120,000 finished work packages.
- The Forecasts page pages its projects (most at risk first) and its
  recommended actions (waiting for a decision, and decided).
- Bulk "Change status" and "Change priority" offer the instance's own values.
  A board card moves the moment it is dropped.
- Whoever may add expense categories can add one from the claim dialog.
- Resending an invitation marks the earlier link as replaced, and its page
  says to use the newer email.
- Shorter action labels across the app ("Add comment", "Add member").
- The Projects page sorts: newest or oldest first, by name either way, or by
  due date. Newest first is still the default, and the choice is remembered
  in that browser.
- The Overview follows the role. An administrator sees the workspace (people,
  invitations, the connection, recent changes), a manager projects and people
  (approvals, over-allocation, project health, delivery), HR people and
  timesheets (last week's outstanding timesheets, approvals), and an employee
  their own work, time and expense claims. Someone who has arranged their
  Overview keeps it; Reset returns to the role's.
- Tasks → Import reads a work package export as it is, even after a
  spreadsheet has opened and saved it again, and in Windows-1252 or UTF-16 as
  well as UTF-8. Each person the file names who cannot be given its tasks is
  listed once, not on every row, with "Add to project" for someone with an
  account and "Import without them" for the rest (their cells left blank on new
  tasks, and as they are on tasks being updated). Spent time is logged on each
  new task as one entry, for its assignee on its finish date, under the
  timesheet rules. New rows repeating an earlier one under the same parent are
  flagged, and the same export uploaded again updates the tasks it made instead
  of copying them a second time.
- The sidebar reads more easily: darker links and headings, 13px text and
  larger icons. Buttons are flat violet instead of the crimson-to-violet
  gradient, and so are the active link's bar and the selected tab's underline.

### Fixed

- Create task offers what the chosen project's own form allows: its statuses,
  priorities and sprints, not a fixed list and every project's sprints.
- A custom field can be put on types and projects in Administration, so it
  reaches forms, exports and filters, which use its name and its choices.
- A saved view keeps its sort and comes back after a reload.
- Someone who may only read a task is offered no way to change it, and a task or
  project they cannot see shows the not-found page instead of an error.
- New Task and Import offer only projects where the person may create tasks.
- Deleting a task a series is made from ends the series, and Recurring work reads
  "None: finished" for it. One deleted template no longer costs every series in
  the project its name.
- A formula over a limit is refused naming that limit, with all the limits stated,
  however long it is. Recalculate now says when it starts and finishes, and a
  field's counts no longer count empties as values.
- Moving a task reports the tasks that follow it, counted on the working calendar.
- Levelling no longer proposes moves of no working days, and Undo puts every date
  back or says it could not, without leaving the work half undone.
- Scheduled reports and profiles offer Asia/Dubai, and a schedule reads "Every
  Monday at 07:00 (Asia/Dubai)".
- My Time names the week it shows. Submit timesheet stays on a draft, greyed
  while something stops it, with the reason under it.
- Tabs, menus and selects mirror properly in Arabic, and a changed language no
  longer comes back from the cached copy after a reload.
- The cash-flow table ends in a total, a project's confidence is never better than
  its delivery status, and a forecast with no hour priced shows the hours and the
  budget rather than comparing them.
- Pragnya keeps a stopped reply as far as it got, runs its lookups late in a long
  conversation instead of answering from memory, accepts a project by name, gives
  money in the right currency, and links EPM pages. With finance off, money is
  removed from what it reads. Its chips and refusals follow the reader's language.
- Roles have Save changes and Reset, and the Users page removes someone in the same
  steps as the Employees page. Removing external access asks first. A team or person
  on something archived keeps it when saved unchanged. EPM's own roles are no longer
  offered. The Project Status export says whether health was overridden.
- An invited person can set their password on a server that runs on the
  service account (it failed there before).
- Changing your own password works again. It now asks for your current
  password, which OpenProject 17 requires, and a person given a starting
  password enters that one first.
- A cancelled request no longer leaves every page showing no projects for up
  to 20 seconds.
- "Run a back-test" gave no sign it had run. It now runs in the background,
  says when it finishes and, when history is short, how much there is.
- Administrators who were not listed in `EPM_ADMIN_USER_IDS` now get the
  journal and rates permissions.
- The client portal lists, and downloads, the documents the team files under a
  project. It showed external people only what they had uploaded themselves.
- A file uploaded from the client portal no longer stops the Documents page,
  and the project's Documents tab, from opening ("This page could not be
  displayed"). Files already uploaded that way show again, grouped by type.
- Administration's Calculated fields, Earned value and Working days pages open
  for an administrator on a server with no projects yet. They refused with "You
  do not have permission to view work packages".
- Administration → Authentication → Settings opens again ("These settings could
  not be loaded"). OpenProject 17 dropped the setting for how many password
  rules must be met: every rule ticked is now required.
- Deleting a server's last project no longer stops OpenProject from starting.
  On its next restart it tried to put its demo projects back, failed, and kept
  restarting, so nobody could sign in. The demo projects are never seeded now.
- Changing what an external role allows now applies to the people who already
  hold it, not only to those given it afterwards.
- A health override with a misspelt field is refused. It cleared every
  override on the project and answered as if it had worked.
- A role that is not a project role is refused when changing a member's roles,
  and a filter or sort sent to rename a saved view is refused, with the reason
  in both cases; they failed as server errors.
- Deleting a selection of no tasks is refused instead of answering as if it had
  deleted them.

### Security

- Pages refused by role are refused by the server too. They hid the data on
  screen while the API still answered. Forecasts and recommendations are for
  Administrators and Managers. The employee directory is for those who look after
  the organisation, though everyone can read their own record. Others see names
  and pictures rather than addresses, departments by name only, and a portfolio
  with none of their projects in it reads as if it did not exist.
- EPM reaches OpenProject as its own service account, `epm-service`, which is
  not an administrator (NFR06), instead of an administrator's key. It may call
  only the EPM add-on actions listed for it.
- A made-up session cookie no longer escapes the rate limit. Sign-in and the
  invitation and password-reset links are limited per address, whatever cookie
  comes with them.
- The link in an invitation or password-reset email is dropped from the
  outbox once the email has gone. A migration clears the emails already sent.
- Request logs never record the token of an invitation or password-reset link.
- The value lists behind form pickers can be fetched only for the lists forms
  use. The lookup could be aimed at other collections on the server.
- An id in an address can no longer hold a path (an encoded `/`), which could
  reach a different kind of record outside EPM's own rules and journal.
- A portfolio view no longer tells its reader how many projects exist that
  they cannot see, or which ones.
- The administration information, the readiness check, two cost measures and
  a validation message no longer name the system underneath.

### Deploying 1.2.0

A server still older than 1.1.0 needs 1.1.0's changes first: OpenProject
17.9.2 on its own database, and API keys issued again (`deploy/runbooks/upgrades.md`).

1. **Back up**, as the runbook says.
2. **Deploy all three images from the 1.2.0 tag together.** This release
   changes the OpenProject add-ons the backend calls (the service account's
   allow-list, the password and document actions, and the custom field and time
   zone lists), so a new backend beside an old `epm-openproject` cannot accept
   invitations, send reset links, open project documents or put a custom field
   on a type. The backend applies eight database
   migrations as it starts; nothing else needs running.
3. **Switch to the service account**, if the server still uses an
   administrator's key. Create it and read its key as `DEPLOY.md` describes
   ("After the very first `up`", step 1). Set `OPENPROJECT_API_KEY` in
   `.env.prod` to that key, run `up -d` again, then revoke the
   administrator's key.
4. **Email.** Invitations and password resets need real delivery: SMTP or
   Resend in `.env.prod` (`DEPLOY.md`, "Email"). Without it, the
   forgot-password page tells people reset by email is not set up on this
   server.
   **Set `EPM_MFA_KEY`** (`openssl rand -hex 32`) and back it up, before anyone
   turns on two-factor authentication: changing it later breaks every
   authenticator (`deploy/runbooks/secret-rotation.md`).
5. **The assistant**, to switch it on: Amazon Bedrock in us-east-1, with the
   model enabled and the instance role allowed `bedrock-mantle:CreateInference`
   (`DEPLOY.md`, "The assistant").
6. **Check:**
   - `/ready` answers;
   - an administrator signs in and sees Access roles;
   - a reset link sent to yourself arrives and works;
   - an invitation can be accepted;
   - a document filed under a project opens for another member.

   Then ask for the UI test cases that failed on 27 October to be run again.
7. **Before going live**, clear what testing left behind (`DEPLOY.md`,
   "Clearing test data").
   The expense-approval cases also need a second account set as the tester's
   line manager.
