Pilot scope
Use one single-tenant PocketBase instance and one Lattice-maintained module. The pilot requires an internet connection.
Dataset	Required fields	Purpose
Customers	Name; optional phone	Find and identify a customer
Jobs	Title, customer relation, status, assignee relation	Track work for that customer


Start with three statuses: Open, In progress, and Done. Owners and admins can view and assign all jobs. Members can view and update their assigned jobs. For the first pilot, give participating members read access to all customers so they can identify the customer linked to a job; confirm that this is acceptable with the pilot business.
Step-by-step plan
1. Write the acceptance scenario
Describe the exact actions and expected results before adding module code:
1. The operator starts a fresh instance and provides the setup secret.
2. The owner creates the workspace and enables Customer and Job Tracking.
3. The owner creates a customer and invites two members.
4. The owner creates one job for each member.
5. Each member signs in on a phone, finds their own job, and changes its status.
6. A member cannot retrieve or modify the other member’s job through either the UI or direct API.
7. The owner sees both updates on the web.
Done when: this scenario is agreed as the release test, including expected behavior for validation errors and lost connectivity.
2. Define the managed module contract
Create a versioned definition for the module containing:
- Module ID, name, version, and supported platforms.
- Required datasets, fields, types, relations, and status values.
- Screens and actions: customer list, job list, job detail, create, assign, and change status.
- Required permissions and the effect of disabling the module.
Keep the contract separate from a specific workspace’s dataset names. It should describe roles such as “customer name” and “job assignee,” which can later be mapped to actual fields.

Done when: the backend and client can validate one example module definition, including an incompatible version or missing requirement.
3. Store module installation state on the server
Add workspace-level state for the module: enabled status, module version, and dataset/field mappings. Expose authenticated read operations and owner/admin-only configuration operations.

Define disabling as turning off the module’s screens and actions while retaining its datasets and records. Collection access remains governed by dataset permissions; disabling a module should not be described as revoking data access unless that is separately implemented.

Done when: an owner disables or enables the module on the web and a second web session and mobile client observe the same state after refresh or synchronization.
4. Build the owner’s setup flow
Add a module setup screen with two paths:
- Create suggested datasets: create Customers and Jobs with the pilot fields.
- Map existing datasets: choose existing compatible fields for customer name, job title, customer relation, status, and assignee.
Before enabling, show what will be created or mapped, required team permissions, and any incompatibilities. Validate types and relation targets on the server. Make setup retryable and report whether anything was created if a step fails.

Done when: an owner can configure the module without opening PocketBase administration, writing code, or entering raw JSON. Repeating setup does not create duplicate datasets.
5. Complete team access and onboarding
Use the existing team flow to invite members and assign:
- Customer: read, all.
- Job: read/create/update, assigned, with delete disabled by default.
For this pilot, a member creating a job is automatically assigned to it. Owners and admins can assign jobs to other members. Show the effective access in the setup flow and do not silently grant it.

Done when: two members can accept invitations and the server enforces the matrix for direct record requests, relation expansion, and realtime updates. Revocation and disabling take effect for existing sessions.
6. Deliver the phone workflow
Build or adapt the shared UI for:
- A searchable customer list and customer details.
- A job list showing title, customer, status, and assignee.
- Job creation and status updates using the module’s mapped fields.
- Loading, empty, permission-denied, validation, and connection-error states.
Keep the first release online-only. Test on a real phone or representative device, including a narrow screen and a slow connection.

Done when: a member can complete the acceptance scenario without typing a record ID or needing the owner’s help.
7. Add end-to-end and recovery tests
Exercise the real API and client, rather than only calling service helpers:
- Fresh setup → module configuration → invite → accept → create/update job.
- Two members and two jobs: confirm assigned-only access and revocation.
- Existing compatible mapping and rejected incompatible mapping.
- Failed setup followed by retry; no duplicate or orphaned module resources.
- Disable and re-enable: state is shared across clients and records remain intact.
- Add an optional dataset field and confirm the updated form is available after navigation and on another client.
Done when: these checks pass against a running PocketBase instance, alongside the existing backend and UI suites.