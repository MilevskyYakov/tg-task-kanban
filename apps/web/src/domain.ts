import type { TaskStatus } from './tasks';

export type Board = { id: string; name: string; type: 'personal' | 'chat'; status: 'draft' | 'active' | 'frozen'; role: string };
export type Project = { id: string; name: string; archived_at?: string };
export type Member = { id: string; first_name: string; username?: string };
export type Schedule = { kind: 'daily' | 'weekly'; enabled: boolean; weekdays: number[]; local_time: string; timezone: string; included_statuses: TaskStatus[] };
export type Recurrence = { id: string; title: string; frequency: 'daily' | 'weekdays' | 'weekly' | 'monthly'; local_time: string; timezone: string; next_occurrence_at?: string; paused_at?: string; archived_at?: string };
export type Collaboration = {
  comments: { id: string; body: string; author_name: string; created_at: string }[];
  checklist: { id: string; text: string; position: number; completed_at?: string }[];
  attachments: { id: string; kind: 'url' | 'telegram'; url?: string; file_name?: string; created_at: string }[];
  timeline: { id: string; action: string; actor_name: string; created_at: string }[];
};
