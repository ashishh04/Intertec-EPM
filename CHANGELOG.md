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
- **EPM roles.** An administrator gives each person a role on the new Access
  roles page (Administration → Users and permissions): BU Head, Portfolio
  Manager, Program Manager, Project Manager, Delivery Manager, Manager,
  Employee or External. Each follows project management practice: the BU Head
  heads a business unit's departments, portfolios and intake; the Portfolio
  Manager chooses and balances the work; the Program Manager runs a program's
  projects together; the Project Manager runs projects through their life
  cycle; the Delivery Manager sees delivery, staffing and everyone's timesheets
  across projects and teams. A role brings a bundle of EPM permissions, its own
  sidebar and its own Overview. Every change of role is journalled. The HR role
  is gone: whoever held it is now a Delivery Manager, who looks after people's
  timesheets, and the departments are the BU Head's.
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
- **Risk register** (Delivery → Risk register). Every risk in the projects a
  person can see, scored on a five-by-five matrix of probability and impact,
  with its category, response (avoid, mitigate, transfer, accept or escalate),
  mitigation and contingency plans and a review date. A heat map narrows the
  list to one square; the worst risks come first, and a risk past its review
  date says so. A risk is a work item of the Risk type, so its owner, status
  and comments are where they always are, and its priority follows its rating,
  so the dashboards and project health count it the same way. Every assessment
  is journalled.
- **Manager dashboard** (Insights → Dashboards). Cost against budget and effort
  against estimate, late work, the milestones coming up and missed, and high
  risks; then each project with its health, the upcoming milestones, budget
  tracking and the open high risks. Dashboards is now a group in the sidebar
  that opens to the Portfolio dashboard, the Manager dashboard and Resource
  utilisation; the other dashboards stay as tabs on the page. A new measure,
  Effort used, is hours logged against hours estimated.
- **Milestones** (Delivery → Milestones). Every project's milestones on one
  timeline, each with its project's schedule health and progress: overdue, due
  in the next 30 days, upcoming or completed, with a line for today. The
  timeline shows three, six or twelve months, moved with the arrows, or fits
  every milestone shown.
- **The Create menu** is a grid of everything that can be started from
  anywhere: project, task, timesheet, expense, sprint, meeting, announcement
  and wiki page; the apps (portfolio status, project status, risk); and a
  client. Each is offered only to people who may go on to create it.
- **Status reports** on projects and portfolios: how it stands overall and on
  schedule, budget, scope and resources, with what was achieved, what comes
  next and what is in the way. The latest shows on the project's Overview and
  the portfolio's page, with the earlier ones a click away. A project's report
  also sets its status in the delivery system, so the two never disagree.
- **Repeating meetings.** A meeting can repeat every day, weekday, week, two
  weeks or month, until a date or with no end (scheduled six months ahead and
  topped up). Each occurrence keeps its own agenda, minutes and attendance, and
  a series can be ended after any meeting in it.
- **Agenda items, and tasks on the agenda.** A meeting's agenda is a list of
  items, each with a time, a presenter and notes, and each may be about a
  task, shown with its status as it stands. A task lists the meetings it is
  discussed in.
- **Favourite projects.** Star a project to keep it first on the Projects page,
  with a Favourites filter. Everyone has their own.
- **A timer.** Start a timer on a task; it runs in the header until stopped,
  which logs the time it ran under the usual timesheet rules, or discarded.
- **Sprint sharing.** A sprint can be shared with its sub-projects, its
  hierarchy, its whole tree or every project, so they can plan work into it.
- **Reserved project identifiers.** An administrator can keep an identifier
  back for a project to come (Administration → Work packages → Identifiers);
  anyone else typing it into a project form is told it is reserved and what
  for. The identifiers the delivery system refuses are flagged as you type.
- **Tasks as cards.** The Tasks page and a project's Tasks tab can show the
  result as cards as well as a table.
- **Programs** (Insights → Programs). Related projects run together, between a
  portfolio and its projects. Each program adds up its projects (as many as
  the reader can see): their health, how far they have got and their budget. A
  project is in at most one, set on its Overview or the program's page by
  whoever runs programs (managers and administrators), and every move is in
  the project's history.
