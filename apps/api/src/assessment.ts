export type Assessment = { importance: boolean | null; urgency: boolean | null };
export type AssessmentInput = Partial<Assessment> & { priority?: 'normal' | 'urgent'; expectedVersion?: string };
export class AssessmentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// Resolve legacy echoes only after locking the current row and checking its revision.
export function assessment(input: AssessmentInput, current?: Assessment) {
  for (const key of ['importance', 'urgency'] as const) {
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'boolean') throw new AssessmentError(`invalid ${key}`);
  }
  const importance = input.importance === undefined ? current?.importance ?? null : input.importance;
  let urgency = input.urgency === undefined ? current?.urgency ?? null : input.urgency;
  const canonical = input.importance !== undefined || input.urgency !== undefined;
  if (input.priority !== undefined) {
    if (canonical) {
      if (input.priority !== (urgency === true ? 'urgent' : 'normal')) throw new AssessmentError('priority contradicts assessment');
    } else if (input.priority === 'urgent') urgency = true;
    else if (current?.urgency === true) urgency = false;
  }
  if (current && input.expectedVersion === undefined && (importance !== current.importance || urgency !== current.urgency)) {
    throw new AssessmentError('assessment requires expectedVersion; read the current version first', 409);
  }
  return { importance, urgency, priority: urgency === true ? 'urgent' : 'normal' };
}
