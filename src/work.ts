import type { Question } from './questions.js';
import type { Message, Participant, Store } from './store.js';
import type { Task } from './tasks.js';
import { byWorkOrder, type TicketSummary } from './tickets.js';

const DESCRIPTION_PREVIEW = 400;
const MAX_MENTIONS = 20;

export interface WorkTicket extends TicketSummary {
  description: string;
  handoff: string | null;
  openCriteria: string[];
}

export interface MyWork {
  next: string[];
  questionsForYou: Question[];
  tasks: Task[];
  tickets: WorkTicket[];
  mentions: Message[];
}

/**
 * Everything waiting on a participant in one read: questions to answer, open tasks, assigned
 * tickets with their handoff notes and open criteria, and unseen mentions (left unseen), plus a
 * short suggested order to work through them.
 */
export function myWork(store: Store, me: Participant): MyWork {
  const questionsForYou = store.questions.waitingOn(me);
  const tasks = store.tasks.list(me, { assignedToMe: true, open: true, limit: 50 }).reverse();
  const tickets = store.tickets
    .list(me, { assignee: me.name, open: true, limit: 50 })
    .sort(byWorkOrder)
    .map((summary) => {
      const full = store.tickets.get(me, summary.ref);
      const description = full.description.length > DESCRIPTION_PREVIEW ? `${full.description.slice(0, DESCRIPTION_PREVIEW)}…` : full.description;
      return {
        ...summary,
        description,
        handoff: full.handoff?.text ?? null,
        openCriteria: full.criteriaItems.filter((c) => !c.done).map((c) => `${c.id}: ${c.text}`),
      };
    });
  const mentions = store.unseenMentions(me).slice(-MAX_MENTIONS);

  const next: string[] = [];
  for (const q of questionsForYou) next.push(`Answer question ${q.id} from ${q.asker} on task #${q.taskId}.`);
  for (const t of tasks.filter((t) => t.state === 'accepted' && t.question?.state === 'answered')) {
    next.push(`Continue task #${t.id}: ${t.question!.answeredBy} answered your question.`);
  }
  for (const t of tasks.filter((t) => t.state === 'requested')) next.push(`Accept or decline task #${t.id} from ${t.chain.join(' → ')}.`);
  for (const t of tasks.filter((t) => t.state === 'accepted' && t.question?.state !== 'answered')) next.push(`Finish task #${t.id}.`);
  const ready = tickets.filter((t) => t.blockedBy.length === 0 && !t.task);
  for (const t of ready.slice(0, 3)) next.push(`${t.status.category === 'started' ? 'Continue' : 'Start'} ${t.ref} (${t.priority}): ${t.title}.`);
  const waiting = tasks.filter((t) => t.state === 'needs_input').length;
  if (waiting) next.push(`${waiting} of your tasks ${waiting === 1 ? 'is' : 'are'} waiting on an answer; nothing to do there until it comes.`);
  if (next.length === 0 && mentions.length === 0) next.push('Nothing is waiting on you. Use wait_for_mentions to wait for work.');

  return { next: next.slice(0, 8), questionsForYou, tasks, tickets, mentions };
}