- **A project's own Dashboard and Roadmap.** The Dashboard tab shows any of the
  dashboards for that one project. The Roadmap tab lists its sprints and
  releases, including those shared from another project, with the work planned
  into each, how much of it is done and its points.
- **Project settings** (a project's Settings tab, for whoever may edit it):
  switch its modules on and off (a module switched off takes its tab away),
  choose which of the organisation's project attributes it shows, make it a
  template, and set its life cycle: switch the Initiating, Planning, Executing
  and Closing phases on and date them. Later phases move when an earlier one's
  dates change.
- **Project attributes** (Administration → Projects → Project attributes).
  Fields every project can carry, such as a cost centre or a sponsor, grouped
  in sections, each shown on every project or chosen project by project. Their
  values are set and shown on the project's Overview.
- **Project templates.** Create → Project → Start from a template makes the new
  project a copy of it, bringing across what is chosen: its work, versions and
  sprints, members, boards, saved views, categories, overview, life cycle and
  wiki.
- **Boards of every kind** (a project's Board tab, and Delivery → Boards). Next
  to the task board every project has, a project can have boards of its own:
  basic boards, whose lists hold what is put in them in the order it is put
  there, and boards whose columns are statuses, people, versions, sub-projects
  or parent tasks. Dragging a card into a column gives the task that value (a
  new status, assignee, version, project or parent); dragging within a column
  orders it. Columns are added, removed and reordered, and a board renamed or
  deleted, by whoever manages boards in the project.
- **The backlog** (a project's Backlog tab). The project's open work in no
  sprint, in order, beside the sprints it can plan into. Dragging ranks the
  backlog and plans work into a sprint or back out of it. Each sprint shows its
  points against the project's velocity, the average finished in its last
  three sprints.
- **Impediments.** Something in the way of a sprint is raised on the project's
  Sprint tab, blocking the tasks it holds up. It shows with them until it is
  resolved.
- **Project requests** (Work → Project requests, or Create → Project request).
  Anyone can propose a project: what it is for, the business case, a sponsor,
  where it would sit, which template it would start from, its budget and
  dates. The approval chain for project requests decides it. Once approved,
  someone who may create projects turns it into one in a click, blank or as a
  copy of the template, with its portfolio, program, budget and dates set.
- **Stage gates.** Each gate between the phases of a project's life cycle is
  passed through the approval chain for stage gates, asked for from the
  project's Settings tab or Create → Stage gate approval, with the case for
  passing it. Each gate shows whether it is waiting, passed or not passed, and
  every decision is in the project's history.
- **Internal comments.** A task's comments can be marked internal: only the
  organisation's own people see them, never a client or a vendor. They sit in
  the discussion with an Internal mark.
- **The Gantt chart as a PDF** (a project's Gantt tab → Export PDF): every task
  on a time scale, milestones and today marked, in the reader's language.
- **Atom feeds** (Settings → Feeds): your notifications, or the activity of a
  project you are a member of, in any feed reader. The address holds a secret
  of your own, shown once; making a new one ends the old.
- **Teams & clients.** The Teams page has two tabs: internal teams, and
  external clients, each client with a contact email and phone and an account
  manager. A team can be made a client and back, and a name or code is unique
  across both.
- **Two-factor authentication.** A code from an authenticator app (Microsoft
  Authenticator, Google Authenticator, Authy and the like) when signing in, so a
  stolen password alone is not enough. Anyone can turn it on in Settings →
  Security or in the portal, with recovery codes for a lost phone. An
  administrator can require it per role, and sees who has set it up, under
  Administration → Authentication → Two-factor authentication. Off until
  someone turns it on or requires it.

- **Effort in project health.** A fifth criterion measures the hours logged on
  a project against the work planned on it (the tasks' estimates), phased over
  the planned dates as the budget is. Logging time now shows in a project's
  health whether or not anybody has an hourly rate or the project a budget,
  and the project's page shows it as soon as it is reopened. Health rules
  never saved use it at full weight; rules an administrator saved keep their
  weights, and show effort as "Not counted" until it is given one
  (Administration → Health rules).

- **Task categories.** Every task can say what kind of work it is: Analysis,
  Design, Development, Testing, Review, Documentation, Deployment, Support or
  Management. Set it when creating a task or on the task's page; filter by it
  in My Work and on boards (Filter → Category) and on the Tasks page (add the
  "Work category" filter or column); task rows show it. A reviewer's queue is
  then the review tasks. It is one list for every project, made by EPM the
  first time the backend starts; an administrator can add or remove choices in
  Administration → Custom fields, keeping the field's name.
- **Log time asks what the time was for:** Project work, Scrums & meetings, or
  Support. Meetings and support need no task: they go on the project's own
  "Scrums & meetings" or "Support" task, made the first time anyone logs that
  kind of time there, and take the instance's Meeting or Support activity where
  it has one. Somebody who may not add tasks to the project is told to ask
  whoever runs it, once.
- **Time on no project.** Under Scrums & meetings, Log time asks which meeting:
  the Daily scrum, a Follow-up, or a Project meeting. A daily scrum, a
  follow-up and support need no project: the time is the person's own, and
  counts in their week, timesheet, utilisation and the capacity heatmap (not
  billable), and in no project's spend or health. Chosen with a project, it goes
  on that project's own task as before, marked as the kind of meeting it was.
  A project meeting still needs its project. Only its owner changes or deletes
  such time, under the same locks and policies as any other.
- **Review work is for managers.** Review and Management tasks (any category
  named with either word) are done by whoever leads the work: the BU Head,
  Portfolio, Program, Project and Delivery Managers, Managers and
  administrators. Anyone else sees them in Log time, marked "Managers only",
  and cannot log time on them, start a timer on them or complete them; the
  server refuses it too, saying why. Log time lists a project's tasks
  category by category.
- **Microsoft Project plans in and out** (Tasks → Import and Export). Import
  reads a plan from Microsoft Project (.mpp, the .mpt template, the older .mpx,
  or one saved as XML): the outline becomes parents and subtasks, summary tasks
  phases and milestones milestones, with the dates, work, progress, notes, the
  person with most work on each task, and the finish-to-start dependencies.
  Every task keeps the plan's dates. It is checked and shown before anything
  is made, like any import, and a plan imported again updates the tasks it
  made. Export writes the project as a Microsoft Project file (.mpp), or as
  Microsoft Project XML, which Microsoft Project opens and saves as .mpp: both
  with the outline, dates, dependencies and their lags, work, progress, notes,
  assignees and the working calendar. Each task links back to its work
  package, so the plan, edited and saved as .mpp or XML, imports back onto the
  same tasks. Writing .mpp needs the Aspose.Tasks licence on the server (see
  Deploying): .mpp is Microsoft's closed format, and no free library writes it.
  Until the licence is set, Export shows .mpp as not available, says why, and
  offers the XML.

### Improved

- **Users shows each person's two-factor authentication.** A new MFA column
  says Enabled (with the date on hover, and whether codes are locked), Not
  enabled, or Required, not set up where the person's role must use it. Each
  person's profile shows the same. With sessions now ending after inactivity,
  Last login follows use: people sign in at least once a day.
- **Faster pages that stay current without a reload.**
  - Whole collections are read from the delivery system four pages at a time
    instead of one after another: sprints, a team's logged time, members,
    people. 473 work packages took 5 seconds instead of 23 from a cold start.
  - After a change, whoever made it sees it on their next look. Everyone else
    is answered at once from what the server kept, and their page fetches the
    current version a few seconds later by itself. The server marks such an
    answer and the browser asks again.
  - Dashboard figures, the activity feed, project counts, the people directory
    and the list of statuses and types no longer make a page wait each time
    they expire (every 20 seconds to 10 minutes). The kept copy is answered at
    once and refreshed behind. A change by one person no longer empties
    everyone's copies.
  - The project and sprint lists are fetched in the background after signing
    in, so the first visit to Projects, Agile or a Sprint tab opens on them.
  - The first visit downloads a third less: 292 kB instead of 460 kB.
    - The charts load only with the pages that draw them. A shared helper had
      made every page load them, the sign-in page included.
    - The app's files are served compressed in advance with Brotli.
- **Up and down through a list's tasks.** A task opened from a task list (a
  project's Tasks tab, the Tasks page) has up and down arrows in its header,
  shows where it stands ("3 of 15") and has a button back to the list. K and J
  do the same from the keyboard when the cursor is not in a field. The arrows
  follow the list as it was shown: its filter, sort and page.
- **Assigning several tasks at once.** Tick tasks in a task list and choose
  who gets them from the bar above it: a searchable list of the project's
  members (everyone, when the tasks come from more than one project), with
  Unassigned to take them off whoever has them. Each person gets one email
  listing the tasks given to them, not one email per task.
- **Pages with thousands of tasks load, and load fast the second time.** The
  Tasks page timed out once a view held about a thousand tasks: the whole tree
  was read from the delivery system on every visit, a thousand at a time one
  after another, which took longer than the browser waits.
  - Views, the task lists behind My Work, Gantt and the pickers, the project
    list and the sprint list are now kept on the server for each person. Asked
    again, they are answered at once and refreshed in the background.
  - Any change to work drops the kept lists, so an edit always shows.
  - A first read the browser gives up on is finished anyway and kept for the
    next look.
  - The tree is read a few pages at a time, side by side.
  - The browser waits up to two minutes for a view. Its saved copy of the
    pages no longer stops saving once the browser's storage fills up.
- **Choosing a person is searchable**: Add member on a project's Team tab,
  and a team's lead or account manager.
- **Sprints show their numbers without story points.** Where a sprint's work
  has no story points, it is counted in estimated hours, or in tasks where
  there are no estimates either: committed, completed, remaining, progress and
  the burndown, with the unit shown. Story points still count wherever the work
  has any. A new column records each burndown sample's unit (one migration,
  run on start).
- **Utilisation by day, week or month, from the time logged.** Resources →
  Capacity shows everyone by day, week or calendar month, with previous and
  next to move through them, and counts the time each person logged against
  the hours they had; the current day, week or month is set against the hours
  so far. Work assigned to someone but not logged no longer makes them look
  busy. "Logged time and assigned work" counts the work and bookings still to
  come as well, as the heatmap did before, with the placeholders and roles
  booked with nobody named. A cell opens on the time logged in it. The browser
  remembers which view was chosen last.
  - By day, the heatmap opens on 7 days, this week; 14 and 31 days are a
    click away. 7 days is a calendar week, Monday to Sunday: the working week
    first and the weekend after. It used to count back from today, so on a
    Monday it began on the Tuesday before. 14 days is two such weeks: last
    week and this for logged time, this week and next with assigned work.
    Previous and next move a whole week at a time.
  - A cell's time logged shows what people wrote on each entry, under the
    task or kind of time it belongs to: the day, the hours and the
    description; on a team's or role's cell, whose. Descriptions on project
    time are read with the viewer's own access, so a manager sees those on
    the projects whose time they may view; those on time with no project
    (daily scrums, follow-ups, support) show to everyone who may open the
    heatmap, as in the timesheets.
- **An import brings the whole plan.** Tasks → Import makes what the file
  names and the project lacks as the import starts, so a plan comes in without
  setting the project up by hand first.
  - Sprints named in the Version (or Sprint) column are created, dated from the
    first start to the last due date of their tasks, so they show on the
    roadmap, the sprints and the backlog with their work. A sprint called
    Backlog is left undated.
  - A type the instance has but the project does not use, such as Epic, is
    turned on for the project, by someone who may manage its types. Otherwise
    Epic, Parent task, Subtask, Story and Deliverable are read as the nearest
    type the project has, and the check says so.
  - Epics, parent tasks and subtasks come from Parent ID and milestones from
    the Milestone type, with their dates, so the Gantt chart follows.
  - Everyone the file names who has an account can be added to the project in
    one go, with one role, so their tasks keep their assignee and accountable.
  - The template has a Spent time column, and its example puts tasks into
    sprints.

  This needs the OpenProject image rebuilt: its project add-on can now turn a
  type on for a project.
- **Utilisation tables page the same way.** On Insights, the Departments,
  Teams, Roles and People tables always show their pager (10 a page, more on
  request), and Resources → Capacity pages through people, 25 a page, with a
  team's header repeated on each page its people are on.
- **Dashboard trends by day, week or month.** Insights dashboards have a
  Trends choice beside the period: by day, by week, by month, or by the length
  of the period as before. Resource utilisation reads by the day over a month
  or less, and can be read by day over up to three months. A "Last 7 days"
  period has been added. Exports follow the choice.
- **Access roles is easier to read.** Each role is a card saying who holds it,
  with a link to them, and one table compares what every role can do,
  permission by permission, grouped by area: people, portfolios and requests,
  delivery, time, money, reports, and set-up. Point at a permission to read
  what it allows.
- **The Overview's figures follow the role.** The BU Head starts from active
  projects, project requests waiting for a decision, people and departments,
  and over-allocation; the Portfolio Manager from the portfolios and their
  projects at risk, project requests, over-allocation and late work; the
  Program Manager from programs, milestones due in the next 30 days, active
  projects and approvals; the Project Manager from active projects, late work,
  milestones and approvals; the Delivery Manager from over-allocation and last
  week's timesheets. A figure shows a placeholder while it loads, not a dash.
  Portfolio views is offered to the roles that work with portfolios: the BU
  Head, Portfolio and Program Managers, Managers and administrators.
- **Timesheets show what the hours were.** A timesheet now has the week as a
  grid of tasks against days with the totals, and every entry day by day with
  its activity and description, on the person's own timesheet and on the page
  an approver opens. My timesheets moves between periods, so last week's can be
  filled in and submitted there, with Log time beside it; a timesheet's own
  page has Submit for its owner and previous and next periods; People has a
  search; the breadcrumb names the person rather than "people › 140". People,
  Submitted timesheets and a timesheet's entries are paged (25, 10 and 20 to a
  page by default, and how many per page can be changed).
- **Moving between pages is immediate.** A page no longer waits for the one
  it leaves to animate out; it renders at once with a short fade. A project's
  tabs switch without rebuilding the project's header and tab bar. Once someone
  is signed in, every page is fetched in the background while the browser is
  idle, so opening one never waits on a download. Back and Forward return to
  where each page was scrolled, and a new page starts at the top.
- **HTTP/3** is served to browsers that can use it, when UDP 443 is open on
  the host's firewall or security group (the compose files now publish it).
  Others stay on HTTP/2.
- **The Overview has one Create button**, the header's, on every page. Its own
  Create button, which only started a task, has gone.
- **Roles follow project management practice** (PMI) for the new features.
  Managers run programs and see every project request, as a PMO and program
  managers do: the Manager role carries two new EPM permissions, Manage
  programs and Review project requests, which an administrator can also grant
  to anyone (Administration → EPM permissions). Deciding a request or a gate
  stays with the approval chain; portfolios, templates and approval chains
  stay with administrators. Whoever manages a project (its Project admin role)
  switches its life-cycle phases on and dates them, and everyone working in
  the project sees them.
- **Managers see everyone's timesheets**, read only, as a PMO follows people's
  time: what each person logged, what they submitted and who has not. A new
  EPM permission, See timesheets, comes with the Manager role and can be
  granted to anyone (Administration → EPM permissions); reopening an approved
  timesheet stays with Manage timesheets (HR and administrators). Their
  Overview's "Last week's timesheets" now fills for them too.
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

- **A project's Sprint tab shows the project's own sprints.**
  - **The problem:** it showed the first running sprint in the whole instance,
    whichever project it belonged to. A project with new sprints of its own
    kept showing another project's, with "This project has no work in the
    active sprint" beside it, and its new sprints never appeared there.
  - **Which sprint it opens on:** the project's running sprint, or the one
    started last where several overlap. If none is running, the next to start;
    if none is planned, the last to finish.
  - **The picker:** it lists all of the project's sprints by state with their
    dates, and keeps the choice in the address.
  - **New sprint** makes one in this project and shows it at once.
  - **Shared sprints:** one shared from another project appears once this
    project's work is in it.
- **Sprint figures follow the work.** Moving a card to Done, or planning a
  task into a sprint, used to leave committed, completed and remaining
  unchanged for up to two minutes. A sprint just created could also stay
  missing from the lists. There were two causes: the browser did not refresh
  sprints after a task changed, and the server answered the next look from
  its kept list. Both now refresh at once for whoever made the change.
- **The work list under a sprint names each task's project.** It said
  "Unknown project".
- **An archived project no longer counts in utilisation.** Time logged on it,
  and bookings on it, still counted in Resources → Capacity (the heatmap and
  a cell's detail), in the hours logged and utilisation on Insights for
  people, teams and departments, and in a team's "Logged this week". They now
  drop out within about half a minute of the project being archived, and come
  back if it is restored. Time logged on no project (meetings, support) still
  counts.
- **Archiving a project works on the server.** Archive (and every other
  action sent with no body: restoring, starring, archiving a team, department
  or portfolio) failed there with "Unsupported Media Type". Over HTTP/3 the browser can send
  such a request with no length, the proxy then forwards it chunked, and the
  backend refused an empty body with no type before the action ran. An empty
  body is now no body however it arrives; a real body of an unknown type is
  still refused.
- **Deleting a large project no longer reports an error.** The project was
  deleted, but a large one is still being cleared out when EPM stops waiting
  (8 seconds), and the answer for that had no body, which the page read as
  "unable to reach the backend". It now says the project is deleted and that a
  large one takes a few minutes to clear, and the project leaves every list at
  once instead of reappearing until the clear-out finishes.
- **Choosing a status on Projects keeps the other counts.** Clicking On track,
  or any status in the strip above the list, set every other status to 0; each
  now keeps its count while the list shows the projects of the one chosen.
- **Spent time in an imported sheet reaches the tasks, timesheets and
  utilisation.** It was logged only on tasks the import created, so a sheet
  imported onto tasks already here (the same export again, or tasks an earlier
  import made) logged none of it. It also went in as one entry on each task's
  finish date, which put a month's hours into one week and fell foul of the
  rules for logging time as it happens (how far back, a day's maximum, closed
  tasks). Now each task gets its own hours (an export counts a parent's
  subtasks into its figure), less what it has logged already, so importing a
  sheet again adds nothing and a sheet with more hours adds the difference;
  for its assignee, spread over its working days from its start to its finish
  and never after today. Only a submitted or approved timesheet keeps time out.
  Utilisation and the heatmap show it once the analytics model refreshes, a few
  minutes after the import.
- **Log time offers every task in the project.** The task list showed the
  hundred open tasks touched most recently, and a parent is touched whenever a
  child is, so a planned project listed its summary tasks and a few subtasks
  and the rest could not be chosen, not even by name. It now lists every task,
  each under its parent in date order with its dates, closed ones included and
  marked; a project of more than a thousand is searched as you type. The chosen
  task's start and end dates, the time already logged on it against its
  estimate, and its description show under the list.
- **A project's members log their time from Log time.** Log time checked
  the project alone before letting anyone log time there, and the delivery
  system answers that question only for those who may log time for others.
  So a Member, who may log only their own time, had Log time greyed out with
  "You cannot log time on this project" as soon as they chose a project: for
  Scrums & meetings and Support, and for work on a task too, as choosing the
  task did not ask again. The time itself would have been accepted. Scrums &
  meetings and Support are now checked against the project's own task for
  them, where the time goes, and a project alone against another of its
  tasks, which a Member logs on in the same way. The project's activities
  come with the answer, so support time is filed under Support even before
  anyone has made the project's Support task. Someone who may not log time on
  the project, such as a Reader, is still told before typing anything. Log
  time also asks again when the project, the task or the kind of time
  changes, so another project's activities and answer are never left showing.
- **Lists inside dialogs scroll with the mouse wheel.** The project and task
  lists in Log time, the task composer and every other picker in a dialog
  could only be scrolled by dragging their scrollbar.
- **Logged time reaches the timesheet, utilisation and the heatmap.** A
  timesheet still read "0h logged" after hours were logged until the page was
  reloaded; the dashboards are read again once the analytics model has the new
  time (about half a minute); and the capacity heatmap's current week adds the
  hours already logged to the work still to come, where it showed only the work
  from today on. EPM's own accounts (its service and automation accounts) are
  no longer counted as people: they had owed timesheets and added 40 hours a
  week each to the capacity utilisation divides by.
- **Email beyond invitations.** Assignment emails were sent only when
  OpenProject's webhook called EPM back, and a server without that webhook sent
  none; EPM now sends them itself whenever it creates, edits or reassigns a task
  (the webhook still covers changes made elsewhere, and the two never both
  send). In-app notices (health turning red, approvals, a rule's message) now
  reach the morning digest under the Daily digest switch; they waited on
  "Updates to my work", which was off for everyone, as was the reply to an
  approval request. "Updates to my work" is on for people who never saved their
  Settings. Deadline reminders are on in a deployment unless set off.
- Timesheets → People shows the time logged this week. It opened on last
  week's outstanding list, so time someone had just logged appeared nowhere
  until the reader moved forward a period and chose Everyone; it now opens on
  the current period and everyone in it, with last week a click back.
- The Gantt page shows a chart again. It opened on the newest project, often
  one with nothing on it yet, and the timeline opened on today while its rows
  began with the oldest work, so even a full plan showed rows with no bars. It
  now opens on a project with work to draw (favourites first), or the one
  looked at last, which the address keeps; it opens on the rows around today
  and scrolls to the bars of whichever page is shown. A project's Gantt tab
  does the same, zooming keeps the page, and switching project shows the
  loading state instead of the last project's timeline.
- A board's New board button shows only to people the project lets manage
  boards, not to everyone who can edit its tasks (who were then refused).
- Saved views no longer lists a board's columns or a dashboard's widgets as
  views of their own ("New", "In progress", "Wish list" and the like).
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
- Back on Delivery → Agile leaves the page. The page put its default sprint
  into the address as a new history entry, so Back returned to it and it was
  put there again.
- A page that fails no longer keeps its error on screen over every page opened
  after it: the error clears on moving to another page.
- After a deploy, a tab still open on the previous build reloads once to pick
  up the new one, instead of showing "This page could not be displayed" for
  the next page it opens.
- The create-task panel closes when the page changes, Back included, instead
  of staying open over a page it was not opened from.

### Security

- **Sessions end after 30 minutes without activity, and 12 hours after signing
  in.** A session used to last thirty days. Any request kept it going, an open
  tab's own refreshes included, so a browser left signed in stayed signed in
  for a month, and the person never came back through the sign-in page that
  their "Last login" counts.
  - **What counts as activity:** a click, a key, scrolling or moving the mouse
    in any of the app's tabs, and any save. The page refreshing itself does
    not count.
  - **The reminder:** after 15 minutes without activity, "Are you still
    there?" counts down to the sign-out, with Stay signed in and Sign out.
  - **Shortly before the 12-hour limit:** a notice asks people to save their
    work.
  - **The sign-in page:** it says why the person was signed out, and signing in
    again returns them to the page they were on.
  - **Other tabs:** activity in one tab keeps the others signed in, and
    signing out in one signs out the rest.
  - **The server enforces both limits** whatever the page does. Its refusal
    says which limit ended the session.
  - **The session cookie** now ends when the browser closes.
  - **Settings:** `EPM_SESSION_IDLE_MINUTES`, `EPM_SESSION_WARN_MINUTES` and
    `EPM_SESSION_MAX_HOURS` (30, 15 and 12 when left empty).
- **Nothing of a person's work is kept in the browser.**
  - The app kept a day of its answers in the browser's storage (projects,
    tasks, people) and restored them on the next visit. They now stay in the
    open tab's memory only, and an earlier build's copy is deleted on the
    first visit.
  - Signing out also tells the browser to clear its cache for the app.
  - Only display choices stay in the browser: language, appearance, sidebar
    and list toggles.
  - A page opened afresh now waits for its data, and the server's kept copies
    keep that wait short.
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
- **Strict browser caching** (OWASP session management). Back after signing
  out, or after a session ends, no longer shows signed-in pages. The app's page
  is served `no-store`, so the browser keeps no copy of it in its cache or its
  back/forward cache. Every API response is `no-store` unless it sets its own
  (avatars, feeds). Signing out and an ended session replace the current
  history entry instead of adding to it. A page the browser restores from its
  back/forward cache anyway is reloaded, so the session is checked again. The
  app's own files (`/assets`) stay cached, as before.

### Deploying 1.2.0

A server still older than 1.1.0 needs 1.1.0's changes first: OpenProject
17.9.2 on its own database, and API keys issued again (`deploy/runbooks/upgrades.md`).

1. **Back up**, as the runbook says.
2. **Deploy all three images from the 1.2.0 tag together.** This release
   changes the OpenProject add-ons the backend calls (the service account's
   allow-list, the password and document actions, and the custom field and time
   zone lists), so a new backend beside an old `epm-openproject` cannot accept
   invitations, send reset links, open project documents or put a custom field
   on a type. A new add-on also carries a project's modules, attributes,
   template flag, life cycle and copies, so without it a project's Settings
   tab and starting from a template fail. The backend applies fourteen database
   migrations as it starts; nothing else needs running. The last six add the
   risk register's table and the client fields on teams (every existing team
   stays an internal one), then meeting series, agenda items, reserved
   identifiers and status reports, then programs, then the backlog's order,
   then project requests and gate reviews, then internal comments and feed
   tokens. All of them only add.
   Project requests and stage gates are decided by approval chains of their
   own: until an administrator adds one for each (Administration → Work
   packages → Approval chains), submitting either says so. Feed addresses are
   built from `APP_BASE_URL`, so it must be the address people use.
   **Before the images go up, add a column OpenProject's job queue expects.**
   An instance upgraded from OpenProject 15 lacks it, and every project copy
   then fails, although the copy carries on and makes the project. The
   statement does nothing where the column exists:
   `docker compose -f docker-compose.prod.yml exec -T openproject-db psql -U openproject -d openproject -c "ALTER TABLE good_job_batches ADD COLUMN IF NOT EXISTS jobs_finished_at timestamp(6) with time zone;"`
   The risk register keeps risks as work items of the Risk type, and a sprint's
   impediments are the new Impediment type. **Run the governance types set-up
   on every server**, including one that ran it before (`DEPLOY.md`, "Approvals
   need the governance types"): it adds the Impediment type, gives the project
   roles the life-cycle rights OpenProject 17 brought (managing roles run the
   phases, working roles see them), and it is written again for OpenProject 17,
   on which the earlier version failed. It only adds.
3. **Switch to the service account**, if the server still uses an
   administrator's key. Create it and read its key as `DEPLOY.md` describes
   ("After the very first `up`", step 1). Set `OPENPROJECT_API_KEY` in
   `.env.prod` to that key, run `up -d` again, then revoke the
   administrator's key.
4. **Email.** Invitations and password resets need real delivery: SMTP or
   Resend in `.env.prod` (`DEPLOY.md`, "Email"). Without it, the
   forgot-password page tells people reset by email is not set up on this
   server. **Set `EPM_DUE_REMINDER_ENABLED=true` in `.env.prod`** where it says
   `false` (the old template's value): unset now means on, but an explicit
   `false` still turns deadline reminders off.
   The first start makes the "Work category" custom field for task categories,
   through the catalogue and calculated-fields add-ons in this release's
   `epm-openproject` image; the backend log says "Task category field created".
   Nothing to run.
   The backend applies two more migrations on start, both additive: anyone who
   held the retired HR role becomes a Delivery Manager, and a table keeps time
   on no project. The backend image now carries a small Java runtime, MPXJ and
   Aspose.Tasks for Java (about 110 MB) to read and write Microsoft Project
   files; building it fetches `eclipse-temurin`, MPXJ's release from GitHub and
   Aspose.Tasks from Aspose's Maven repository, each checked against its
   SHA-256. Without them (an image built from an older Dockerfile), .mpp
   uploads are refused with how to save the plan as XML, which still imports.
   **To export .mpp, set `EPM_ASPOSE_TASKS_LICENSE`** in `.env.prod` to the
   Aspose.Tasks for Java licence file, on one line: `base64 -w0
   Aspose.Tasks.Java.lic`. Aspose sells the licence; its free 30-day temporary
   licence works for trying it. Without one, Export offers Microsoft Project XML
   (Aspose.Tasks refuses to write .mpp unlicensed). Importing .mpp needs no
   licence.
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
   - a document filed under a project opens for another member;
   - a project's Settings tab opens, and a project started from a template
     opens with the template's tasks (delete it afterwards).

   Then ask for the UI test cases that failed on 27 October to be run again.
7. **Before going live**, clear what testing left behind (`DEPLOY.md`,
   "Clearing test data").
   The expense-approval cases also need a second account set as the tester's
   line manager.
8. **Sessions.** One migration adds each session's last activity
   (`20261122090000_session_last_active`, additive, applied on start).
   - Everyone signed in more than 12 hours before the deploy signs in again.
   - Anyone else is signed out after 30 minutes without activity, counted from
     the deploy.
   - The limits need nothing set. To change them, set `EPM_SESSION_IDLE_MINUTES`,
     `EPM_SESSION_WARN_MINUTES` and `EPM_SESSION_MAX_HOURS` in `.env.prod`; both
     compose files pass them through.
