# Notion Context Hub template

This blueprint creates one durable workspace hub and one Project page per
linked channel. Databases are global; the Project template contains filtered
views. This keeps the schema stable for automation without cloning six
databases for every channel.

## 1. Projects

Create a full-page database named `Projects` with the adapter-owned properties
listed in the package README. Add these human-owned properties as useful:

| Property | Type | Notes |
|---|---|---|
| `Status` | Status | Suggested: Planning, Active, At risk, Blocked, Done |
| `Principals` | Relation to People/Roles | People accountable for the project |
| `Start` | Date | Optional project start |
| `Target` | Date | Optional target date |
| `Last material update` | Date | Human-facing freshness indicator |

Copy the Projects data source ID for `projectsDataSourceId`. In the multi-source
Notion API this is not necessarily the ID of the containing database object.

## 2. Related data sources

Create each database once and add a required `Project` relation back to
Projects.

### Decisions

| Property | Type |
|---|---|
| `Decision` | Title |
| `Project` | Relation to Projects |
| `Status` | Select (Proposed, Decided, Superseded) |
| `Decided at` | Date |
| `Deciders` | Relation to People/Roles |
| `Rationale` | Rich text |
| `Source` | URL |

### People/Roles

| Property | Type |
|---|---|
| `Name` | Title |
| `Projects` | Relation to Projects |
| `Role` | Rich text |
| `Slack user ID` | Rich text |
| `Email` | Email |
| `Profile` | URL |

### Sources

| Property | Type |
|---|---|
| `Title` | Title |
| `Project` | Relation to Projects |
| `Type` | Select (Slack, Doc, Issue, PR, Design, Other) |
| `URL` | URL |
| `Description` | Rich text |
| `Shared at` | Date |
| `Shared by` | Relation to People/Roles |

### Meetings

| Property | Type |
|---|---|
| `Meeting` | Title |
| `Project` | Relation to Projects |
| `Starts at` | Date |
| `Attendees` | Relation to People/Roles |
| `Calendar URL` | URL |
| `Notes` | URL |
| `Status` | Select (Upcoming, Complete, Cancelled) |

### Updates

| Property | Type |
|---|---|
| `Update` | Title |
| `Project` | Relation to Projects |
| `Published at` | Date |
| `Author` | Relation to People/Roles |
| `Summary` | Rich text |
| `Source` | URL |

Milestones can be another global database if the team needs structured
tracking. For a Linear-backed future provider, keep Linear as the task system
of record and expose only project-level milestones in this hub.

## 3. Project database template

Inside Projects, create a database template named `Linked channel project`.
Its page body should contain:

1. A callout explaining that `Eve Link ID`, channel identity, `Eve context`,
   and `Eve last synced` are automation-owned.
2. A project brief section for goals, non-goals, current status, and risks.
3. A linked Decisions view filtered to `Project contains This page`.
4. A linked People/Roles view filtered to `Projects contains This page`.
5. A linked Sources view filtered to `Project contains This page`.
6. A linked Meetings view filtered to `Project contains This page`, sorted by
   `Starts at` ascending.
7. A linked Updates view filtered to `Project contains This page`, sorted by
   `Published at` descending.
8. An open questions and next steps section.

Copy the template page ID for `projectTemplateId`. Keep the template in the
same workspace and preferably in the same Projects data source. Share the
Projects database and template with the Notion connection.

## 4. Operational rules

- Do not manually duplicate `Eve Link ID`; the adapter treats it as unique and
  refuses ambiguous query results.
- Do not put Notion tokens or private credentials in any database property.
- Humans may edit `Summary` and `Status`. A plain Summary can be refreshed into
  a minimal context card when no machine card exists.
- The curator writes `Eve context` as structured JSON. Prefer `save_context`
  over hand-editing it.
- Archiving or deleting a Slack channel does not delete its Project page.
  Retention is an explicit administrative decision.
- If the schema changes, update the template first, then the property mapping
  supplied to `notionProjectProvider`.
