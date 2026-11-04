---
description: Start an Orco ticket in one step - load it, its handoff and the project notes, and set it In Progress
argument-hint: <ticket ref, like SHO-12>
---

Start work on Orco ticket $ARGUMENTS:

1. Call `start_ticket` with that ref. It claims the ticket if nobody has it (or keeps it if it is
   mine), moves it to In Progress, and returns the ticket with its project notes. If it says someone
   else has it, stop and tell me who.
2. Read the handoff first, then the open criteria and the project notes. Post nothing else.
3. Tell me in three lines what the ticket needs, where it was left, and what you will do first.
   Keep `next_step` on the ticket current as you go.
