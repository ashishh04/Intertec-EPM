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
- **EPM roles and workspaces.** An administrator gives each person a role
  (Manager, HR, Employee or External) on the new Access roles page
  (Administration → Users and permissions). A role brings a bundle of EPM
  permissions, its own workspace on the overview and its own sidebar. Every
  change of role is journalled.
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

### Fixed

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

### Security

- EPM reaches OpenProject as its own service account, `epm-service`, which is
  not an administrator (NFR06), instead of an administrator's key. It may call
  only the EPM add-on actions listed for it.
- A made-up session cookie no longer escapes the rate limit. Sign-in and the
  invitation and password-reset links are limited per address, whatever cookie
  comes with them.
- The link in an invitation or password-reset email is dropped from the
  outbox once the email has gone. A migration clears the emails already sent.
- Request logs never record the token of an invitation or password-reset link.

### Deploying 1.2.0

A server still older than 1.1.0 needs 1.1.0's changes first: OpenProject
17.9.2 on its own database, and API keys issued again (`deploy/runbooks/upgrades.md`).

1. **Back up**, as the runbook says.
2. **Deploy all three images from the 1.2.0 tag together.** This release
   changes the OpenProject add-ons the backend calls (the service account's
   allow-list, and the password and document actions), so a new backend
   beside an old `epm-openproject` cannot accept invitations, send reset
   links or open project documents. The backend applies seven database
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
   The expense-approval cases also need a second account set as the tester's
   line manager.
