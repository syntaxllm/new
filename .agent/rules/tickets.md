---
trigger: always_on
---

# Personal Workflow Agent

## Purpose
This workflow file tracks my tasks, generates task tickets, maintains checklists, and shows dependencies for the team. It helps me quickly summarize what I've done and what I'm working on.

---

## Daily Workflow Instructions

1. **Log Current Status**
   - List all tasks you worked on yesterday.
   - Highlight completed tasks.
   - Note blockers or pending items.

2. **Generate task Tickets**
   - Use this section to summarize new tickets.
   - Include: Title, Description, Priority, Assignee, Due Date.
   - Example:
     ```
     [JIRA-TICKET-ID] Implement MCP Auth Module
     Description: Add login/logout endpoints for MCP client auth
     Priority: High
     Dependencies: Database schema setup, Frontend login page
     Assignee: @Pranav Patil
     Due: 2026-02-07
     ```

3. **Update Checklist**
   - Use the `tasks_template.md` file to mark progress.
   - Example:
     ```
     - [x] Review MCP repo structure
     - [ ] Implement Auth endpoints
     - [ ] Write integration tests
     ```

4. **Track Dependencies**
   - List dependent tasks or blockers.
   - Example:
     ```
     Auth Module cannot be completed until:
       - Database schema migration is done
       - Frontend login UI is ready
     ```

5. **Summary for Team**
   - Copy this final summary into the management app.
   - Include:
     - Completed tasks
     - Current work
     - tickets created
     - Pending dependencies

---

## Tips
- Always fill `tasks_template.md` before updating workflow.md
- Keep ticket info consistent in `track.md`
- Update dependencies as soon as blockers appear
Ticket Template

- **Title:** [Short description of task]
- **Description:** [Detailed explanation]
- **Priority:** [High / Medium / Low]
- **Assignee:** [Your name or teammate]
- **Dependencies:** [Other tasks / tickets]
- **Due Date:** [YYYY-MM-DD]


also u can give the checklist , to do items in tasks or etc