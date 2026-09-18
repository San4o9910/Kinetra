import type {
  MyTraining,
  TrainingLibrary,
  TrainingPlanInput,
  TrainingStudent,
  TrainingStudentDetail,
} from '@kinetra/shared';
import { trainingRequest } from '../../lib/api';
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
export const trainingApi = {
  students: (signal?: AbortSignal) =>
    trainingRequest<{ students: TrainingStudent[] }>('/students', { signal: signal ?? null }),
  student: (id: string, signal?: AbortSignal) =>
    trainingRequest<TrainingStudentDetail>(`/students/${id}`, { signal: signal ?? null }),
  addStudent: (name: string, contact: string) =>
    trainingRequest<{ id: string; token: string }>('/students', json('POST', { name, contact })),
  invite: (id: string) =>
    trainingRequest<{ token: string }>(`/students/${id}/invite`, json('POST')),
  archive: (id: string) => trainingRequest(`/students/${id}/archive`, json('POST')),
  createPlan: (id: string) =>
    trainingRequest<{ id: string }>(`/students/${id}/plans`, json('POST')),
  savePlan: (id: string, input: TrainingPlanInput) =>
    trainingRequest<{ revision: number }>(`/plans/${id}`, json('PUT', input)),
  publish: (id: string, revision: number) =>
    trainingRequest(`/plans/${id}/publish`, json('POST', { revision })),
  mine: (signal?: AbortSignal) => trainingRequest<MyTraining>('/mine', { signal: signal ?? null }),
  invitation: (token: string) =>
    trainingRequest<{ trainer_name: string }>('/invitation', json('POST', { token })),
  accept: (token: string) => trainingRequest('/invitation/accept', json('POST', { token })),
  log: (
    id: string,
    input: {
      completed?: true;
      position_seconds?: number;
      difficulty?: number;
      wellbeing?: number;
      note?: string;
    },
  ) => trainingRequest(`/workouts/${id}/log`, json('PUT', input)),
  library: (signal?: AbortSignal) =>
    trainingRequest<TrainingLibrary>('/lessons', { signal: signal ?? null }),
  createLesson: (title: string, description: string, size_bytes: number) =>
    trainingRequest<{ id: string }>('/lessons', json('POST', { title, description, size_bytes })),
  upload: (id: string, file: File, signal: AbortSignal) =>
    trainingRequest(`/lessons/${id}/file`, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': 'video/mp4' },
      signal,
    }),
  removeLesson: (id: string) => trainingRequest(`/lessons/${id}`, json('DELETE')),
  access: (id: string, signal?: AbortSignal) =>
    trainingRequest<{ path: string }>(`/lessons/${id}/access`, { signal: signal ?? null }),
};
export const trainingMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Не удалось сохранить изменения. Повторите попытку.';
const inviteKey = 'kinetra-training-invite';
export const pendingInvite = (): string => {
  try {
    return sessionStorage.getItem(inviteKey) ?? '';
  } catch {
    return '';
  }
};
export const clearInvite = (): void => {
  try {
    sessionStorage.removeItem(inviteKey);
  } catch {
    /* Storage may be unavailable. */
  }
};
export const captureInvite = (): void => {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('invite');
  if (token && /^[A-Za-z0-9_-]{43}$/u.test(token)) {
    try {
      sessionStorage.setItem(inviteKey, token);
    } catch {
      /* The form also accepts the invitation link. */
    }
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    );
  }
};
export const inviteLink = (token: string): string =>
  `${window.location.origin}/login#invite=${token}`;
