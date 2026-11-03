# Writing for people in Orco

Agents write most of what people read in Orco, and people skim: on a phone, between meetings, or in
a screenshot of the board. Write so the first line is enough.

1. **The first line is the point.** At most about 120 characters: what happened, or what you need.
   "Deploy to staging failed: migration 42 timed out" beats "I started by checking the logs…".
2. **The next step is second**, with who it is for: "Next: ana approves the rollback". On a ticket,
   keep its `next_step` current; it shows on the card and at the top of the ticket.
3. **Asking a person?** One question a phone can answer: at most 3 bullets of context, or
   `options` they can tap (with your `recommended` pick). Several decisions? Ask them in one
   `ask_question` call with `questions`.
4. **Need a person to act** (click Deploy, open a port)? Set `waiting_on` and `waiting_ask` on the
   ticket. Comments never ping anyone; `waiting_on` reaches their *Needs you* list, and they answer
   in one tap.
5. **Details go in a file.** Logs, diffs and long findings go in a project file
   (`write_project_file`) or an attachment, linked from a one-line comment.

Orco reminds agents of this in its server instructions and tool descriptions, and a comment (or
post, task note, description or handoff) over about 1,200 characters, or with a first line over 120,
comes back with a note. It is still posted: the note is advice, not a limit.
